// account.js: the customer's own account area, meaning settings, tokens, help and support.
//
// One self-contained file: the router, the three page renders, and the small inline
// scripts that post them. Everything here is scoped to req.userId, so a demo workspace
// (an admin reading the target account) sees that account and nothing else.
//
// Contract (server.js mounts this):
//   export const accountRouter        express Router, every route guarded by requireUser.
//   GET  /account                     settings (name, agency, phone, default market)
//   GET  /account/tokens              balance, what a search costs, request + history
//   GET  /account/help                how it works, message the operator, history
//   GET  /api/account/me              who is signed in (the shell's account menu reads this)
//   GET  /api/account/replies         answered support messages (the shell's reply dot reads this)
//   POST /api/account/profile         partial patch of the settings fields
//   POST /api/account/tokens/request  {tokens, note}
//   POST /api/account/support         {subject, body}
import express from "express";
import * as store from "../data/store.js";
import { requireUser } from "./auth.js";
import { NICHES } from "../lib/niches.js";
import { RATE_PER_1K } from "../lib/spend.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar, FAVICON, icon } from "./shell.js";

export const accountRouter = express.Router();

// ── pricing, in the same tokens the meter and the search page speak ──────────
// The two numbers a customer actually spends against, derived from the same env the
// search page prices with, so the help copy can never quote a stale figure.
const TOKENS_PER_USD = parseFloat(process.env.TOKENS_PER_USD || "75") || 75;
const usdToTokens = (usd) => Math.max(0, Math.round((Number(usd) || 0) * TOKENS_PER_USD));
const SCAN_PLACES = 50;
const SCAN_TOKENS = usdToTokens((SCAN_PLACES / 1000) * RATE_PER_1K);
const GUARANTEED_FIVE_TOKENS = Math.max(0, parseInt(process.env.GUARANTEED_FIVE_TOKENS || "60", 10) || 0);

// What the operator sells, for the read-only plan line. Mirrors admin.js's plan list;
// an unknown tier just shows itself.
const PLAN_LABELS = {
  prospect: "Prospect (demo)",
  trial: "Trial",
  starter: "Starter",
  pro: "Pro",
  unlimited: "Unlimited",
  local: "Local",
};

// A request for a million tokens is a typo, not an order.
const TOKENS_MAX = 1000000;
// Long enough for a real answer, short enough that no single row can flood the table.
const FIELD_MAX = 200;
const SUBJECT_MAX = 200;
const BODY_MAX = 4000;
const NOTE_MAX = 1000;

// ── small helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])
  );
}

const num = (n) => (Number(n) || 0).toLocaleString("en-US");

