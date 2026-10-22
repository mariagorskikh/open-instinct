import type { UserRecord } from "./store.js";

export const GITHUB_URL = "https://github.com/mariagorskikh/open-instinct";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Only allow data: PNG urls and plain https links into attributes. */
export function safeUrl(u: string | undefined, allowData = false): string {
  if (!u) return "";
  if (allowData && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
  if (/^(https?:|sms:|mailto:)/i.test(u)) return escapeHtml(u);
  return "";
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#111318;--muted:#5b6170;--line:#e4e6eb;--accent:#0a84ff;--accent-ink:#fff;--ok:#1f9d55;--warn:#b7791f;--bad:#c53030;--code:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--text:#eef0f4;--muted:#9aa1ad;--line:#262a31;--accent:#3b9dff;--accent-ink:#06121f;--code:#1f242b}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:640px;margin:0 auto;padding:40px 16px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:28px}
.brand{font-weight:700;letter-spacing:-.01em;font-size:18px;color:var(--text)}
.brand svg{width:22px;height:22px;margin-right:9px;vertical-align:-5px}
nav a{color:var(--muted);font-size:14px;margin-left:16px}
h1{font-size:clamp(28px,6vw,40px);line-height:1.1;letter-spacing:-.02em;margin:0 0 12px}
h2{font-size:20px;letter-spacing:-.01em;margin:32px 0 12px}
p{margin:0 0 12px}
.lead{font-size:18px;color:var(--muted);margin-bottom:28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
.grid{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:560px){.grid.three{grid-template-columns:repeat(3,1fr)}}
.feature h3{margin:0 0 6px;font-size:15px}
.feature p{margin:0;color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
label small{font-weight:400;color:var(--muted)}
input{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.btn{display:inline-block;width:100%;text-align:center;font:inherit;font-weight:600;padding:13px 18px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);cursor:pointer;margin-top:18px}
.btn.secondary{background:var(--code);color:var(--text)}
.hint{color:var(--muted);font-size:13px;margin-top:10px}
.error{background:rgba(197,48,48,.08);border:1px solid rgba(197,48,48,.35);color:var(--bad);border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:8px}
.steps{counter-reset:s;list-style:none;padding:0;margin:0}
.steps li{position:relative;padding-left:40px;margin:0 0 14px;color:var(--muted)}
.steps li b{color:var(--text)}
.steps li::before{counter-increment:s;content:counter(s);position:absolute;left:0;top:1px;width:26px;height:26px;border-radius:50%;background:var(--code);color:var(--text);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
code,.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em}
.code{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--code);border-radius:12px;padding:14px 16px;font-size:20px;font-weight:600;margin:10px 0}
.code button{font:inherit;font-size:13px;font-weight:600;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.number{font-size:clamp(24px,7vw,32px);font-weight:700;letter-spacing:.01em}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;padding:5px 11px;border-radius:999px;background:var(--code)}
.pill i{width:8px;height:8px;border-radius:50%;display:inline-block}
.pill.ok i{background:var(--ok)}.pill.warn i{background:var(--warn)}.pill.bad i{background:var(--bad)}
.qr{display:block;width:200px;height:200px;margin:16px auto 4px;border-radius:12px;background:#fff;padding:8px}
footer{margin-top:40px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
`;

function layout(title: string, body: string, opts: { refreshSeconds?: number } = {}): string {
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
${refresh}
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <a class="brand" href="/"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M78 30 A34 34 0 1 1 62 22" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><circle cx="71" cy="25" r="6" fill="#0F766E"/></svg>Open Instinct</a>
  <nav><a href="${GITHUB_URL}" rel="noopener">GitHub</a></nav>
</header>
${body}
<footer>Open Instinct is open source (MIT). Your agent runs in its own VM; this page only sets it up. <a href="${GITHUB_URL}" rel="noopener">Read the code</a>.</footer>
</div>
</body>
</html>`;
}

export interface LandingOptions {
  signupEnabled: boolean;
  requireInvite: boolean;
  errors?: Record<string, string>;
  values?: Record<string, string>;
}

export function renderLanding(opts: LandingOptions): string {
  const v = (k: string) => escapeHtml(opts.values?.[k] ?? "");
  const err = (k: string) => (opts.errors?.[k] ? `<div class="error">${escapeHtml(opts.errors[k] ?? "")}</div>` : "");
  const form = opts.signupEnabled
    ? `<form class="card" method="post" action="/api/signup">
  <h2 style="margin-top:0">Get your Instinct</h2>
  ${err("form")}
  <label for="name">Your name</label>
  <input id="name" name="name" required maxlength="80" autocomplete="name" value="${v("name")}">
  ${err("name")}
  <label for="phone">Phone <small>the number you will text from</small></label>
  <input id="phone" name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="+1 415 555 0123" value="${v("phone")}">
  ${err("phone")}
  <label for="email">Email <small>optional, lets your Instinct know it is you on email</small></label>
  <input id="email" name="email" type="email" autocomplete="email" value="${v("email")}">
  ${err("email")}
  <label for="handle">Handle <small>your Instinct's address: letters, digits, dashes</small></label>
  <input id="handle" name="handle" required minlength="3" maxlength="40" pattern="[A-Za-z0-9-]{3,40}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="maria" value="${v("handle")}">
  ${err("handle")}
  ${
    opts.requireInvite
      ? `<label for="inviteCode">Invite code</label>
  <input id="inviteCode" name="inviteCode" required autocomplete="off" autocapitalize="off">
  ${err("inviteCode")}`
      : ""
  }
  <label for="brainRepo">Company brain <small>optional: a GitHub repo your Instinct reads at setup (handbook, notes, code)</small></label>
  <input id="brainRepo" name="brainRepo" placeholder="acme/handbook" autocapitalize="off" autocorrect="off" spellcheck="false" value="${v("brainRepo")}">
  ${err("brainRepo")}
  <label for="brainToken">GitHub token <small>only for private repos</small></label>
  <input id="brainToken" name="brainToken" type="password" autocomplete="off" value="">
  ${err("brainToken")}
  <button class="btn" type="submit">Create my Instinct</button>
  <p class="hint">Setup takes about a minute. You will get a number to text and a short connect command.</p>
</form>`
    : `<div class="card"><h2 style="margin-top:0">Signups are closed here</h2><p class="hint">This gateway only relays messages. To run your own, follow the README on GitHub.</p></div>`;

  return layout(
    "Open Instinct",
    `<h1>A personal agent you text.</h1>
<p class="lead">It has its own computer, does real tasks, and coordinates with the Instincts of the people you trust. Open source, yours to run.</p>
<div class="grid three" style="margin-bottom:24px">
  <div class="card feature"><h3>Text it</h3><p>iMessage, SMS or email. Ask for research, plans, bookings, reminders.</p></div>
  <div class="card feature"><h3>It has a computer</h3><p>A Linux desktop in its own VM. Websites, files, logins you hand over live.</p></div>
  <div class="card feature"><h3>It knows who to trust</h3><p>Partner, family, friend, stranger. Each tier can ask for different things.</p></div>
</div>
${form}
<h2>How it works</h2>
<ol class="steps">
  <li><b>You sign up.</b> The gateway creates an Inkbox identity with an iMessage line and a mailbox for your agent.</li>
  <li><b>Your agent gets a VM.</b> Maritime starts a private machine with a desktop that sleeps when idle.</li>
  <li><b>You connect.</b> Text one short command to the router number, or scan a QR code.</li>
  <li><b>You talk.</b> Every message is signed by Inkbox, verified here, and handed to your agent only.</li>
</ol>`,
  );
}

export interface RouterInfo {
  number: string;
  connectCommand: string;
  smsLink: string;
  qrPngDataUrl: string;
}

export function connectCommandFor(handle: string): string {
  return `connect @${handle}`;
}

/** The `sms:` link that opens Messages with this handle's connect command filled in. */
export function smsHrefFor(number: string, handle: string): string {
  return `sms:${number}&body=${encodeURIComponent(connectCommandFor(handle))}`;
}

/**
 * True when router info was produced for this handle, so its QR can be shown.
 * The org-wide triage endpoint returns a placeholder ("connect @handle"); its QR
 * would connect the wrong identity.
 */
export function routerInfoIsFor(info: RouterInfo, handle: string): boolean {
  const want = connectCommandFor(handle).toLowerCase();
  if (info.connectCommand.trim().toLowerCase() === want) return true;
  try {
    return decodeURIComponent(info.smsLink).toLowerCase().includes(want);
  } catch {
    return false;
  }
}

/** What the connect page needs: the number for everyone, a QR only when it is this user's. */
export interface ConnectRouter {
  number: string;
  qrPngDataUrl?: string;
}

export function connectRouterFor(handle: string, shared: RouterInfo | undefined, perUser: RouterInfo | undefined): ConnectRouter | undefined {
  const number = perUser?.number || shared?.number;
  if (!number) return undefined;
  const source = perUser && routerInfoIsFor(perUser, handle) ? perUser : shared && routerInfoIsFor(shared, handle) ? shared : undefined;
  const out: ConnectRouter = { number };
  if (source?.qrPngDataUrl) out.qrPngDataUrl = source.qrPngDataUrl;
  return out;
}

function statusPill(u: UserRecord): string {
  if (u.status === "ready") return `<span class="pill ok"><i></i>Ready</span>`;
  if (u.status === "error") return `<span class="pill bad"><i></i>Setup failed</span>`;
  return `<span class="pill warn"><i></i>Setting up</span>`;
}

export function renderConnect(user: UserRecord, router: ConnectRouter | undefined): string {
  const command = connectCommandFor(user.handle);
  const smsHref = router ? safeUrl(smsHrefFor(router.number, user.handle)) : "";
  const qr = router ? safeUrl(router.qrPngDataUrl, true) : "";
  const provisioning = user.status === "provisioning";

  const statusBlock =
    user.status === "error"
      ? `<div class="error">Setup did not finish: ${escapeHtml(user.error ?? "unknown error")}. Submit the form again with the same handle to retry.</div>`
      : provisioning
        ? `<p class="hint">Your agent's machine is being prepared. This page refreshes on its own. You can text the connect command now; the first reply arrives once setup finishes.</p>`
        : `<p class="hint">Your agent is live. Text the command below once; after that, just talk.</p>`;

  const routerBlock = router
    ? `<p class="hint" style="margin-top:18px">1. Save or text this number</p>
<div class="number">${escapeHtml(router.number)}</div>
<p class="hint" style="margin-top:18px">2. Send exactly this</p>
<div class="code"><span id="cmd">${escapeHtml(command)}</span><button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('cmd').textContent).then(()=>{this.textContent='Copied'})">Copy</button></div>
${smsHref ? `<a class="btn" href="${smsHref}">Open Messages with it filled in</a>` : ""}
${qr ? `<p class="hint" style="text-align:center;margin-top:22px">Or scan from another device</p><img class="qr" alt="QR code that opens Messages with the connect command" src="${qr}">` : ""}`
    : `<div class="error">The router number could not be loaded right now. Reload in a minute.</div>`;

  return layout(
    `Connect @${user.handle}`,
    `<h1>Hi ${escapeHtml(user.name)}.</h1>
<p class="lead">Your Instinct is <b>@${escapeHtml(user.handle)}</b>. Connect it to your phone in two steps.</p>
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><b>Status</b>${statusPill(user)}</div>
  ${statusBlock}
  ${routerBlock}
</div>
<div class="card">
  <b>Connections</b>
  ${
    user.brainRepo
      ? `<p class="hint">Brain saved: <code>${escapeHtml(user.brainRepo)}</code>${user.brainToken ? " (private)" : ""}. Its files are pushed into your Instinct's machine.</p>`
      : `<p class="hint">Hand your Instinct a GitHub repo (public or private) — your handbook, notes or code — and it reads the files at setup.</p>`
  }
  ${
    user.postizKey
      ? `<p class="hint">Postiz key saved. Your agent can schedule and publish through your Postiz account.</p>`
      : `<p class="hint">Paste a Postiz public-API key so your agent can schedule and publish through your Postiz account.</p>`
  }
  <form method="post" action="/connect/${encodeURIComponent(user.id)}">
    <label for="brainRepo">Repo <small>owner/repo or a github.com URL; empty saves nothing</small></label>
    <input id="brainRepo" name="brainRepo" placeholder="acme/handbook" autocapitalize="off" autocorrect="off" spellcheck="false" value="${escapeHtml(user.brainRepo ?? "")}">
    <label for="brainToken">GitHub token <small>private repos only; leave empty to keep the saved one</small></label>
    <input id="brainToken" name="brainToken" type="password" autocomplete="off" value="">
    <label for="postizKey">Postiz API key <small>public API key; leave empty to keep the saved one</small></label>
    <input id="postizKey" name="postizKey" type="password" autocomplete="off" value="">
    ${
      user.postizKey
        ? `<label class="hint" style="display:block;margin:10px 0 0"><input type="checkbox" name="postizClear" value="on"> Remove the saved Postiz key</label>`
        : ""
    }
    <button class="btn" type="submit">Save connections</button>
  </form>
</div>
<h2>What happens next</h2>
<ol class="steps">
  <li><b>Inkbox links your phone</b> to @${escapeHtml(user.handle)} and the agent gets a message from you.</li>
  <li><b>Your agent introduces itself</b> and asks what you want it to know about you.</li>
  <li><b>Add people.</b> Say "Sam is my partner" or "invite Priya's Instinct" to build your trusted network.</li>
</ol>
<p class="hint">Bookmark this page: <a href="/connect/${encodeURIComponent(user.id)}">/connect/${escapeHtml(user.id)}</a></p>`,
    { refreshSeconds: provisioning ? 5 : undefined },
  );
}

/**
 * Shown when the phone or handle already belongs to a record. It says the same
 * thing whether or not an account exists, so the form cannot be used to check
 * who has an Instinct. The connect command is built from what the caller typed.
 */
export function renderPending(handle: string, router: ConnectRouter | undefined): string {
  const command = connectCommandFor(handle);
  const smsHref = router ? safeUrl(smsHrefFor(router.number, handle)) : "";
  const routerBlock = router
    ? `<p class="hint" style="margin-top:18px">Text this from the phone you entered</p>
<div class="code"><span>${escapeHtml(command)}</span></div>
<p class="hint">to <b>${escapeHtml(router.number)}</b></p>
${smsHref ? `<a class="btn" href="${smsHref}">Open Messages with it filled in</a>` : ""}`
    : "";
  return layout(
    "Check your phone",
    `<h1>Check your phone.</h1>
<p class="lead">If this number is new here, your Instinct is being set up. If it already has one, nothing changed.</p>
<div class="card">
  <p class="hint">Setup takes about a minute. Your Instinct replies on iMessage once it is ready. If you saved a connect link earlier, keep using that one.</p>
  ${routerBlock}
</div>`,
  );
}

/** Landing page after the Link OAuth redirect. The agent finishes the exchange; the person goes back to Messages. */
export function renderLinkDone(ok: boolean): string {
  return layout(
    ok ? "Connected" : "Not connected",
    ok
      ? `<h1>Connected.</h1><div class="card"><p>Your Link wallet is on its way to your Instinct. Go back to your messages; it will confirm there.</p></div>`
      : `<h1>Not connected.</h1><div class="card"><div class="error">The wallet connection could not be handed to your Instinct right now. Ask it to try again from your messages.</div></div>`,
  );
}

export function renderMessage(title: string, text: string, status: "ok" | "error" = "ok"): string {
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1><div class="card">${status === "error" ? `<div class="error">${escapeHtml(text)}</div>` : `<p>${escapeHtml(text)}</p>`}<p class="hint"><a href="/">Back to the start</a></p></div>`,
  );
}
