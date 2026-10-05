/**
 * Payment tools: connect the wallet, ask Link for a one-time card, pick the card up once it is
 * approved, list past requests. Every tool carries the `purchase` capability so the policy
 * engine applies the owner's spend limits and tier rules before anything runs.
 *
 * Card data appears exactly once, in the payment_status result that first sees an approved
 * request. It is never written to payments.json, the audit log or a message.
 */
import { Type } from "typebox";
import type { AuditLog, InstinctConfig, Outbox, Principal, RegisteredTool, StateDir, ToolContext, ToolResultLike } from "@open-instinct/core";
import { defineTool, errorResult, textResult } from "./define.js";
import type { Card, PaymentMethod, SpendRequest } from "./link-types.js";
import type { LinkWallet } from "./wallet.js";

export const PAYMENTS_FILE = "payments.json";
/** Link rejects spend requests whose context is shorter than this. */
export const MIN_CONTEXT_CHARS = 100;
/** Link approval links stop working after this long. */
export const APPROVAL_WINDOW_MINUTES = 10;
const LIST_LIMIT = 20;
const MAX_AMOUNT_USD = 100_000;

export interface PaymentsToolDeps {
  wallet: LinkWallet;
  outbox: Outbox;
  config: InstinctConfig;
  audit: Pick<AuditLog, "append">;
  state: Pick<StateDir, "readJson" | "writeJson">;
  now?: () => Date;
}

/** One row in payments.json. Never holds card data. */
export interface PaymentRecord {
  spendRequestId: string;
  amountUsd: number;
  merchantName: string;
  merchantUrl?: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  requestedBy: string;
  conversationKey: string;
  cardDelivered: boolean;
  deliveredAt?: string;
  /** Set once the request's hold on the daily total was released (denied, expired, failed). */
  released?: boolean;
}

export interface PaymentsState {
  version: 1;
  requests: PaymentRecord[];
}

export function paymentsTools(deps: PaymentsToolDeps): RegisteredTool[] {
  return [connectTool(deps), requestTool(deps), statusTool(deps), listTool(deps)];
}

// ---------------------------------------------------------------------------
// payment_connect
// ---------------------------------------------------------------------------

