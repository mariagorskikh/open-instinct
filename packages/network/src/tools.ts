import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type {
  AuditLog,
  A2AStore,
  Contact,
  ContactStore,
  Grant,
  InstinctConfig,
  Outbox,
  OutboundMessage,
  Policy,
  PolicyEngine,
  Principal,
  RegisteredTool,
  ToolContext,
  ToolResultLike,
} from "@open-instinct/core";
import { mayShareOwnerContact, ownerContactIn, utcOffset } from "@open-instinct/core";
import type { InkboxA2A, InkboxProvisioner } from "@open-instinct/inkbox";
import { ASSIGNABLE_TIERS, CAPABILITIES, TIERS, parseCapabilities } from "./capabilities.js";
import { defineTool, textResult } from "./define.js";
import { contactLine, lookupContact, slugify } from "./lookup.js";
import { decodeOip, encodeOip, OIP_INTENTS, oipToText, type OipIntent, type OipMessage } from "./oip.js";

/** The slice of the Inkbox A2A client these tools use. An `InkboxA2A` satisfies it. */
export type A2aLike = Pick<InkboxA2A, "send" | "reply">;
/** The slice of the Inkbox provisioner these tools use. An `InkboxProvisioner` satisfies it. */
export type ProvisionerLike = Pick<InkboxProvisioner, "createInvitation" | "addContactRule">;

export interface NetworkToolDeps {
  contacts: ContactStore;
  policy: PolicyEngine;
  config: InstinctConfig;
  audit: AuditLog;
  a2a?: A2aLike;
  a2aStore?: A2AStore;
  provisioner?: ProvisionerLike;
  outbox: Outbox;
  /** Called after a grant or tier override changes so the host can persist the policy (savePolicy). */
  onPolicyChange?: (policy: Policy) => void;
  now?: () => Date;
  /**
   * People an agent must not message on its own initiative (INSTINCT_RESERVED_CONTACTS, for example organizers). ask_instinct
   * refuses them unless the call says the owner asked for that person by name.
   */
  reservedNames?: string[];
  /** The owner's recorded meeting with this person, as "Sat, Oct 17, 12:30 PM, lobby cafe", if any. */
  meetingWith?: (name: string) => string | undefined;
  /** Start (ISO) of the owner's recorded meeting with this person, if any. */
  meetingStartWith?: (name: string) => string | undefined;
  /** The owner's meeting with someone other than `peer` at a time the text names, as "Victor Alvarado at Sat, Oct 17, 1:30 PM", if any. */
  clashWith?: (text: string, peer: string) => string | undefined;
}

const REPLY_INTENTS = ["progress", "complete", "ask_caller", "fail"] as const;
type ReplyIntent = (typeof REPLY_INTENTS)[number];

const TierSchema = Type.Union(TIERS.map((t) => Type.Literal(t)));
const OipIntentSchema = Type.Union(OIP_INTENTS.map((i) => Type.Literal(i)));
const PayloadSchema = Type.Record(Type.String(), Type.Unknown());

function isOwner(p: Principal): boolean {
  return p.kind === "owner";
}