// SQLite writes "2026-08-27 14:03:11" (UTC, no marker); Supabase writes ISO. Both land
// as "Aug 27, 2026"; anything unparseable is shown as it came.
function fmtDate(v) {
  if (!v) return "";
  const s = String(v);
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// One comparable timestamp for a reply, or "" when there isn't one. SQLite stores
// "2026-08-27 14:03:11" (UTC, no marker) and Supabase stores ISO, and the browser holds
// the newest reply it has seen as a single string, so both formats have to land on the
// same shape or a plain string compare would read the wrong way round. The API and the
// help page both go through here, so the value the page stores is the value the API
// compares against.
function repliedIso(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (!s) return "";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

// An answered message with a reply timestamp: what the shell counts, and the same set
// the help page treats as seen once it has rendered them.
function isAnsweredReply(m) {
  return String(m?.status || "").toLowerCase() === "answered" && !!repliedIso(m?.repliedAt);
}

function planLabel(profile) {
  const tier = String(profile?.tier || "").trim();
  const allot = Number.parseInt(profile?.monthly_token_allotment, 10);
  const tokens = Number.isFinite(allot) && allot > 0 ? allot : 0;
  const label = PLAN_LABELS[tier] || (tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "");
  if (!tokens) return label ? `${label}, no tokens assigned yet` : "No plan yet";
  return `${label || "Plan"}, ${num(tokens)} tokens a month`;
}

// The user's tokens for this calendar month, the same arithmetic /api/usage does.
async function tokenState(userId) {
  const [usage, profile] = await Promise.all([store.usageSummary(userId), store.getProfile(userId)]);
  const raw = Number.parseInt(profile?.monthly_token_allotment, 10);
  const allotment = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const used = usdToTokens(usage.aiUsd || 0);
  return { profile, allotment, used, left: Math.max(0, allotment - used), searches: usage.searches || 0 };
}

// One validated settings string, or an Error the route turns into a 400.
function cleanText(value, label, max) {
  if (value === undefined) return undefined; // absent key = not part of this patch
  if (value === null) return "";
  if (typeof value !== "string") throw bad(`Send ${label} as text.`);
  const s = value.trim();
  if (s.length > max) throw bad(`Keep ${label} to ${max} characters or fewer.`);
  return s;
}

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Every write route answers the same way: a clear sentence and the right status. The
// store throws its own 400s (empty subject, non-integer tokens), so they pass straight through.
function fail(res, e) {
  const status = Number(e?.status) === 400 ? 400 : 500;
  const error = status === 400 ? e.message : "Something went wrong. Try again.";
  res.status(status).json({ ok: false, error });
}

// ── page chrome ──────────────────────────────────────────────────────────────
// The account pages are not sidebar destinations, so sidebar() is given a key no nav
// item uses ("account") and nothing in the rail lights up.
function tabs(active) {
  const tab = (href, key, label) =>
    `<a class="tab${active === key ? " active" : ""}" href="${href}">${label}</a>`;
  return `<div class="tabs">${tab("/account", "settings", "Settings")}${tab(
    "/account/tokens",
    "tokens",
    "Tokens"
  )}${tab("/account/help", "help", "Help and support")}</div>`;
}

const ACCOUNT_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .tabs{display:flex;gap:8px;margin:0 0 20px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14px;border-radius:9px;padding:9px 16px}
  .acol{display:flex;flex-direction:column;gap:18px;max-width:780px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:22px 24px}
  .card h2{font-size:15px;font-weight:800;color:var(--text);letter-spacing:.1px}
  .card .hint{font-size:13px;color:var(--muted);line-height:1.6;margin-top:6px}
  .card .hint b{color:var(--text);font-weight:600}
  .fields{display:grid;gap:15px;margin-top:18px}
  .fields.two{grid-template-columns:1fr 1fr}
  .fields.where{grid-template-columns:1fr 120px}
  .f{min-width:0}
  .f label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
  .f input,.f select,.f textarea{width:100%;border-radius:8px;padding:10px 12px;font-family:inherit;font-size:14px}
  .f textarea{min-height:130px;resize:vertical;line-height:1.55}
  .f .sub{font-size:11.5px;color:var(--faint);margin-top:5px;line-height:1.45}
  .ro{border-radius:8px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);font-size:14px;color:var(--text);word-break:break-word}
  .ro .rosub{font-size:11.5px;color:var(--muted);margin-top:3px}
  .saverow{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:20px;padding-top:18px;border-top:1px solid var(--border)}
  .savebtn{background:var(--accent);color:var(--on-accent);border:none;border-radius:8px;padding:11px 22px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer}
  .savebtn:hover{filter:brightness(.96)}
  .savebtn:disabled{opacity:.55;cursor:wait}
  .msg{font-size:13px;font-weight:600;line-height:1.45;min-height:17px}
  .msg.ok{color:var(--accent-ink)}
  .msg.err{color:var(--danger)}
  .bal{display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-top:16px}
  .bal .big{font-size:30px;font-weight:800;color:var(--text);line-height:1.1;font-variant-numeric:tabular-nums}
  .bal .of{font-size:13px;color:var(--muted);font-weight:600}
  .warnline{color:var(--warn);font-weight:700}
  .costs{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}
  .cost{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
  .cost .n{font-size:19px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums}
  .cost .l{font-size:13px;color:var(--text);font-weight:600;margin-top:3px}
  .cost .s{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5}
  .points{list-style:none;margin-top:14px;display:flex;flex-direction:column;gap:11px}
  .points li{position:relative;padding-left:16px;font-size:13.5px;color:var(--muted);line-height:1.6}
  .points li::before{content:"";position:absolute;left:0;top:8px;width:6px;height:6px;border-radius:50%;background:var(--accent)}
  .points b{color:var(--text);font-weight:600}
  .histhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .histhead h2{font-size:15px;font-weight:800;color:var(--text)}
  .histhead .c{font-size:12.5px;color:var(--muted)}
  .tblwrap{overflow-x:auto;border-radius:12px}
  table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden;min-width:560px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:12px 14px;white-space:nowrap}
  td{padding:12px 14px;font-size:14px;vertical-align:top;line-height:1.5}
  tr:last-child td{border-bottom:none}
  td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  th.n{text-align:right}
  td.d{color:var(--muted);white-space:nowrap}
  .status{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;border-radius:6px;padding:3px 8px;background:var(--surface2);color:var(--muted);border:1px solid var(--border);white-space:nowrap}
  .status.pending,.status.open{background:var(--warn-weak);color:var(--warn);border-color:transparent}
  .status.approved,.status.answered{background:var(--accent-weak);color:var(--accent-ink);border-color:transparent}
  .status.declined{color:var(--danger);border-color:var(--danger)}
  .anote{font-size:12.5px;color:var(--muted);margin-top:6px;line-height:1.5}
  .msgbody{color:var(--muted);font-size:13px;margin-top:5px;line-height:1.55;white-space:pre-wrap}
  .msgsub{font-weight:700;color:var(--text)}
  .reply{margin-top:10px;border-left:2px solid var(--accent);background:var(--accent-weak);border-radius:0 8px 8px 0;padding:9px 12px}
  .reply .rk{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--accent-ink)}
  .reply .rb{font-size:13.5px;color:var(--text);margin-top:3px;line-height:1.55;white-space:pre-wrap}
  /* An answer that arrived since the last visit. Added on load by the script below, so a
     page with nothing new renders exactly as it always did. */
  .reply.new{border-left-width:4px;padding-left:14px}
  .reply .rtag{display:inline-block;margin-left:8px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;border-radius:5px;padding:2px 6px;background:var(--accent);color:var(--on-accent);vertical-align:1px}
  .empty{color:var(--muted);font-size:14px;padding:18px 2px}
  @media(max-width:620px){.fields.two,.fields.where,.costs{grid-template-columns:1fr}}