function connectTool(deps: PaymentsToolDeps): RegisteredTool {
  const { wallet, config } = deps;
  return defineTool({
    name: "payment_connect",
    label: "Connect Link wallet",
    description:
      "Start connecting the owner's Stripe Link wallet so the agent can request one-time cards. Sends the owner a sign-in link by iMessage. Owner only.",
    parameters: Type.Object({}),
    // Connecting spends nothing; the amount keeps the owner's spend check from asking for one.
    meta: { capabilities: ["purchase"], group: "apps", recordsOwnSpend: true, amountUsd: () => 0, describe: () => "connect Link wallet" },
    execute: async (_args, ctx) => {
      if (!isOwner(ctx.principal)) return errorResult("Only the owner can connect a wallet. Offer to tell the owner instead.");
      const already = wallet.isConnected();
      const { url } = wallet.authorizeUrl();
      const sent = await sendOwner(deps, ctx, `Connect your Link wallet to ${config.agent.name}: ${url}`, "payment_connect");
      const head = already ? "A wallet is already connected; signing in again replaces it." : "Link connect link created.";
      return textResult(
        sent
          ? `${head} Sent to ${config.owner.name} by iMessage. They sign in to Link and approve the connection; nothing to type here.`
          : `${head} The owner has no phone on file, so give them this link to open: ${url}`,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// payment_request
// ---------------------------------------------------------------------------

const RequestSchema = Type.Object({
  amountUsd: Type.Number({ description: "Total to charge in US dollars, including tax and shipping" }),
  merchantName: Type.String({ description: "Who gets paid, as shown at checkout" }),
  merchantUrl: Type.Optional(Type.String({ description: "Checkout site, https URL" })),
  context: Type.String({ description: "What is being bought and why, in plain words. The owner reads this in Link before approving." }),
  idempotencyKey: Type.Optional(Type.String({ description: "Stable key so a retried call does not create a second request" })),
});

function requestTool(deps: PaymentsToolDeps): RegisteredTool {
  const { wallet, config } = deps;
  return defineTool({
    name: "payment_request",
    label: "Request a one-time card",
    description:
      `Ask the owner's Link wallet for a one-time virtual card for one purchase. Link texts the owner an approval link that expires in ${APPROVAL_WINDOW_MINUTES} minutes. Returns the spend request id; call payment_status with it after the owner approves. Do not call this until the checkout total is known.`,
    parameters: RequestSchema,
    meta: {
      capabilities: ["purchase"],
      group: "apps",
      // No recordsOwnSpend: the runtime's spend entry for this call is the hold that keeps
      // pending requests inside the daily limit. payment_status releases it if Link says no.
      amountUsd: (a) => argNumber(a, "amountUsd"),
      describe: (a) => `pay ${argText(a, "merchantName") || "a merchant"} ${fmtUsdMaybe(argNumber(a, "amountUsd"))}`.trim(),
    },
    execute: async ({ amountUsd, merchantName, merchantUrl, context, idempotencyKey }, ctx) => {
      if (!wallet.isConnected()) return errorResult("No Link wallet is connected. The owner must run payment_connect first.");
      const cents = toCents(amountUsd);
      if (cents === undefined) return errorResult(`amountUsd must be between $0.01 and $${MAX_AMOUNT_USD.toLocaleString("en-US")}.`);
      const merchant = merchantName.trim();
      if (!merchant) return errorResult("merchantName is required.");
      if (merchantUrl !== undefined && !isHttpUrl(merchantUrl)) return errorResult("merchantUrl must be an http(s) URL.");
      if (!context.trim()) return errorResult("context is required: say what you are buying and why.");

      const now = (deps.now ?? ctx.now)();
      const fullContext = buildContext({
        agentName: config.agent.name,
        ownerName: config.owner.name,
        requester: ctx.principal.kind === "owner" ? config.owner.name : ctx.principal.displayName,
        merchantName: merchant,
        amountUsd: cents / 100,
        context,
        at: now,
      });

      const link = wallet.client();
      const method = pickPaymentMethod(await link.paymentMethods.list());
      if (!method) return errorResult("The owner's Link wallet has no payment method. Ask them to add a card in Link, then try again.");

      const created = await link.spendRequests.create({
        payment_details: method.id,
        credential_type: "card",
        amount: cents,
        currency: "usd",
        merchant_name: merchant,
        ...(merchantUrl ? { merchant_url: merchantUrl } : {}),
        context: fullContext,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
      const approval = await link.spendRequests.requestApproval(created.id);

      const record: PaymentRecord = {
        spendRequestId: created.id,
        amountUsd: cents / 100,
        merchantName: merchant,
        ...(merchantUrl ? { merchantUrl } : {}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        status: "pending_approval",
        requestedBy: ctx.principal.id,
        conversationKey: ctx.conversationKey,
        cardDelivered: false,
      };
      upsertRecord(deps.state, record);

      const who = ctx.principal.kind === "owner" ? "" : ` (asked for by ${ctx.principal.displayName})`;
      const text = `Approve ${fmtUsd(cents / 100)} to ${merchant}${who}? ${approval.approval_url} Expires in ${APPROVAL_WINDOW_MINUTES} minutes. Ignore this if you did not ask for it.`;
      const sent = await sendOwner(deps, ctx, text, "payment_request");

      const lines = [
        `Spend request ${created.id} created: ${fmtUsd(cents / 100)} to ${merchant}, waiting for approval.`,
        sent
          ? `${config.owner.name} has the Link approval link by iMessage. Only they can approve, within ${APPROVAL_WINDOW_MINUTES} minutes.`
          : `The owner has no phone on file. Give them this approval link: ${approval.approval_url} (expires in ${APPROVAL_WINDOW_MINUTES} minutes).`,
        `Tell the requester you are waiting, then end your turn. When the owner says they approved, call payment_status with spendRequestId ${created.id}.`,
      ];
      return textResult(lines.join("\n"));
    },
  });
}

// ---------------------------------------------------------------------------
// payment_status
// ---------------------------------------------------------------------------

function statusTool(deps: PaymentsToolDeps): RegisteredTool {
  const { wallet, audit } = deps;
  return defineTool({
    name: "payment_status",
    label: "Check a payment request",
    description:
      "Check a spend request made with payment_request. When the owner has approved it, this returns the one-time card details a single time so you can type them into the checkout. Other statuses return a short status line.",
    parameters: Type.Object({ spendRequestId: Type.String() }),
    // The amount was checked when the request was created; picking up the card adds no new spend.
    meta: { capabilities: ["purchase"], group: "apps", recordsOwnSpend: true, amountUsd: () => 0, describe: (a) => `payment status ${argText(a, "spendRequestId")}` },
    execute: async ({ spendRequestId }, ctx) => {
      const record = findRecord(deps.state, spendRequestId);
      if (!record) return errorResult(`Unknown spend request ${spendRequestId}. Only requests made with payment_request can be checked.`);

      const link = wallet.client();
      // Ask for the card only when it has not been handed over yet.
      const request = await link.spendRequests.retrieve(spendRequestId, record.cardDelivered ? undefined : { include: ["card"] });
      if (!request) return errorResult(`Link has no spend request ${spendRequestId}.`);

      const now = (deps.now ?? ctx.now)();
      record.status = request.status;
      record.updatedAt = now.toISOString();

      if (request.status === "approved" && record.cardDelivered) {
        upsertRecord(deps.state, record);
        return textResult(`Spend request ${spendRequestId} is approved. The card was already delivered once and will not be shown again. If the checkout failed, make a new payment_request.`);
      }

      if (request.status === "approved" && request.card) {
        record.cardDelivered = true;
        record.deliveredAt = now.toISOString();
        upsertRecord(deps.state, record);
        // A record of the delivery, not a second amount: the request was counted when it was made.
        audit.append({
          kind: "spend",
          conversationKey: ctx.conversationKey,
          principal: ctx.principal.id,
          detail: { spendRequestId, deliveredUsd: record.amountUsd, merchantName: record.merchantName, currency: request.currency ?? "usd", via: "link_agent_wallet" },
        });
        return cardResult(record, request.card, request);
      }

      if (RELEASED_STATUSES.has(request.status) && !record.cardDelivered && !record.released) {
        record.released = true;
        // The hold only sits in the daily total of the day the request was made.
        const tz = deps.config.owner.timezone;
        if (localDay(new Date(record.createdAt), tz) === localDay(now, tz)) {
          audit.append({
            kind: "spend",
            conversationKey: ctx.conversationKey,
            principal: ctx.principal.id,
            detail: { spendRequestId, amountUsd: -record.amountUsd, merchantName: record.merchantName, released: request.status, via: "link_agent_wallet" },
          });
        }
      }

      upsertRecord(deps.state, record);
      return textResult(describeStatus(request, record));
    },
  });
}

// ---------------------------------------------------------------------------
// payment_list
// ---------------------------------------------------------------------------

function listTool(deps: PaymentsToolDeps): RegisteredTool {
  return defineTool({
    name: "payment_list",
    label: "List payment requests",
    description: "Recent spend requests made through the Link wallet, newest first, without card data. Owner only.",
    parameters: Type.Object({}),
    meta: { capabilities: ["purchase"], group: "apps", recordsOwnSpend: true, amountUsd: () => 0, describe: () => "list payment requests" },
    execute: async (_args, ctx) => {
      if (!isOwner(ctx.principal)) return errorResult("Only the owner can list payments.");
      const rows = readPayments(deps.state).requests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, LIST_LIMIT);
      if (rows.length === 0) return textResult("No payment requests yet.");
      const lines = rows.map(
        (r) => `${r.createdAt} ${r.spendRequestId} ${fmtUsd(r.amountUsd)} ${r.merchantName} ${r.status}${r.cardDelivered ? " (card delivered)" : ""}${r.requestedBy !== "owner" ? ` requested by ${r.requestedBy}` : ""}`,
      );
      return textResult(lines.join("\n"));
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ContextParts {
  agentName: string;
  ownerName: string;
  requester: string;
  merchantName: string;
  amountUsd: number;
  context: string;
  at: Date;
}

/**
 * Link shows `context` to the owner on the approval screen and requires at least 100
 * characters. Lead with what is being bought and why, then who asked and when.
 */
export function buildContext(p: ContextParts): string {
  const reason = p.context.trim().replace(/\s+/g, " ");
  const parts = [
    `${p.agentName}, ${p.ownerName}'s agent, is buying from ${p.merchantName} for ${fmtUsd(p.amountUsd)}.`,
    `Reason: ${reason.endsWith(".") ? reason : `${reason}.`}`,
    `Requested by ${p.requester} over iMessage at ${p.at.toISOString()}.`,
  ];
  let text = parts.join(" ");
  if (text.length < MIN_CONTEXT_CHARS) text += " The owner approves this exact amount in Link before a one-time card is issued.";
  if (text.length < MIN_CONTEXT_CHARS) throw new Error("payment context is too short for Link");
  return text;
}

export function pickPaymentMethod(methods: PaymentMethod[]): PaymentMethod | undefined {
  return methods.find((m) => m.is_default) ?? methods[0];
}

/** Whole cents, or undefined when the amount is not a sane positive dollar figure. */
export function toCents(amountUsd: unknown): number | undefined {
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) return undefined;
  const cents = Math.round(amountUsd * 100);
  if (cents < 1 || cents > MAX_AMOUNT_USD * 100) return undefined;
  return cents;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function cardResult(record: PaymentRecord, card: Card, request: SpendRequest): ToolResultLike {
  const exp = `${String(card.exp_month).padStart(2, "0")}/${card.exp_year}`;
  const address = card.billing_address;
  const lines = [
    `Spend request ${record.spendRequestId} is approved for ${fmtUsd(record.amountUsd)} at ${record.merchantName}. One-time ${card.brand} card, shown once:`,
    `Card number: ${card.number}`,
    `Expiry: ${exp}`,
    `CVC: ${card.cvc ?? "(not provided)"}`,
  ];
  if (address) {
    lines.push(`Name on card: ${address.name}`);
    lines.push(`Billing address: ${[address.line1, address.line2, address.city, address.state, address.postal_code, address.country].filter(Boolean).join(", ")}`);
  }
  const until = card.valid_until ?? (request.expires_at ? new Date(request.expires_at * 1000).toISOString() : undefined);
  if (until) lines.push(`Valid until: ${until}`);
  lines.push(
    "Type these into the merchant checkout now. Do not repeat the number, expiry or CVC in any message, note, memory or log, and do not call payment_status for this id again to see them. If the checkout fails, say so and make a new payment_request.",
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function describeStatus(request: SpendRequest, record: PaymentRecord): string {
  const base = `Spend request ${record.spendRequestId} (${fmtUsd(record.amountUsd)} to ${record.merchantName}) is ${request.status}.`;
  switch (request.status) {
    case "created":
      return `${base} Approval was not requested yet.`;
    case "pending_approval":
      return `${base} Waiting for the owner to approve in Link. Do not retry the purchase; ask again later or wait for the owner to say they approved.`;
    case "approved":
      return `${base} Link has not returned the card yet. Call payment_status again in a moment.`;
    case "requires_action": {
      const action = request.status_details?.requires_action?.next_action;
      if (!action) return `${base} Link needs something more but gave no detail.`;
      if (action.resolution === "auto_resume") return `${base} Link is finishing a check. Call payment_status again shortly.`;
      return `${base} The owner must act: ${action.display_message}${action.action_url ? ` ${action.action_url}` : ""}. Send this to the owner, then make a new payment_request once they are done.`;
    }
    case "denied":
    case "expired":
    case "canceled":
      return `${base} Do not retry without asking the owner first.`;
    case "submitted":
    case "succeeded":
      return `${base} The payment went through.`;
    case "failed": {
      const d = request.payment_status_details;
      return `${base}${d?.decline_code ? ` Decline code: ${d.decline_code}.` : ""} Tell the owner before trying again.`;
    }
    default:
      return base;
  }
}

/** Link outcomes in which no money moves, so the request's hold on the daily total is given back. */
const RELEASED_STATUSES = new Set(["denied", "expired", "canceled", "failed"]);

function localDay(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

async function sendOwner(deps: PaymentsToolDeps, ctx: ToolContext, text: string, via: string): Promise<boolean> {
  const phone = deps.config.owner.phones[0];
  if (!phone) return false;
  await deps.outbox.send({ channel: "imessage", to: phone, text }, { principal: ctx.principal, conversationKey: ctx.conversationKey });
  deps.audit.append({
    kind: "outbound",
    conversationKey: ctx.conversationKey,
    principal: ctx.principal.id,
    detail: { channel: "imessage", to: phone, chars: text.length, via },
  });
  return true;
}

function isOwner(p: Principal): boolean {
  return p.kind === "owner";
}

export function readPayments(state: Pick<StateDir, "readJson">): PaymentsState {
  const raw = state.readJson<Partial<PaymentsState>>(PAYMENTS_FILE, { version: 1, requests: [] });
  return { version: 1, requests: Array.isArray(raw.requests) ? raw.requests : [] };
}

function findRecord(state: Pick<StateDir, "readJson">, id: string): PaymentRecord | undefined {
  return readPayments(state).requests.find((r) => r.spendRequestId === id);
}

function upsertRecord(state: Pick<StateDir, "readJson" | "writeJson">, record: PaymentRecord): void {
  const all = readPayments(state);
  const idx = all.requests.findIndex((r) => r.spendRequestId === record.spendRequestId);
  if (idx === -1) all.requests.push(record);
  else all.requests[idx] = record;
  state.writeJson(PAYMENTS_FILE, all);
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtUsdMaybe(n: number | undefined): string {
  return n === undefined ? "" : fmtUsd(n);
}

function argText(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v.slice(0, 120) : "";
}

function argNumber(args: unknown, key: string): number | undefined {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