function refuse(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Staff is for the owner's own agents, reached over authenticated A2A. A contact without an
 * agent handle can never be staff; core's ContactStore enforces the same rule.
 */
function staffRefusal(name: string, tier: string | undefined, agentHandle: string | undefined): ToolResultLike | undefined {
  if (tier !== "staff" || (agentHandle && agentHandle.replace(/^@+/, "").trim())) return undefined;
  return refuse(`Tier "staff" is only for agents, and ${name} has no agent handle. Save their agent's Inkbox handle first (contacts_upsert with agentHandle), or pick partner or lower.`);
}

function ownerOnly(ctx: ToolContext, what: string): ToolResultLike | undefined {
  return isOwner(ctx.principal) ? undefined : refuse(`Only the owner can ${what}. Offer to pass the request to the owner instead.`);
}

function agentHandleOf(config: InstinctConfig): string {
  return config.agent.handle ?? slugify(config.agent.name);
}

function onBehalfOf(config: InstinctConfig): OipMessage["on_behalf_of"] {
  return { handle: agentHandleOf(config), display: config.owner.name };
}

function requesterName(p: Principal): string {
  return p.kind === "agent" ? (p.onBehalfOf?.displayName ?? p.displayName) : p.displayName;
}

/** The sending handle is still ours; the human we act for is the requester, not the owner. */
function onBehalfOfRequester(config: InstinctConfig, p: Principal): OipMessage["on_behalf_of"] {
  return { handle: agentHandleOf(config), display: requesterName(p) };
}

const NON_OWNER_REACH = "I can only reach your own Instinct for you. For anyone else, ask the owner; offer to pass the request along.";

interface AskArgs {
  intent: OipIntent;
  subject?: string;
  text: string;
  payload?: Record<string, unknown>;
  contextId?: string;
  taskId?: string;
}

interface AskResult {
  ref: string;
  contactId?: string;
  name?: string;
  ok: boolean;
  via?: "a2a" | OutboundMessage["channel"];
  taskId?: string;
  contextId?: string;
  state?: string;
  text: string;
}

function uniqueRefs(refs: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const r of refs) {
    const t = (r ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** "N s" or "a few seconds" for an Inkbox 429, undefined for any other error. Duck-typed so this package needs inkbox for types only. */
function rateLimitWait(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; retryAfterSeconds?: unknown };
  if (e.status !== 429) return undefined;
  return typeof e.retryAfterSeconds === "number" ? `${e.retryAfterSeconds} s` : "a few seconds";
}

function fmtGrant(g: Grant): string {
  const bits = [`${g.id}: ${g.to} -> ${g.capabilities.join(", ")}`];
  const s = g.scope;
  if (s?.purpose) bits.push(`purpose ${s.purpose}`);
  if (s?.window) bits.push(`${s.window.from} to ${s.window.to}`);
  if (s?.maxUsd !== undefined) bits.push(`max $${s.maxUsd}`);
  if (g.expiresAt) bits.push(`expires ${g.expiresAt}`);
  if (g.note) bits.push(`"${g.note}"`);
  return bits.join(" | ");
}

function pickFallbackChannel(c: Contact): { channel: OutboundMessage["channel"]; to: string } | undefined {
  const phone = c.phones[0];
  if (phone) return { channel: "imessage", to: phone };
  const email = c.emails[0];
  if (email) return { channel: "email", to: email };
  return undefined;
}

export function networkTools(deps: NetworkToolDeps): RegisteredTool[] {
  const { contacts, policy, config, audit, outbox } = deps;
  const changed = () => deps.onPolicyChange?.(policy.toJSON());

  const contactsSearch = defineTool({
    name: "contacts_search",
    label: "Search contacts",
    description:
      "Find people in the owner's contacts by name, phone, email or agent handle. Empty query lists everyone. Non-owners only see their own entry.",
    parameters: Type.Object({ query: Type.String({ description: "Name, phone, email, @handle, or empty for all" }) }),
    meta: { capabilities: ["contacts.read"], group: "contacts", describe: (a) => `contacts_search ${(a as { query: string }).query}` },
    async execute(args, ctx) {
      const q = args.query.trim();
      if (!isOwner(ctx.principal)) {
        // Partners get "partial" contacts.read: they may confirm how they are listed and nothing more.
        const me = ctx.principal.contactId ? contacts.get(ctx.principal.contactId) : undefined;
        return textResult(me ? contactLine(me, false) : "You are not in the owner's contacts.");
      }
      const hits = q ? contacts.search(q) : contacts.all();
      if (!hits.length) return textResult(q ? `No contacts match "${q}".` : "No contacts yet.");
      return textResult(hits.map((c) => contactLine(c, true)).join("\n"));
    },
  });

  const contactsUpsert = defineTool({
    name: "contacts_upsert",
    label: "Add or update a contact",
    description: "Create or update a contact. Matching is by name slug; new phones, emails and handle are merged in.",
    parameters: Type.Object({
      name: Type.String(),
      phone: Type.Optional(Type.String()),
      email: Type.Optional(Type.String()),
      agentHandle: Type.Optional(Type.String({ description: "Inkbox handle of this person's Instinct, without @" })),
      tier: Type.Optional(TierSchema),
      notes: Type.Optional(Type.String()),
    }),
    meta: { capabilities: ["trust.manage"], group: "contacts", describe: (a) => `contacts_upsert ${(a as { name: string }).name}` },
    async execute(args, ctx) {
      const blocked = ownerOnly(ctx, "change contacts");
      if (blocked) return blocked;
      if (args.tier !== undefined && !ASSIGNABLE_TIERS.includes(args.tier)) {
        return refuse(`Tier must be one of ${ASSIGNABLE_TIERS.join(", ")}.`);
      }
      const existing = lookupContact(contacts, args.name).contact;
      const input: Partial<Contact> & { name: string } = { name: args.name };
      if (existing) input.id = existing.id;
      if (args.phone) input.phones = Array.from(new Set([...(existing?.phones ?? []), args.phone]));
      if (args.email) input.emails = Array.from(new Set([...(existing?.emails ?? []), args.email.toLowerCase()]));
      if (args.agentHandle) input.agentHandle = args.agentHandle.replace(/^@+/, "").toLowerCase();
      if (args.tier) input.tier = args.tier;
      if (args.notes) input.notes = args.notes;
      const staffBlocked = staffRefusal(existing?.name ?? args.name, args.tier, input.agentHandle ?? existing?.agentHandle);
      if (staffBlocked) return staffBlocked;
      const c = contacts.upsert(input);
      audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { action: "contacts_upsert", contactId: c.id, tier: c.tier } });
      return textResult(`${existing ? "Updated" : "Added"} ${contactLine(c, true)}`);
    },
  });

  const trustSetTier = defineTool({
    name: "trust_set_tier",
    label: "Set a contact's trust tier",
    description: `Place a contact in a tier (${ASSIGNABLE_TIERS.join(", ")}). Their Instinct inherits the tier.`,
    parameters: Type.Object({ contact: Type.String({ description: "Contact id, name, phone, email or @handle" }), tier: TierSchema }),
    meta: { capabilities: ["trust.manage"], group: "contacts", describe: (a) => `trust_set_tier ${(a as { contact: string; tier: string }).contact} -> ${(a as { tier: string }).tier}` },
    async execute(args, ctx) {
      const blocked = ownerOnly(ctx, "change trust tiers");
      if (blocked) return blocked;
      if (!ASSIGNABLE_TIERS.includes(args.tier)) return refuse(`Tier must be one of ${ASSIGNABLE_TIERS.join(", ")}. Nobody else can be owner.`);
      const found = lookupContact(contacts, args.contact);
      if (!found.contact) return refuse(found.error);
      const staffBlocked = staffRefusal(found.contact.name, args.tier, found.contact.agentHandle);
      if (staffBlocked) return staffBlocked;
      const before = found.contact.tier;
      const updated = contacts.setTier(found.contact.id, args.tier);
      if (!updated) return refuse(`Could not update ${found.contact.name}.`);
      audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { action: "set_tier", contactId: updated.id, from: before, to: args.tier } });
      return textResult(`${updated.name} is now ${args.tier} (was ${before}).`);
    },
  });

  const trustGrant = defineTool({
    name: "trust_grant",
    label: "Grant a scoped capability",
    description:
      `Give a contact extra capabilities for a purpose and a time window, for example "Sam can book us dinner this week". Capabilities: ${CAPABILITIES.join(", ")}.`,
    parameters: Type.Object({
      to: Type.String({ description: "Contact id, name, phone, email, @handle, or a principal id like contact:sam" }),
      capabilities: Type.Array(Type.String()),
      purpose: Type.Optional(Type.String()),
      from: Type.Optional(Type.String({ description: "Window start, ISO date" })),
      to_date: Type.Optional(Type.String({ description: "Window end, ISO date" })),
      maxUsd: Type.Optional(Type.Number()),
      expiresAt: Type.Optional(Type.String({ description: "ISO timestamp; defaults to the window end when given" })),
      note: Type.Optional(Type.String()),
    }),
    meta: { capabilities: ["trust.manage"], group: "contacts", describe: (a) => `trust_grant ${(a as { to: string }).to}: ${(a as { capabilities: string[] }).capabilities.join(",")}` },
    async execute(args, ctx) {
      const blocked = ownerOnly(ctx, "grant capabilities");
      if (blocked) return blocked;
      const { valid, invalid } = parseCapabilities(args.capabilities);
      if (invalid.length) return refuse(`Unknown capabilities: ${invalid.join(", ")}. Valid: ${CAPABILITIES.join(", ")}.`);
      if (!valid.length) return refuse("Give at least one capability.");

      let to = args.to.trim();
      let who = to;
      if (!/^(contact|agent):/.test(to)) {
        const found = lookupContact(contacts, to);
        if (!found.contact) return refuse(found.error);
        to = `contact:${found.contact.id}`;
        who = found.contact.name;
      }
      if ((args.from && !args.to_date) || (!args.from && args.to_date)) return refuse("Give both from and to_date for a window, or neither.");

      const scope: Grant["scope"] = {};
      const tz = config.owner.timezone || "UTC";
      // "Saturday only" means the owner's Saturday: plain days become local midnight to local end of day.
      const from = args.from ? startOfDayIso(args.from, tz) : undefined;
      const toDate = args.to_date ? endOfDayIso(args.to_date, tz) : undefined;
      if (args.purpose) scope.purpose = args.purpose;
      if (from && toDate) scope.window = { from, to: toDate };
      if (args.maxUsd !== undefined) scope.maxUsd = args.maxUsd;
      const expiresAt = args.expiresAt ?? toDate;

      const grant = policy.addGrant({ to, capabilities: valid, scope: Object.keys(scope).length ? scope : undefined, expiresAt, note: args.note });
      changed();
      audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { action: "grant", grantId: grant.id, to, capabilities: valid, scope: grant.scope, expiresAt } });
      return { content: [{ type: "text", text: `Granted ${who}: ${fmtGrant(grant)}` }], details: { grantId: grant.id } };
    },
  });

  const trustRevoke = defineTool({
    name: "trust_revoke",
    label: "Revoke a grant",
    description: "Remove a grant by id (see trust_list).",
    parameters: Type.Object({ grantId: Type.String() }),
    meta: { capabilities: ["trust.manage"], group: "contacts", describe: (a) => `trust_revoke ${(a as { grantId: string }).grantId}` },
    async execute(args, ctx) {
      const blocked = ownerOnly(ctx, "revoke grants");
      if (blocked) return blocked;
      const ok = policy.revokeGrant(args.grantId);
      if (!ok) return refuse(`No grant with id ${args.grantId}.`);
      changed();
      audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { action: "revoke", grantId: args.grantId } });
      return textResult(`Revoked grant ${args.grantId}.`);
    },
  });

  const trustList = defineTool({
    name: "trust_list",
    label: "Who can do what",
    description: "List every contact by tier, tier overrides, and active grants.",
    parameters: Type.Object({}),
    meta: { capabilities: ["trust.manage"], group: "contacts", describe: () => "trust_list" },
    async execute(_args, ctx) {
      const blocked = ownerOnly(ctx, "see the trust table");
      if (blocked) return blocked;
      const lines: string[] = ["Tiers:"];
      for (const tier of TIERS) {
        if (tier === "owner") continue;
        const people = contacts.all().filter((c) => c.tier === tier);
        if (!people.length) continue;
        lines.push(`  ${tier}: ${people.map((c) => (c.agentHandle ? `${c.name} (@${c.agentHandle})` : c.name)).join(", ")}`);
      }
      if (lines.length === 1) lines.push("  (no contacts yet)");

      const overrides = Object.entries(policy.toJSON().tiers).flatMap(([tier, caps]) =>
        Object.entries(caps ?? {}).map(([cap, perm]) => `  ${tier} ${cap} = ${perm}`),
      );
      lines.push("Tier overrides:", ...(overrides.length ? overrides : ["  (none, defaults apply)"]));

      const grants = policy.listGrants();
      lines.push("Grants:", ...(grants.length ? grants.map((g) => `  ${fmtGrant(g)}`) : ["  (none)"]));
      return textResult(lines.join("\n"));
    },
  });

  const askInstinct = defineTool({
    name: "ask_instinct",
    label: "Ask another Instinct",
    description:
      "Send a request to a contact's Instinct over A2A with a typed OIP intent. Give `contact` for one person or `contacts` for a group plan; everyone gets the same request and answers separately. When the owner asks and a contact has no Instinct, the same request goes to them as a text or email. Replies arrive later as new messages.",
    parameters: Type.Object({
      contact: Type.Optional(Type.String({ description: "Contact id, name, phone, email or @handle" })),
      contacts: Type.Optional(Type.Array(Type.String(), { description: "Several contacts for a group plan; each gets the same request" })),
      intent: OipIntentSchema,
      subject: Type.Optional(Type.String({ description: "Short topic, e.g. dinner with Maria and Sam" })),
      text: Type.String({ description: "Plain-language version of the request, written as the owner's Instinct" }),
      payload: Type.Optional(PayloadSchema),
      contextId: Type.Optional(Type.String({ description: "A2A context to continue; only with a single contact. Omit to start a new topic" })),
      taskId: Type.Optional(Type.String({ description: "An existing delegated task to answer when the other agent asks for more input. Only with a single contact." })),
      owner_named: Type.Optional(Type.Boolean({ description: "true only when the owner asked for this exact person by name in this conversation" })),
      move: Type.Optional(Type.Boolean({ description: "true when the owner asked to move or change a meeting already set with this person" })),
    }),
    meta: {
      capabilities: ["network.ask"],
      group: "network",
      describe: (a) => {
        const x = a as { contact?: string; contacts?: string[]; intent: string };
        return `ask_instinct ${[x.contact, ...(x.contacts ?? [])].filter(Boolean).join(", ")} ${x.intent}`;
      },
    },
    async execute(args, ctx) {
      if (ctx.channel === "a2a") return refuse("Nested delegation is not supported inside an inbound A2A task. Use reply_instinct with ask_caller to request more information from the calling agent.");
      const refs = uniqueRefs([args.contact, ...(args.contacts ?? [])]);
      if (refs.length === 0) return refuse("Give `contact` or `contacts`.");
      if ((args.contextId || args.taskId) && refs.length > 1) return refuse("contextId or taskId continues one peer's topic. Give one contact with it.");

      const results: AskResult[] = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        let found = resolveAskTarget(ref, ctx.principal);
        if (!found.contact && isOwner(ctx.principal) && /^@[a-z0-9][a-z0-9-]{2,}$/i.test(ref.trim()) && !/^Several contacts match/.test(found.error)) {
          // A bare handle from a directory is enough: the contact is created on the spot.
          const handle = ref.trim().replace(/^@/, "").toLowerCase();
          const created = contacts.upsert({ name: nameFromHandle(handle), agentHandle: `@${handle}`, tier: "contact" });
          found = { contact: created, error: "" };
        }
        if (!found.contact) {
          results.push({ ref, ok: false, text: `${ref}: ${found.error}` });
          continue;
        }
        if (seen.has(found.contact.id)) continue;
        seen.add(found.contact.id);
        // Reserved people (organizers, say) got messages from agents whose owners never named them.
        // By name or by handle: a contact saved under another name can still carry a reserved person's handle.
        const reserved = (deps.reservedNames ?? []).find((n) => sameName(n, found.contact!.name) || handleOf(n, found.contact!.agentHandle));
        // A repeat "introduce me" re-proposed meetings that were already set, and the two sides drifted apart.
        // Only a new scheduling ask is held back; a question, a note or a share about something else goes through.
        // A note or question that only mentions the meeting ("running 10 min late to our meeting",
        // "what are you working on before we meet?") is not a new booking: testing refused 12 of 16 of them.
        const note = args.intent === "ask" && /\b(running late|running behind|late to|minutes late|min late|on my way|be there in|working on|what (?:do|does|are|is|was)|how (?:is|are|was)|who (?:is|are) (?:they|he|she)|tell (?:me|us) about|one-line intro|short intro|a bit about|thank|thanks|my email|my phone|my number|my linkedin|send(?:ing)? (?:you|them|him|her) my|here is my|here's my)\b/i.test(args.text);
        const scheduling = ["propose_times", "request_freebusy", "book_request"].includes(args.intent) || (args.intent === "ask" && !note && /\b(meet|meetup|intro|introduce|coffee|lunch|dinner|catch up|slot|time to)\b/i.test(`${args.subject ?? ""} ${args.text}`));
        // A group plan (a 3-way coffee) is a new meeting even with someone the owner already meets one-to-one.
        const group = refs.length > 1 || /\b(3-way|three-way|4-way|group|all three|all of us|the three of us|together with)\b/i.test(`${args.subject ?? ""} ${args.text}`);
        const existing = isOwner(ctx.principal) && scheduling && !group && !args.move && !args.taskId ? deps.meetingWith?.(found.contact.name) : undefined;
        // A "move" to the start already held changes nothing and confuses both sides.
        const held = args.move ? deps.meetingStartWith?.(found.contact.name) : undefined;
        const asked = args.move ? requestedStart(args.payload) : undefined;
        if (held && asked && Date.parse(held) === Date.parse(asked)) {
          results.push({ ref, ok: false, text: `The owner's meeting with ${found.contact.name} is already at that time${deps.meetingWith ? ` (${deps.meetingWith(found.contact.name) ?? ""})` : ""}. Nothing was sent; tell the owner it is already set then.` });
          continue;
        }
        if (existing) {
          results.push({ ref, ok: false, text: `The owner is already meeting ${found.contact.name}: ${existing}. Nothing was sent. Tell the owner that; if they asked to move it, call again with move: true.` });
          continue;
        }
        // "Send Ethan my email" once went out as the words "my email", and the owner was told it was sent.
        if (isOwner(ctx.principal) && /\bmy (email|e-mail|phone|number|linkedin)\b/i.test(args.text) && !/@|\d{3}|linkedin\.com/i.test(args.text)) {
          results.push({ ref, ok: false, text: `Nothing sent to ${found.contact.name}: the message says "my ${/\bmy (\w+)/i.exec(args.text)?.[1] ?? "details"}" but not the actual detail. Ask the owner for it, then send it.` });
          continue;
        }
        // The owner's "yes" to one person went out while the same slot was already given to another
        // (testing: Rafael confirmed Leo three times while set with Ingrid). Check before sending.
        const timed = `${args.text} ${JSON.stringify(args.payload ?? {})}`;
        const clash = isOwner(ctx.principal) && !note ? deps.clashWith?.(timed, found.contact.name) : undefined;
        const clashFirst = clash ? clash.split(" ")[0]!.toLowerCase() : "";
        const counter = /\b(taken|busy|clash|conflict|can't|cannot|won't|isn't free|not free)\b/i.test(args.text);
        const sameGroup = group && clashFirst.length > 1 && args.text.toLowerCase().includes(clashFirst);
        if (clash && !counter && !sameGroup) {
          results.push({ ref, ok: false, text: `Nothing sent to ${found.contact.name}: the owner already meets ${clash}. Offer ${found.contact.name} the next free slot instead; ask the owner only if they want to swap.` });
          continue;
        }
        // An ask to meet with no time in it opens a negotiation that rarely closes; one concrete slot does.
        const slotsGiven = Array.isArray((args.payload as { slots?: unknown[] } | undefined)?.slots) && ((args.payload as { slots: unknown[] }).slots.length > 0);
        if (scheduling && isOwner(ctx.principal) && !args.move && !args.taskId && !args.contextId && !slotsGiven && !/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(args.text) && !/\b(?:noon|midday)\b/i.test(args.text)) {
          results.push({ ref, ok: false, text: `${ref}: nothing sent. A meeting ask must name one concrete time and place (for example "Saturday October 17 at 12:30 PM, lunch in the lobby cafe"); the other side says yes or offers another slot.` });
          continue;
        }
        if (reserved && !args.owner_named && !args.taskId && !args.contextId) {
          results.push({ ref, ok: false, text: `${found.contact.name} is on the reserved list. Message them only when the owner asked for ${found.contact.name} by name; if so, call again with owner_named: true. Otherwise suggest someone else and do not tell the owner you reached out.` });
          continue;
        }
        results.push(await askOne(found.contact, args, ctx));
      }

      const okCount = results.filter((r) => r.ok).length;
      const anyA2a = results.some((r) => r.ok && r.via === "a2a");
      if (results.length === 1 && results[0]) {
        const r = results[0];
        const details: Record<string, unknown> = { results };
        if (r.taskId) details.taskId = r.taskId;
        if (r.contextId) details.contextId = r.contextId;
        if (r.state) details.state = r.state;
        const tail = r.via === "a2a" ? " Their reply will arrive here as a new message; tell the owner you will report back." : "";
        return { content: [{ type: "text", text: r.text + tail }], isError: !r.ok, details };
      }
      const lines = results.map((r) => `- ${r.text}`);
      lines.unshift(`Asked ${okCount} of ${results.length}:`);
      if (anyA2a) lines.push("Replies arrive here as new messages, one per Instinct; tell the owner you will report back once they answer.");
      return { content: [{ type: "text", text: lines.join("\n") }], isError: okCount === 0, details: { results } };
    },
  });

  function requestedStart(payload: Record<string, unknown> | undefined): string | undefined {
    if (!payload) return undefined;
    if (typeof payload.start === "string") return payload.start;
    const slots = payload.slots;
    if (Array.isArray(slots) && slots.length === 1 && slots[0] && typeof (slots[0] as { start?: unknown }).start === "string") return (slots[0] as { start: string }).start;
    return undefined;
  }

  /** "Sam Lee" matches handles like "sam-lee-k7p2x"; "@sam-lee-k7p2x" matches exactly. */
  function handleOf(entry: string, handle: string | undefined): boolean {
    if (!handle) return false;
    const h = handle.toLowerCase().replace(/^@/, "");
    const e = entry.trim().toLowerCase();
    if (e.startsWith("@")) return h === e.slice(1);
    const slug = e.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return slug !== "" && (h === slug || h.startsWith(`${slug}-`));
  }

  function sameName(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
    return norm(a) !== "" && norm(a) === norm(b);
  }

  /**
   * Who a principal may address through ask_instinct. The owner: anyone in contacts. Anyone
   * else: only their own entry (so a person can ask their own Instinct through this one), with
   * no hint about who else is in the address book.
   */
  function resolveAskTarget(ref: string, principal: Principal): { contact?: Contact; error: string } {
    if (isOwner(principal)) {
      const found = lookupContact(contacts, ref);
      return found.contact ? { contact: found.contact, error: "" } : { error: found.error };
    }
    const found = lookupContact(contacts, ref, { disclose: false });
    const mine = principal.contactId;
    if (!found.contact) return { error: /^Several contacts match/.test(found.error) ? found.error : NON_OWNER_REACH };
    if (!mine || found.contact.id !== mine) return { error: NON_OWNER_REACH };
    return { contact: found.contact, error: "" };
  }

  async function askOne(c: Contact, args: AskArgs, ctx: ToolContext): Promise<AskResult> {
    const owner = isOwner(ctx.principal);
    const oip: OipMessage = { oip: "1", intent: args.intent, payload: args.payload ?? {}, on_behalf_of: owner ? onBehalfOf(config) : onBehalfOfRequester(config, ctx.principal) };
    if (args.subject) oip.subject = args.subject;
    // A relayed request must never read as the owner's own words.
    const text = owner ? args.text : `From ${requesterName(ctx.principal)}, relayed by ${config.owner.name}'s Instinct (not ${config.owner.name}'s request): ${args.text}`;
    const base = { ref: c.id, contactId: c.id, name: c.name };

    if (c.agentHandle && deps.a2a) {
      const prior = args.taskId ? deps.a2aStore?.delegation(args.taskId) : undefined;
      if (args.taskId && (!prior || prior.peer !== c.agentHandle || prior.conversationKey !== ctx.conversationKey || prior.principal.id !== ctx.principal.id)) {
        return { ...base, ok: false, text: "That task was not delegated to this contact from this conversation." };
      }
      const messageId = randomUUID();
      deps.a2aStore?.begin({ messageId, peer: c.agentHandle, conversationKey: ctx.conversationKey, deliveryKey: ctx.deliveryKey ?? ctx.conversationKey, principal: ctx.principal, ...(ctx.replyRef ? { replyRef: { ...ctx.replyRef } } : {}), ...(args.taskId ? { taskId: args.taskId } : {}), at: new Date().toISOString(), summary: args.text.slice(0, 200) });
      const res = await deps.a2a.send(c.agentHandle, text, encodeOip(oip), {
        messageId,
        ...(args.contextId ? { contextId: args.contextId } : {}),
        ...(args.taskId ? { taskId: args.taskId } : {}),
      });
      deps.a2aStore?.confirm(messageId, res);
      audit.append({
        kind: "outbound",
        conversationKey: ctx.conversationKey,
        principal: ctx.principal.id,
        detail: { channel: "a2a", to: c.agentHandle, contactId: c.id, intent: args.intent, subject: args.subject, taskId: res.taskId, contextId: res.contextId, state: res.state, onBehalfOf: oip.on_behalf_of?.display },
      });
      const ids = [res.taskId ? `task ${res.taskId}` : undefined, res.contextId ? `context ${res.contextId}` : undefined].filter(Boolean).join(", ");
      const out: AskResult = { ...base, ok: true, via: "a2a", text: `Sent "${args.intent}" to ${c.name}'s Instinct (@${c.agentHandle})${ids ? ` (${ids})` : ""}.` };
      if (res.taskId) out.taskId = res.taskId;
      if (res.contextId) out.contextId = res.contextId;
      if (res.state) out.state = res.state;
      return out;
    }

    if (!owner) {
      // Texting or emailing a human as the owner's Instinct is the owner's call, never a caller's.
      return { ...base, ok: false, text: `${c.name}: only the owner can message people who have no Instinct. Offer to pass the request to the owner.` };
    }
    const route = pickFallbackChannel(c);
    if (!route) return { ...base, ok: false, text: `${c.name} has no Instinct, phone or email on file. Ask the owner for a way to reach them.` };
    const body = oipToText({ ...oip, payload: { ...oip.payload, text: args.text } }, config.owner.name, { tz: config.owner.timezone });
    await outbox.send({ channel: route.channel, to: route.to, text: body }, { principal: ctx.principal, conversationKey: ctx.conversationKey });
    audit.append({
      kind: "outbound",
      conversationKey: ctx.conversationKey,
      principal: ctx.principal.id,
      detail: { channel: route.channel, to: route.to, contactId: c.id, intent: args.intent, subject: args.subject, fallback: true },
    });
    return { ...base, ok: true, via: route.channel, text: `${c.name} has no Instinct, so I sent them a ${route.channel === "email" ? "email" : "text"} instead:\n${body}` };
  }

  const replyInstinct = defineTool({
    name: "reply_instinct",
    label: "Reply to the calling Instinct",
    description:
      "Answer the A2A task you are working on. Use progress while you check with the owner, complete with the answer, ask_caller to ask them something, fail when you cannot help. Only valid inside an A2A conversation.",
    parameters: Type.Object({
      intent: Type.Union(REPLY_INTENTS.map((i) => Type.Literal(i))),
      text: Type.String(),
      payload: Type.Optional(PayloadSchema),
      oipIntent: Type.Optional(OipIntentSchema),
      subject: Type.Optional(Type.String()),
    }),
    meta: { capabilities: ["converse"], group: "network", describe: (a) => `reply_instinct ${(a as { intent: string }).intent}` },
    async execute(args, ctx) {
      if (ctx.channel !== "a2a") return refuse("reply_instinct only works inside an A2A conversation. Use send_message here.");
      if (!deps.a2a) return refuse("A2A is not configured on this agent.");
      const taskId = ctx.replyRef?.taskId;
      if (!taskId || !ctx.assertA2AActive) return refuse("No active inbound A2A task is bound to this conversation.");
      await ctx.assertA2AActive();
      if (!mayShareOwnerContact(ctx.principal.tier) && ownerContactIn(`${args.text} ${JSON.stringify(args.payload ?? {})}`, config.owner).length > 0) {
        audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { outcome: "deny", tool: "reply_instinct", reason: "owner contact details to a non-partner agent" } });
        return refuse(`Not sent: that reply contains ${config.owner.name}'s phone or email, which only a partner may get. Decline that part, and tell ${config.owner.name} what was asked.`);
      }
      // Saying yes to a time already given to someone else double-books the owner; catch it before it is sent.
      const peerName = ctx.principal.onBehalfOf?.displayName ?? ctx.principal.displayName.replace(/[\u2019']s agent$/i, "");
      const taken = args.intent !== "fail" ? deps.clashWith?.(`${args.text} ${JSON.stringify(args.payload ?? {})}`, peerName) : undefined;
      if (taken && !/\b(taken|busy|booked with|clash|conflict|not free|isn't free|can't|cannot)\b/i.test(args.text)) {
        return refuse(`Not sent: ${config.owner.name} already meets ${taken}. Tell ${peerName}'s agent that time is taken and offer the next free slot instead.`);
      }
      const data = buildReplyData(args, config);
      try {
        await deps.a2a.reply(taskId, args.intent as ReplyIntent, args.text, data);
        ctx.markA2AState?.(({ progress: "working", complete: "completed", ask_caller: "input_required", fail: "failed" } as const)[args.intent as ReplyIntent]);
      } catch (err) {
        const wait = rateLimitWait(err);
        if (wait !== undefined) return refuse(`Inkbox is rate limiting; try reply_instinct again in ${wait}.`);
        throw err;
      }
      audit.append({
        kind: "outbound",
        conversationKey: ctx.conversationKey,
        principal: ctx.principal.id,
        detail: { channel: "a2a", taskId, intent: args.intent, oipIntent: data ? (data as { intent?: unknown }).intent : undefined },
      });
      return textResult(`Replied ${args.intent} on task ${taskId}.`);
    },
  });

  const inviteToNetwork = defineTool({
    name: "invite_to_network",
    label: "Invite someone's Instinct",
    description:
      "Connect a person's Instinct to this one at a chosen tier. Creates an Inkbox invitation when possible and returns a link or text for the owner to pass along. Creates the contact if needed.",
    parameters: Type.Object({
      contact: Type.String({ description: "Contact id or name; a new contact is created from a name" }),
      tier: TierSchema,
      email: Type.Optional(Type.String({ description: "Where to email the invitation" })),
    }),
    meta: { capabilities: ["network.invite"], group: "network", describe: (a) => `invite_to_network ${(a as { contact: string }).contact} as ${(a as { tier: string }).tier}` },
    async execute(args, ctx) {
      const blocked = ownerOnly(ctx, "invite people to the network");
      if (blocked) return blocked;
      if (!ASSIGNABLE_TIERS.includes(args.tier)) return refuse(`Tier must be one of ${ASSIGNABLE_TIERS.join(", ")}.`);

      let c = lookupContact(contacts, args.contact).contact;
      // Check before creating anything: a new contact made here never has an agent handle.
      const staffBlocked = staffRefusal(c?.name ?? args.contact.trim(), args.tier, c?.agentHandle);
      if (staffBlocked) return staffBlocked;
      if (!c) {
        if (/^(contact:|\+|\d)/.test(args.contact) || args.contact.includes("@")) return refuse(`No contact matches "${args.contact}". Give a name to create one.`);
        c = contacts.upsert({ name: args.contact.trim(), emails: args.email ? [args.email.toLowerCase()] : [] });
      } else if (args.email && !c.emails.includes(args.email.toLowerCase())) {
        c = contacts.upsert({ id: c.id, name: c.name, emails: [...c.emails, args.email.toLowerCase()] });
      }
      const placed = contacts.setTier(c.id, args.tier) ?? c;

      const ourHandle = config.agent.handle;
      const lines: string[] = [`${placed.name} is now at tier ${args.tier}.`];
      let invitation: { id: string; invitationUrl?: string; invitationToken?: string; agentHandoffPrompt?: string } | undefined;

      if (deps.provisioner && ourHandle) {
        const recipientEmail = args.email ?? placed.emails[0];
        const inv = await deps.provisioner.createInvitation({ peerHandles: [ourHandle], ...(recipientEmail ? { recipientEmail } : {}) });
        invitation = inv;
        if (placed.agentHandle) await deps.provisioner.addContactRule(ourHandle, placed.agentHandle, "both");
        if (inv.invitationUrl) lines.push(`Invitation link: ${inv.invitationUrl}`);
        if (recipientEmail) lines.push(`Inkbox emailed it to ${recipientEmail}.`);
        if (inv.agentHandoffPrompt) lines.push(`Text for ${placed.name} to give their Instinct:\n${inv.agentHandoffPrompt}`);
        if (placed.agentHandle) lines.push(`@${placed.agentHandle} may now call @${ourHandle} and vice versa.`);
      } else if (ourHandle) {
        lines.push(`Ask ${placed.name} to have their Instinct connect to @${ourHandle}, then tell me their agent handle so I can save it.`);
      } else {
        lines.push("This agent has no Inkbox handle yet, so I cannot create an invitation. Finish Inkbox setup first.");
      }

      audit.append({
        kind: "policy",
        conversationKey: ctx.conversationKey,
        principal: ctx.principal.id,
        detail: { action: "invite", contactId: placed.id, tier: args.tier, invitationId: invitation?.id, email: args.email ?? placed.emails[0] },
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: { contactId: placed.id, invitationId: invitation?.id, invitationUrl: invitation?.invitationUrl } };
    },
  });

  return [contactsSearch, contactsUpsert, trustSetTier, trustGrant, trustRevoke, trustList, askInstinct, replyInstinct, inviteToNetwork];
}

/** Decide what structured data a reply carries: a valid OIP object as given, an OIP wrap when an intent is named, else the raw payload. */
function buildReplyData(
  args: { payload?: Record<string, unknown>; oipIntent?: OipIntent; subject?: string },
  config: InstinctConfig,
): Record<string, unknown> | undefined {
  if (args.payload) {
    const asOip = decodeOip(args.payload);
    if (asOip) return encodeOip(asOip);
  }
  if (args.oipIntent) {
    const m: OipMessage = { oip: "1", intent: args.oipIntent, payload: args.payload ?? {}, on_behalf_of: onBehalfOf(config) };
    if (args.subject) m.subject = args.subject;
    return encodeOip(m);
  }
  return args.payload;
}

/** A window's last day should still be usable, so the grant expires at the end of it. */
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;

function startOfDayIso(date: string, tz: string): string {
  return PLAIN_DAY.test(date) ? `${date}T00:00:00${utcOffset(new Date(`${date}T12:00:00Z`), tz)}` : date;
}

function endOfDayIso(date: string, tz: string): string {
  return PLAIN_DAY.test(date) ? `${date}T23:59:59${utcOffset(new Date(`${date}T12:00:00Z`), tz)}` : date;
}

/** "priya-natarajan-wjzg2" becomes "Priya Natarajan": a trailing random suffix is dropped. */
export function nameFromHandle(handle: string): string {
  const parts = handle.replace(/^@/, "").split("-").filter(Boolean);
  if (parts.length > 1 && /^[a-z0-9]{4,6}$/.test(parts[parts.length - 1]!) && /\d/.test(parts[parts.length - 1]!)) parts.pop();
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