`;

function page({ req, title, h1, sub, active, body, script = "" }) {
  return `<!doctype html><html lang="en"><head>${THEME_INIT_SCRIPT}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${FAVICON}<title>Prospector · ${esc(title)}</title>
<style>${ACCOUNT_CSS}${SHARED_CSS}</style></head><body>
${sidebar("account", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>${esc(h1)}</h1><div class="pagesub">${esc(sub)}</div></div><div class="spacer"></div></div>
${tabs(active)}
${body}
${script}${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

// The one client helper every account page uses.
const POST_JS = `async function post(url,data){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});try{return await r.json()}catch(e){return {ok:false,error:'Something went wrong. Try again.'}}}
function val(id){var el=document.getElementById(id);return el?el.value.trim():''}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}`;

// ── settings ─────────────────────────────────────────────────────────────────

function field(id, label, value, { placeholder = "", sub = "", max = FIELD_MAX } = {}) {
  return `<div class="f"><label for="${id}">${esc(label)}</label><input id="${id}" type="text" maxlength="${max}" value="${esc(
    value || ""
  )}" placeholder="${esc(placeholder)}" autocomplete="off">${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
}

function nicheSelect(value) {
  const current = String(value || "");
  const keys = NICHES.map((n) => n.key);
  const options = [`<option value=""${current ? "" : " selected"}>No default</option>`];
  if (current && !keys.includes(current)) options.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  for (const k of keys) {
    options.push(`<option value="${esc(k)}"${k === current ? " selected" : ""}>${esc(k)}</option>`);
  }
  return `<div class="f"><label for="fNiche">Default trade</label><select id="fNiche">${options.join("")}</select></div>`;
}

function renderSettings(req, profile) {
  const body = `<div class="acol">
  <div class="card">
    <h2>Your details</h2>
    <div class="hint">The name we use when we write back to you, and how to reach you.</div>
    <div class="fields two">
      ${field("fFullName", "Full name", profile.fullName, { placeholder: "Kyle Bennett" })}
      ${field("fAgency", "Agency name", profile.agencyName, { placeholder: "Bennett Web Studio" })}
    </div>
    <div class="fields">
      ${field("fPhone", "Phone", profile.phone, { placeholder: "555 123 4567", max: 40 })}
    </div>
  </div>

  <div class="card">
    <h2>Your market</h2>
    <div class="hint">This is the city, state and trade every search starts on, so you can open the search page and go straight to <b>Scan</b> without retyping your patch. You can still change any of it for a one off search.</div>
    <div class="fields where">
      ${field("fCity", "Default city", profile.defaultCity, { placeholder: "Austin" })}
      ${field("fState", "Default state", profile.defaultState, { placeholder: "TX", max: 2 })}
    </div>
    <div class="fields">
      ${nicheSelect(profile.defaultNiche)}
    </div>
    <div class="saverow">
      <button class="savebtn" id="saveBtn" type="button">Save changes</button>
      <div class="msg" id="saveMsg" role="status" aria-live="polite"></div>
    </div>
  </div>

  <div class="card">
    <h2>Account</h2>
    <div class="hint">These are set by us, not by you. Ask us to change your plan.</div>
    <div class="fields two">
      <div class="f"><label>Email</label><div class="ro">${esc(profile.email || req.userEmail || "")}<div class="rosub">Sign in address</div></div></div>
      <div class="f"><label>Plan</label><div class="ro">${esc(planLabel(profile))}<div class="rosub">Tokens refill on the 1st</div></div></div>
    </div>
  </div>
</div>`;

  const script = `<script>
${POST_JS}
var FIELDS=[['fFullName','fullName'],['fAgency','agencyName'],['fPhone','phone'],['fCity','defaultCity'],['fState','defaultState'],['fNiche','defaultNiche']];
// The saved profile comes back from the POST, so the form repaints from what the database
// actually holds (trimmed, cleared fields emptied) instead of from what was typed.
function paint(p){if(!p)return;for(var i=0;i<FIELDS.length;i++){var el=document.getElementById(FIELDS[i][0]);if(el)el.value=p[FIELDS[i][1]]||''}}
async function saveProfile(){
  var btn=document.getElementById('saveBtn'),msg=document.getElementById('saveMsg');
  var body={};for(var i=0;i<FIELDS.length;i++){body[FIELDS[i][1]]=val(FIELDS[i][0])}
  btn.disabled=true;msg.className='msg';msg.textContent='Saving your settings';
  var r=await post('/api/account/profile',body);
  btn.disabled=false;
  if(!r||!r.ok){msg.className='msg err';msg.textContent=(r&&r.error)||'Could not save your settings.';return}
  paint(r.profile);
  msg.className='msg ok';msg.textContent='Saved.';
}
document.getElementById('saveBtn').addEventListener('click',saveProfile);
</script>`;

  return page({
    req,
    title: "Settings",
    h1: "Settings",
    sub: "Your details and the market every search starts from",
    active: "settings",
    body,
    script,
  });
}

// ── tokens ───────────────────────────────────────────────────────────────────

function requestRow(r) {
  const status = String(r.status || "pending").toLowerCase();
  const granted = r.tokensGranted === null || r.tokensGranted === undefined ? "" : num(r.tokensGranted);
  const price =
    r.priceUsd === null || r.priceUsd === undefined
      ? ""
      : "$" + Number(r.priceUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<tr>
    <td class="d">${esc(fmtDate(r.createdAt))}</td>
    <td class="n">${num(r.tokensRequested)}</td>
    <td><span class="status ${esc(status)}">${esc(status)}</span>${
      r.note ? `<div class="anote">${esc(r.note)}</div>` : ""
    }${r.adminNote ? `<div class="anote"><b>Our note:</b> ${esc(r.adminNote)}</div>` : ""}</td>
    <td class="n">${granted || '<span class="muted">not yet</span>'}</td>
    <td class="n">${price || '<span class="muted">not yet</span>'}</td>
  </tr>`;
}

function renderTokens(req, { allotment, used, left, searches }, requests) {
  const scans = SCAN_TOKENS > 0 ? Math.floor(left / SCAN_TOKENS) : 0;
  const rows = requests.map(requestRow).join("");
  const body = `<div class="acol">
  <div class="card">
    <h2>Tokens this month</h2>
    <div class="bal">
      <div><div class="big" id="balLeft">${num(left)}</div><div class="of">tokens left${
        allotment ? ` of ${num(allotment)}` : ""
      }</div></div>
      <div><div class="big">${num(used)}</div><div class="of">used so far${
        searches ? `, ${num(searches)} searches` : ""
      }</div></div>
    </div>
    ${
      allotment
        ? `<div class="hint">That is about <b>${num(scans)}</b> more scans of ${SCAN_PLACES} businesses this month. Tokens refill on the 1st.</div>`
        : `<div class="hint warnline">Your account does not have a plan yet, so searching is locked. Ask us for tokens below and we will set you up.</div>`
    }
    <div class="costs">
      <div class="cost"><div class="n">${num(SCAN_TOKENS)}</div><div class="l">Scan ${SCAN_PLACES} businesses</div><div class="s">The everyday search. Looks at ${SCAN_PLACES} places in one city and keeps the ones with no website.</div></div>
      <div class="cost"><div class="n">${num(GUARANTEED_FIVE_TOKENS)}</div><div class="l">Guaranteed 5 companies</div><div class="s">Keeps looking until it has 5 companies with no website, at one flat price.</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Ask for more tokens</h2>
    <div class="hint">Tell us how many you want and what you are working on. <b>An admin reviews every request and confirms the price with you before anything is charged.</b> Nothing is billed from this page.</div>
    <div class="fields where">
      <div class="f"><label for="tNote">What do you need them for <span class="muted">optional</span></label><input id="tNote" type="text" maxlength="${NOTE_MAX}" placeholder="Working two new cities this month" autocomplete="off"></div>
      <div class="f"><label for="tTokens">Tokens</label><input id="tTokens" type="number" min="1" step="1" max="${TOKENS_MAX}" placeholder="500"></div>
    </div>
    <div class="saverow">
      <button class="savebtn" id="reqBtn" type="button">Send request</button>
      <div class="msg" id="reqMsg" role="status" aria-live="polite"></div>
    </div>
  </div>

  <div>
    <div class="histhead"><h2>Your requests</h2><span class="c" id="reqCount">${
      requests.length ? `${requests.length} request${requests.length === 1 ? "" : "s"}` : ""
    }</span></div>
    <div class="tblwrap">
      <table id="reqTable"${rows ? "" : ' style="display:none"'}>
        <thead><tr><th>Sent</th><th class="n">Asked for</th><th>Status</th><th class="n">Granted</th><th class="n">Price</th></tr></thead>
        <tbody id="reqRows">${rows}</tbody>
      </table>
    </div>
    <div class="empty" id="reqEmpty"${rows ? ' style="display:none"' : ""}>You have not asked for extra tokens yet.</div>
  </div>
</div>`;

  const script = `<script>
${POST_JS}
async function sendRequest(){
  var btn=document.getElementById('reqBtn'),msg=document.getElementById('reqMsg');
  var tokens=val('tTokens'),note=val('tNote');
  msg.className='msg';msg.textContent='';
  if(!tokens){msg.className='msg err';msg.textContent='Enter how many tokens you need.';document.getElementById('tTokens').focus();return}
  btn.disabled=true;msg.textContent='Sending your request';
  var r=await post('/api/account/tokens/request',{tokens:tokens,note:note});
  btn.disabled=false;
  if(!r||!r.ok){msg.className='msg err';msg.textContent=(r&&r.error)||'Could not send that request.';return}
  var tr=document.createElement('tr');
  tr.innerHTML='<td class="d">'+esc(r.request.createdAt)+'</td>'+
    '<td class="n">'+Number(r.request.tokensRequested).toLocaleString()+'</td>'+
    '<td><span class="status pending">pending</span>'+(r.request.note?'<div class="anote">'+esc(r.request.note)+'</div>':'')+'</td>'+
    '<td class="n"><span class="muted">not yet</span></td>'+
    '<td class="n"><span class="muted">not yet</span></td>';
  var tb=document.getElementById('reqRows');tb.insertBefore(tr,tb.firstChild);
  document.getElementById('reqTable').style.display='';
  document.getElementById('reqEmpty').style.display='none';
  var n=tb.children.length;document.getElementById('reqCount').textContent=n+' request'+(n===1?'':'s');
  document.getElementById('tTokens').value='';document.getElementById('tNote').value='';
  msg.className='msg ok';msg.textContent='Sent. We will review it and confirm the price before anything is charged.';
}
document.getElementById('reqBtn').addEventListener('click',sendRequest);
</script>`;

  return page({
    req,
    title: "Tokens",
    h1: "Tokens",
    sub: "What you have left, what a search costs, and how to ask for more",
    active: "tokens",
    body,
    script,
  });
}

// ── help and support ─────────────────────────────────────────────────────────

function messageRow(m) {
  const status = String(m.status || "open").toLowerCase();
  return `<tr>
    <td class="d">${esc(fmtDate(m.createdAt))}</td>
    <td>
      <div class="msgsub">${esc(m.subject)}</div>
      <div class="msgbody">${esc(m.body)}</div>
      ${
        m.adminReply
          ? `<div class="reply"${
              isAnsweredReply(m) ? ` data-replied="${esc(repliedIso(m.repliedAt))}"` : ""
            }><div class="rk">Our reply${
              m.repliedAt ? `, ${esc(fmtDate(m.repliedAt))}` : ""
            }</div><div class="rb">${esc(m.adminReply)}</div></div>`
          : ""
      }
    </td>
    <td><span class="status ${esc(status)}">${esc(status)}</span></td>
  </tr>`;
}

function renderHelp(req, messages) {
  const rows = messages.map(messageRow).join("");
  const body = `<div class="acol">
  <div class="card">
    <h2>How this works</h2>
    <ul class="points">
      <li><b>What a search costs.</b> A scan of ${SCAN_PLACES} businesses in one city costs <b>${num(
        SCAN_TOKENS
      )} tokens</b>. A guaranteed 5 companies search costs <b>${num(
        GUARANTEED_FIVE_TOKENS
      )} tokens</b> flat, because it keeps looking until it has five. Your plan refills on the 1st.</li>
      <li><b>The three company lists.</b> Everything a search finds is filed for you. <b>No website companies</b> are the ones with no site that are still posting, so call those first. <b>Not active</b> are the ones with no site that have gone quiet, good backups for a slow week. <b>Has a website</b> already have one, worth a rebuild pitch when you have room.</li>
      <li><b>Follow ups live on the Companies page.</b> Set a call back date on any company there and it moves into that list's follow up view, so nothing sits forgotten.</li>
      <li><b>Tokens and plans.</b> Ask for more on the <a href="/account/tokens">Tokens page</a>. An admin confirms the price with you before anything is charged.</li>
    </ul>
  </div>

  <div class="card">
    <h2>Message us</h2>
    <div class="hint">Anything that is not working, or anything you want the tool to do. We answer in here, and you will see the reply on this page.</div>
    <div class="fields">
      <div class="f"><label for="mSubject">Subject</label><input id="mSubject" type="text" maxlength="${SUBJECT_MAX}" placeholder="A search came back empty" autocomplete="off"></div>
      <div class="f"><label for="mBody">Message</label><textarea id="mBody" maxlength="${BODY_MAX}" placeholder="Tell us what happened, and which city and trade you searched."></textarea></div>
    </div>
    <div class="saverow">
      <button class="savebtn" id="msgBtn" type="button">Send message</button>
      <div class="msg" id="msgMsg" role="status" aria-live="polite"></div>
    </div>
  </div>

  <div>
    <div class="histhead"><h2>Your messages</h2><span class="c" id="msgCount">${
      messages.length ? `${messages.length} message${messages.length === 1 ? "" : "s"}` : ""
    }</span></div>
    <div class="tblwrap">
      <table id="msgTable"${rows ? "" : ' style="display:none"'}>
        <thead><tr><th>Sent</th><th>Message</th><th>Status</th></tr></thead>
        <tbody id="msgRows">${rows}</tbody>
      </table>
    </div>
    <div class="empty" id="msgEmpty"${rows ? ' style="display:none"' : ""}>You have not written to us yet.</div>
  </div>
</div>`;

  const script = `<script>
${POST_JS}
async function sendMessage(){
  var btn=document.getElementById('msgBtn'),msg=document.getElementById('msgMsg');
  var subject=val('mSubject'),body=val('mBody');
  msg.className='msg';msg.textContent='';
  if(!subject){msg.className='msg err';msg.textContent='Add a subject.';document.getElementById('mSubject').focus();return}
  if(!body){msg.className='msg err';msg.textContent='Add a message.';document.getElementById('mBody').focus();return}
  btn.disabled=true;msg.textContent='Sending your message';
  var r=await post('/api/account/support',{subject:subject,body:body});
  btn.disabled=false;
  if(!r||!r.ok){msg.className='msg err';msg.textContent=(r&&r.error)||'Could not send that message.';return}
  var tr=document.createElement('tr');
  tr.innerHTML='<td class="d">'+esc(r.message.createdAt)+'</td>'+
    '<td><div class="msgsub">'+esc(r.message.subject)+'</div><div class="msgbody">'+esc(r.message.body)+'</div></td>'+
    '<td><span class="status open">open</span></td>';
  var tb=document.getElementById('msgRows');tb.insertBefore(tr,tb.firstChild);
  document.getElementById('msgTable').style.display='';
  document.getElementById('msgEmpty').style.display='none';
  var n=tb.children.length;document.getElementById('msgCount').textContent=n+' message'+(n===1?'':'s');
  document.getElementById('mSubject').value='';document.getElementById('mBody').value='';
  msg.className='msg ok';msg.textContent='We got it. Replies show up right here, and a dot on your avatar will let you know.';
}
document.getElementById('msgBtn').addEventListener('click',sendMessage);
// Reading the page is what counts as reading the answers. Each answered reply carries the
// timestamp the API compares against, so this marks the ones that were new since the last
// visit and then stores the newest of them, which clears the avatar dot everywhere. The
// mark only ever moves forward, so a deleted message cannot rewind it and make old answers
// look new again. The shell's own check runs after this and reads what it wrote, so the
// dot never lingers on the page that just cleared it.
(function(){
  try{
    var seen='';try{seen=String(localStorage.getItem('lm_replies_seen')||'');}catch(e){}
    var blocks=document.querySelectorAll('.reply[data-replied]'),max='';
    for(var i=0;i<blocks.length;i++){
      var t=blocks[i].getAttribute('data-replied')||'';
      if(!t)continue;
      if(t>max)max=t;
      if(seen&&t<=seen)continue;
      blocks[i].className='reply new';
      var k=blocks[i].querySelector('.rk');
      if(k){var tag=document.createElement('span');tag.className='rtag';tag.textContent='new';k.appendChild(tag);}
    }
    if(max&&(!seen||max>seen)){try{localStorage.setItem('lm_replies_seen',max);}catch(e){}}
  }catch(e){}
})();
</script>`;

  return page({
    req,
    title: "Help and support",
    h1: "Help and support",
    sub: "How the tool works, and a direct line to us",
    active: "help",
    body,
    script,
  });
}

// ── routes ───────────────────────────────────────────────────────────────────
// requireUser is applied per route (the same shape admin.js uses) so the router is safe
// to mount anywhere in server.js without changing what any other route sees.

accountRouter.get("/account", requireUser, async (req, res, next) => {
  try {
    res.send(renderSettings(req, await store.getProfile(req.userId)));
  } catch (e) {
    next(e);
  }
});

accountRouter.get("/account/tokens", requireUser, async (req, res, next) => {
  try {
    const [state, requests] = await Promise.all([tokenState(req.userId), store.listTokenRequests(req.userId)]);
    res.send(renderTokens(req, state, requests));
  } catch (e) {
    next(e);
  }
});

accountRouter.get("/account/help", requireUser, async (req, res, next) => {
  try {
    res.send(renderHelp(req, await store.listSupportMessages(req.userId)));
  } catch (e) {
    next(e);
  }
});

// Who is signed in, for the shell's account menu. The plan label is the same sentence
// the settings page shows, so the two never drift.
accountRouter.get("/api/account/me", requireUser, async (req, res) => {
  try {
    const p = await store.getProfile(req.userId);
    res.json({
      ok: true,
      email: p.email || req.userEmail || "",
      fullName: p.fullName || "",
      agencyName: p.agencyName || "",
      tier: p.tier || "",
      planLabel: planLabel(p),
      isDemo: !!req.isDemo,
    });
  } catch (e) {
    fail(res, e);
  }
});

// The answers waiting for this customer, for the shell's account menu. Ids and reply
// timestamps only: the menu needs a count and a high-water mark, never the message text,
// and this is read on every page load. Newest first, capped, because a menu that says
// "50 answers waiting" and one that says "300" mean the same thing to a reader.
const REPLIES_MAX = 50;

accountRouter.get("/api/account/replies", requireUser, async (req, res) => {
  try {
    const messages = await store.listSupportMessages(req.userId);
    const replies = messages
      .filter(isAnsweredReply)
      .map((m) => ({ id: Number(m.id), repliedAt: repliedIso(m.repliedAt) }))
      .sort((a, b) => (a.repliedAt < b.repliedAt ? 1 : a.repliedAt > b.repliedAt ? -1 : 0))
      .slice(0, REPLIES_MAX);
    res.json({ ok: true, replies });
  } catch (e) {
    fail(res, e);
  }
});

// Partial patch: only the keys sent are written, and an empty string clears one.
accountRouter.post("/api/account/profile", requireUser, async (req, res) => {
  try {
    const b = req.body;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("Send your settings as a JSON object.");
    const patch = {};
    const put = (key, label, max = FIELD_MAX) => {
      const v = cleanText(b[key], label, max);
      if (v !== undefined) patch[key] = v;
    };
    put("fullName", "your full name");
    put("agencyName", "your agency name");
    put("phone", "your phone number", 40);
    put("defaultCity", "your default city");
    put("defaultState", "your default state", 2);
    put("defaultNiche", "your default trade");
    if (!Object.keys(patch).length) throw bad("Send at least one setting to save.");
    const profile = await store.updateProfile(req.userId, patch);
    res.json({ ok: true, profile });
  } catch (e) {
    fail(res, e);
  }
});

accountRouter.post("/api/account/tokens/request", requireUser, async (req, res) => {
  try {
    const { tokens, note } = req.body || {};
    const raw = typeof tokens === "string" ? tokens.trim() : tokens;
    const n = typeof raw === "number" || (typeof raw === "string" && raw !== "") ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n <= 0) throw bad("Ask for a whole number of tokens, at least 1.");
    if (n > TOKENS_MAX) throw bad(`Ask for ${num(TOKENS_MAX)} tokens or fewer.`);
    const text = cleanText(note === undefined || note === null ? "" : note, "your note", NOTE_MAX) || "";
    const { id } = await store.createTokenRequest(req.userId, { tokens: n, note: text });
    res.json({
      ok: true,
      id,
      request: { id, tokensRequested: n, note: text, status: "pending", createdAt: fmtDate(new Date().toISOString()) },
    });
  } catch (e) {
    fail(res, e);
  }
});

accountRouter.post("/api/account/support", requireUser, async (req, res) => {
  try {
    const { subject, body } = req.body || {};
    const s = cleanText(subject === undefined || subject === null ? "" : subject, "your subject", SUBJECT_MAX) || "";
    const b = cleanText(body === undefined || body === null ? "" : body, "your message", BODY_MAX) || "";
    if (!s) throw bad("Add a subject.");
    if (!b) throw bad("Add a message.");
    const { id } = await store.createSupportMessage(req.userId, { subject: s, body: b });
    res.json({
      ok: true,
      id,
      message: { id, subject: s, body: b, status: "open", createdAt: fmtDate(new Date().toISOString()) },
    });
  } catch (e) {
    fail(res, e);
  }
});

export default accountRouter;
