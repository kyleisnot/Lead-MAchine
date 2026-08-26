// admin.js — the operator admin panel (Agent C).
//
// One self-contained file: the router, the page render, and the small inline
// script that posts per-user plan edits, top-ups and usage resets.
//
// This is the ONE place cross-user queries are allowed. Every other module
// scopes by req.userId; here the operator deliberately looks across all users,
// so we go straight to the service-role client from lib/supabase.js.
//
// Contract (see the MVP spec, section 6):
//   export const adminRouter   — express Router, all paths under /admin,
//                                every route guarded by requireUser + requireAdmin.
//   GET  /admin                            — operator overview (stat cards + users table)
//   POST /admin/api/user/:id               — {tier, monthly_token_allotment} → updates profiles
//   POST /admin/api/user/:id/topup         — {tokens} → adds N to monthly_token_allotment
//   POST /admin/api/user/:id/reset-usage   — clears THIS calendar month's usage_log rows
import express from "express";
import { requireUser, requireAdmin } from "./auth.js";
import { dataProvider, getSupabase } from "../lib/supabase.js";
import { apifySpend } from "../lib/spend.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar, FAVICON } from "./shell.js";

export const adminRouter = express.Router();

// ── plans: the single source of truth for what the operator sells ────────────
// `tokens` is the monthly allotment the plan implies. 0 means NO TOKENS (a
// not-yet-activated account is blocked until an admin assigns a plan); "Unlimited"
// is just a very high cap. `price` is USD per month, 0 for non-paying plans.
// `prospect` is the near-nothing plan demo-created accounts sit on.
const PLANS = {
  prospect: { label: "Prospect (demo)", tokens: 1, price: 0 },
  trial: { label: "Trial", tokens: 300, price: 0 },
  starter: { label: "Starter", tokens: 2000, price: 97 },
  pro: { label: "Pro", tokens: 6000, price: 297 },
  unlimited: { label: "Unlimited", tokens: 100000, price: 997 },
};
const PLAN_KEYS = Object.keys(PLANS);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A top-up has to be a real number of tokens, not a typo that silently gifts a
// customer a million credits (or an integer-column overflow).
const TOPUP_MIN = 1;
const TOPUP_MAX = 1000000;
const ALLOTMENT_MAX = 1000000000; // stays inside a postgres int4

// PostgREST caps un-ranged selects at 1000 rows — ask for more explicitly.
const MAX_ROWS = 4999;

// ── small helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Credits are the user-facing unit; usage_log.cost is stored in USD. Deliberately
// not a 1:1 cent mapping — see deploy-env.js.
function tokensPerUsd() {
  const n = parseFloat(process.env.TOKENS_PER_USD || "75");
  return Number.isFinite(n) && n > 0 ? n : 75;
}

// Start of the current calendar month, server-local, as an ISO timestamp.
function firstOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

// The staged demo workspace's address (same rule auth.js uses). Computed here
// rather than imported so the admin panel keeps rendering even if the auth
// module's exports move.
function demoEmailAddress() {
  const e = String(process.env.DEMO_EMAIL || "").trim();
  return (e || "demo-workspace@leadmachine.internal").toLowerCase();
}

function num(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function fmtDate(v) {
  if (!v) return "n/a";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "n/a";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The plan record for a tier string, or null when the DB holds something we
// don't sell (a hand-edited or legacy tier). Never coerces — the caller decides.
function planFor(tier) {
  return PLANS[String(tier || "").toLowerCase()] || null;
}

function priceOf(tier) {
  const p = planFor(tier);
  return p ? p.price : 0; // unknown tiers count as $0 toward MRR
}

// Accepts a plan key, or any reasonable existing tier string so a row whose DB
// tier we don't sell can still be saved untouched. Returns null if unusable.
function normalizeTier(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (PLANS[lower]) return lower;
  if (raw.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(raw)) return raw;
  return null;
}

// Scan order: paying customers first, then trials (and any custom tier), then
// the demo/prospect accounts. Newest signup first inside each group.
function sortGroup(u) {
  if (u.isDemoAccount) return 2;
  const tier = String(u.tier || "").toLowerCase();
  if (tier === "prospect") return 2;
  if (priceOf(tier) > 0) return 0;
  return 1;
}

// Throws on a PostgREST error so the route's try/catch can show one clean message.
function unwrap(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res;
}

// Run an async fn over a list with a small concurrency cap (a handful of users
// at MVP scale, but this keeps the query burst bounded as that grows).
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── data ─────────────────────────────────────────────────────────────────────

// Everything the overview needs, in one shot. Counts use head:true count
// queries (cheap, no row transfer); the month's usage rows are fetched ranged
// and summed in JS since PostgREST has no sum() without a view.
async function loadOverview() {
  const sb = await getSupabase();
  const since = firstOfMonthISO();
  const demoAddr = demoEmailAddress();

  const [profilesRes, userCountRes, leadCountRes] = await Promise.all([
    sb
      .from("profiles")
      .select("id,email,tier,monthly_token_allotment,created_at")
      .order("created_at", { ascending: false })
      .range(0, MAX_ROWS),
    sb.from("profiles").select("*", { count: "exact", head: true }),
    sb.from("leads").select("*", { count: "exact", head: true }),
  ]);

  const profiles = unwrap(profilesRes, "profiles").data || [];
  const totalUsers = unwrap(userCountRes, "user count").count ?? profiles.length;
  const totalLeads = unwrap(leadCountRes, "lead count").count ?? 0;

  const users = await mapPool(profiles, 6, async (p) => {
    const [leadsRes, savedRes, usageRes, lastRes] = await Promise.all([
      sb.from("leads").select("*", { count: "exact", head: true }).eq("user_id", p.id),
      sb
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("user_id", p.id)
        .eq("saved", true),
      sb.from("usage_log").select("cost").eq("user_id", p.id).gte("at", since).range(0, MAX_ROWS),
      sb
        .from("usage_log")
        .select("at")
        .eq("user_id", p.id)
        .order("at", { ascending: false })
        .limit(1),
    ]);

    const costUsd = (unwrap(usageRes, "usage").data || []).reduce(
      (a, r) => a + (Number(r.cost) || 0),
      0
    );
    const rawTier = String(p.tier ?? "").trim();
    const email = p.email || "No email on file";
    return {
      id: p.id,
      email,
      // Known plans are normalized to their key; anything else is kept verbatim.
      tier: rawTier ? (PLANS[rawTier.toLowerCase()] ? rawTier.toLowerCase() : rawTier) : "trial",
      allotment: Number(p.monthly_token_allotment ?? 0),
      createdAt: p.created_at,
      leads: unwrap(leadsRes, "user lead count").count ?? 0,
      saved: unwrap(savedRes, "user saved count").count ?? 0,
      costUsd,
      tokens: Math.round(costUsd * tokensPerUsd()),
      lastUsage: (unwrap(lastRes, "last usage").data || [])[0]?.at || null,
      isDemoAccount: String(p.email || "").toLowerCase() === demoAddr,
    };
  });

  // Paying first, then trial/custom, then demo + prospect — newest-first inside
  // each group. The profiles query already came back newest-first, so a stable
  // sort on the group alone preserves that ordering.
  users.sort((a, b) => {
    const g = sortGroup(a) - sortGroup(b);
    if (g) return g;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  // The month total is summed from the per-user numbers so the card and the
  // table can never disagree (and so no single global fetch has to page).
  const monthUsd = users.reduce((a, u) => a + u.costUsd, 0);

  // MRR + the paying-plan mix behind it.
  const mix = {};
  let mrr = 0;
  for (const u of users) {
    const price = priceOf(u.tier);
    // The staged demo workspace sits on `starter` so it presents like a real
    // customer — it must not be counted as revenue.
    if (price > 0 && !u.isDemoAccount) {
      mrr += price;
      const key = String(u.tier).toLowerCase();
      mix[key] = (mix[key] || 0) + 1;
    }
  }

  return {
    totalUsers,
    totalLeads,
    monthTokens: Math.round(monthUsd * tokensPerUsd()),
    mrr,
    mix,
    users,
  };
}

// ── render ───────────────────────────────────────────────────────────────────

// The admin console's tab bar. Three tabs — Overview (/admin, where the users table
// lives too), Analytics (/admin/analytics) and Demo (/demo) — so Demo reads as part
// of the console rather than a stray nav item. Exported: demo.js renders it too, so
// the same bar sits above every console page. The `.tabs`/`.tab` colours come from
// SHARED_CSS; page() (here) and demo.js each add the shared layout rules.
export function adminTabs(active) {
  const tab = (href, key, label) =>
    `<a class="tab${active === key ? " active" : ""}" href="${href}">${label}</a>`;
  return `<div class="tabs">${tab("/admin", "overview", "Overview")}${tab(
    "/admin/analytics",
    "analytics",
    "Analytics"
  )}${tab("/demo", "demo", "Demo")}</div>`;
}

function page(body, extraScript = "", demo = false, active = null) {
  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Admin · Prospector</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  /* Console tab bar layout (colours live in SHARED_CSS). */
  .tabs{display:flex;gap:8px;margin:0 0 20px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14px;border-radius:9px;padding:9px 16px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin-bottom:20px}
  .stat{border-radius:10px;padding:16px}
  .stat .n{font-size:26px;font-weight:800;line-height:1.15}
  .stat .n .per{font-size:14px;font-weight:700;color:var(--muted)}
  .stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
  .stat .s{font-size:12px;margin-top:6px;color:var(--faint)}
  .tblwrap{overflow-x:auto;border-radius:12px}
  /* Eight columns of operator data: kept just inside the shell's 1180px main so
     the row actions are reachable without a horizontal scroll on a laptop. */
  table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden;min-width:1040px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:12px 10px;white-space:normal;line-height:1.35}
  td{padding:11px 10px;font-size:14px;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  th.n{text-align:right}
  td.d{white-space:nowrap;color:var(--muted)}
  td.usercell{max-width:206px}
  .who{font-weight:600;word-break:break-word;line-height:1.35}
  .sub{font-size:12px;margin-top:2px}
  .utag{display:inline-block;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;border-radius:5px;padding:2px 6px;margin-left:7px;vertical-align:middle;background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
  .utag.you{background:var(--accent-weak);color:var(--accent-ink);border-color:transparent}
  .utag.demo{background:var(--warn-weak);color:var(--warn);border-color:transparent}
  select.tier{border-radius:7px;padding:6px 7px;font-size:13px;max-width:156px}
  input.allot{border-radius:7px;padding:6px 7px;font-size:13px;width:88px;text-align:right;margin-top:6px}
  input.topup{border-radius:7px;padding:5px 6px;font-size:12px;width:72px;text-align:right}
  td.usage{min-width:172px}
  td.usage .usenum{font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
  td.usage .usealt,td.usage .usepct{color:var(--muted)}
  td.usage .usepct.hot{color:var(--warn);font-weight:700}
  td.usage .tokbar{display:block;width:100%;max-width:165px;margin-top:6px}
  .rowact{display:flex;align-items:center;gap:8px;white-space:nowrap}
  .rowact2{display:flex;align-items:center;gap:5px;white-space:nowrap;margin-top:7px}
  .savebtn{background:var(--accent);color:var(--on-accent);border:none;border-radius:7px;padding:7px 13px;font-weight:700;font-size:13px;cursor:pointer}
  .savebtn:disabled{opacity:.55;cursor:wait}
  .minibtn{background:transparent;border:1px solid var(--border-strong);color:var(--muted);border-radius:7px;padding:5px 8px;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit}
  .minibtn:hover{color:var(--text);border-color:var(--accent)}
  .minibtn:disabled{opacity:.55;cursor:wait}
  .minibtn.danger:hover{color:var(--danger);border-color:var(--danger)}
  .flag{font-size:12px;font-weight:700;min-width:14px}
  .flag.ok{color:var(--accent-ink)}
  .flag.err{color:var(--danger);white-space:normal;max-width:190px;display:inline-block;line-height:1.3}
  .legend{margin-top:14px;font-size:12px;color:var(--muted);line-height:1.7}
  .legend b{color:var(--text)}
  .legend .lsep{color:var(--faint);margin:0 7px}
  .notice{border-radius:12px;padding:22px 24px;max-width:620px;background:var(--panel);border:1px solid var(--border)}
  .notice h2{font-size:16px;font-weight:800;margin-bottom:8px}
  .notice p{font-size:14px;color:var(--muted);line-height:1.6}
  .notice code{background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:13px;color:var(--text)}
  .empty{color:var(--muted);font-size:15px;padding:26px 4px}
  .sectionhead{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:700;margin:6px 0 12px}
  @media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}}
${SHARED_CSS}</style></head><body>
${sidebar("admin", { isAdmin: true, demo })}<div class="pagehead"><div class="titlewrap"><h1>Admin</h1><div class="pagesub">Operator overview: every user, their usage this month, and their plan</div></div><div class="spacer"></div></div>
${active ? adminTabs(active) : ""}
${body}
${extraScript}${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

function statCard(n, label, sub = "") {
  return `<div class="stat"><div class="n">${n}</div><div class="l">${esc(label)}</div>${
    sub ? `<div class="s">${esc(sub)}</div>` : ""
  }</div>`;
}

function noticeCard(title, text) {
  return `<div class="notice"><h2>${title}</h2><p>${text}</p></div>`;
}

// "3 starter · 3 pro" — the paying accounts behind the MRR number.
function mixLine(mix) {
  const parts = PLAN_KEYS.filter((k) => PLANS[k].price > 0 && mix[k]).map((k) => `${mix[k]} ${k}`);
  // Any custom tier that somehow carries a price would show up here too.
  for (const k of Object.keys(mix)) if (!PLANS[k]) parts.push(`${mix[k]} ${k}`);
  return parts.length ? parts.join(" · ") : "No paying accounts yet";
}

// The usage cell: "1,240 / 2,500 (50%)" over a thin bar (amber at ≥85%).
// Its markup is mirrored by lmPaintUsage() in the inline script, which repaints
// it in place after a top-up / reset instead of reloading the page.
function usageCell(u) {
  if (!u.allotment) { // 0 → account not given a plan yet
    return `<td class="usage"><div class="usenum"><span class="usealt">no plan yet</span></div>
    <div class="tokbar" style="display:none"><div class="tokbar-fill" style="width:0%"></div></div></td>`;
  }
  const pct = Math.round((u.tokens / u.allotment) * 100);
  const hot = pct >= 85;
  const width = Math.max(0, Math.min(100, pct));
  return `<td class="usage"><div class="usenum">${num(u.tokens)} / ${num(u.allotment)} <span class="usepct${
    hot ? " hot" : ""
  }">(${pct}%)</span></div>
    <div class="tokbar${hot ? " warn" : ""}"><div class="tokbar-fill" style="width:${width}%"></div></div></td>`;
}

function userRow(u, meEmail = "") {
  const id = esc(u.id);
  const known = !!PLANS[u.tier];
  // A tier the DB holds that isn't one we sell stays visible as its own option.
  const extra = known
    ? ""
    : `<option value="${esc(u.tier)}" selected>${esc(u.tier)} (custom)</option>`;
  const opts = PLAN_KEYS.map(
    (k) =>
      `<option value="${k}"${known && u.tier === k ? " selected" : ""}>${esc(PLANS[k].label)}${
        PLANS[k].price ? `, $${PLANS[k].price}` : ""
      }</option>`
  ).join("");

  const isMe = meEmail && String(u.email).toLowerCase() === String(meEmail).toLowerCase();
  const tags =
    (isMe ? `<span class="utag you">you</span>` : "") +
    (u.isDemoAccount ? `<span class="utag demo">demo account</span>` : "");

  return `<tr id="u-${id}" data-tokens="${u.tokens}" data-allot="${u.allotment}" data-email="${esc(
    u.email
  )}">
  <td class="usercell"><div class="who">${esc(u.email)}${tags}</div><div class="sub muted">${id.slice(0, 8)}</div></td>
  <td><select class="tier" onchange="lmPlanPick('${id}')" aria-label="Plan for ${esc(
    u.email
  )}">${extra}${opts}</select>
    <div><input class="allot" type="number" min="0" step="10" value="${
      u.allotment
    }" aria-label="Monthly token allotment for ${esc(
      u.email
    )}"><span class="sub muted allothint" style="margin-left:7px">${
      u.allotment ? "" : "0 = no tokens (blocked)"
    }</span></div></td>
  ${usageCell(u)}
  <td class="n">${num(u.leads)}</td>
  <td class="n">${num(u.saved)}</td>
  <td class="d">${fmtDate(u.createdAt)}</td>
  <td class="d">${fmtDate(u.lastUsage)}</td>
  <td>
    <div class="rowact"><button class="savebtn" onclick="lmSaveUser('${id}',this)">Save</button><span class="flag" id="f-${id}"></span></div>
    <div class="rowact2"><input class="topup" type="number" min="1" step="100" placeholder="+ tokens" aria-label="Tokens to add for ${esc(
      u.email
    )}"><button class="minibtn" onclick="lmTopUp('${id}',this)">Add</button><button class="minibtn danger" onclick="lmResetUsage('${id}',this)">Reset month</button></div>
  </td>
</tr>`;
}

function renderOverview(d, spend, demo = false, meEmail = "") {
  const cards = `<div class="stats">
${statCard(num(d.totalUsers), "Users")}
${statCard(`$${num(d.mrr)}<span class="per">/mo</span>`, "MRR", mixLine(d.mix))}
${statCard(num(d.totalLeads), "Leads, all users")}
${statCard(num(d.monthTokens), "Tokens this month", `at ${num(tokensPerUsd())} tokens per $1`)}
${statCard(
  spend == null ? "n/a" : "$" + Number(spend).toFixed(2),
  "Apify spend, month to date",
  spend == null ? "No Apify token configured" : "Operator cost"
)}
</div>`;

  const legend = `<div class="legend">${PLAN_KEYS.map(
    (k) =>
      `<b>${esc(PLANS[k].label)}</b>: ${
        PLANS[k].price ? `$${PLANS[k].price}/mo` : "free"
      }, ${PLANS[k].tokens ? `${num(PLANS[k].tokens)} tokens` : "unlimited tokens"}`
  ).join('<span class="lsep">·</span>')}<br>Picking a plan fills in its allotment, and you can still override the number before saving. An allotment of <b>0</b> blocks the account (no tokens), so use it for signups you have not activated yet. <b>Add</b> tops up this month's allotment when a customer runs out; <b>Reset month</b> clears their usage rows for the current calendar month only.</div>`;

  const table = d.users.length
    ? `<div class="tblwrap"><table>
<thead><tr>
  <th>User</th><th>Plan</th><th>Usage this month</th>
  <th class="n">Leads</th><th class="n">Saved to CRM</th><th>Signed up</th><th>Last usage</th><th>Actions</th>
</tr></thead>
<tbody>${d.users.map((u) => userRow(u, meEmail)).join("\n")}</tbody></table></div>${legend}`
    : `<div class="empty">No users yet. They appear here as soon as someone signs up.</div>${legend}`;

  const script = `<script>
var LM_PLANS=${JSON.stringify(PLANS)};
function lmRow(id){return document.getElementById('u-'+id)}
function lmNum(n){return Number(n||0).toLocaleString('en-US')}
function lmFlag(id,cls,txt,hold){
  var f=document.getElementById('f-'+id); if(!f)return;
  f.className='flag'+(cls?' '+cls:''); f.textContent=txt||'';
  if(txt&&cls==='ok'&&!hold)setTimeout(function(){if(f.textContent===txt){f.textContent='';f.className='flag'}},2500);
}
// Picking a preset fills the allotment field; the number stays editable (an override).
function lmPlanPick(id){
  var row=lmRow(id); if(!row)return;
  var p=LM_PLANS[row.querySelector('select.tier').value]; if(!p)return;
  var inp=row.querySelector('input.allot'); if(!inp)return;
  inp.value=p.tokens;
  var hint=row.querySelector('.allothint'); if(hint)hint.textContent=p.tokens?'':'0 = no tokens (blocked)';
}
// Repaints the usage cell from the row's data-tokens / data-allot (mirrors usageCell()).
function lmPaintUsage(row){
  if(!row)return;
  var tokens=Number(row.getAttribute('data-tokens'))||0;
  var allot=Number(row.getAttribute('data-allot'))||0;
  var cell=row.querySelector('td.usage'); if(!cell)return;
  var n=cell.querySelector('.usenum'),bar=cell.querySelector('.tokbar'),fill=cell.querySelector('.tokbar-fill');
  if(!allot){
    if(n)n.innerHTML='<span class="usealt">no plan yet<\\/span>';
    if(bar){bar.style.display='none';bar.className='tokbar'}
    if(fill)fill.style.width='0%';
  }else{
    var pct=Math.round(tokens/allot*100),hot=pct>=85;
    if(n)n.innerHTML=lmNum(tokens)+' / '+lmNum(allot)+' <span class="usepct'+(hot?' hot':'')+'">('+pct+'%)<\\/span>';
    if(bar){bar.style.display='';bar.className='tokbar'+(hot?' warn':'')}
    if(fill)fill.style.width=Math.max(0,Math.min(100,pct))+'%';
  }
  var hint=row.querySelector('.allothint'); if(hint)hint.textContent=allot?'':'0 = no tokens (blocked)';
}
async function lmPost(url,body){
  var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  var j=null; try{j=await r.json()}catch(e){}
  return j||{ok:false,error:'HTTP '+r.status};
}
async function lmSaveUser(id,btn){
  var row=lmRow(id); if(!row)return;
  var tier=row.querySelector('select.tier').value;
  var allot=parseInt(row.querySelector('input.allot').value,10);
  if(!isFinite(allot)||allot<0)allot=0;
  btn.disabled=true; lmFlag(id,'','');
  try{
    var j=await lmPost('/admin/api/user/'+encodeURIComponent(id),{tier:tier,monthly_token_allotment:allot});
    if(j&&j.ok){
      var a=j.profile&&j.profile.monthly_token_allotment!=null?Number(j.profile.monthly_token_allotment):allot;
      row.setAttribute('data-allot',a);
      row.querySelector('input.allot').value=a;
      lmPaintUsage(row);
      lmFlag(id,'ok','Saved');
    }else lmFlag(id,'err',(j&&j.error)?j.error:'Save failed',true);
  }catch(e){lmFlag(id,'err','Save failed',true)}
  btn.disabled=false;
}
async function lmTopUp(id,btn){
  var row=lmRow(id); if(!row)return;
  var inp=row.querySelector('input.topup');
  var n=parseInt(inp.value,10);
  if(!isFinite(n)||n<1){lmFlag(id,'err','Enter how many tokens to add.',true);inp.focus();return}
  btn.disabled=true; lmFlag(id,'','');
  try{
    var j=await lmPost('/admin/api/user/'+encodeURIComponent(id)+'/topup',{tokens:n});
    if(j&&j.ok){
      row.setAttribute('data-allot',j.allotment);
      row.querySelector('input.allot').value=j.allotment;
      lmPaintUsage(row); inp.value='';
      lmFlag(id,'ok','Added '+lmNum(j.added));
    }else lmFlag(id,'err',(j&&j.error)?j.error:'Top-up failed',true);
  }catch(e){lmFlag(id,'err','Top-up failed',true)}
  btn.disabled=false;
}
async function lmResetUsage(id,btn){
  var row=lmRow(id); if(!row)return;
  var who=row.getAttribute('data-email')||'this user';
  if(!confirm('Clear this month\\'s usage for '+who+'?\\n\\nTheir metered usage for the current calendar month is deleted, so their plan starts over at 0. This cannot be undone.'))return;
  btn.disabled=true; lmFlag(id,'','');
  try{
    var j=await lmPost('/admin/api/user/'+encodeURIComponent(id)+'/reset-usage',{});
    if(j&&j.ok){
      row.setAttribute('data-tokens','0');
      lmPaintUsage(row);
      lmFlag(id,'ok','Cleared '+lmNum(j.deleted));
    }else lmFlag(id,'err',(j&&j.error)?j.error:'Reset failed',true);
  }catch(e){lmFlag(id,'err','Reset failed',true)}
  btn.disabled=false;
}
</script>`;

  return page(cards + table, script, demo, "overview");
}

// ── analytics ─────────────────────────────────────────────────────────────────

// "$3,000" — commas, no cents unless the amount actually carries them.
function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: v % 1 ? 2 : 0 });
}

// "42% of signups" for a funnel step, or a plain note before there is anyone to be a % of.
function pctOfSignups(n, signups) {
  if (!signups) return "No signups yet";
  return `${Math.round((n / signups) * 100)}% of signups`;
}

// The whole analytics view in one shot, all cross-user via the service client (this is
// the one place that's allowed). The demo/staged account is excluded from the funnel —
// it's staged data, not a real signup — but real closed revenue is counted as-is.
async function loadAnalytics() {
  const sb = await getSupabase();
  const demoAddr = demoEmailAddress();

  const [profRes, searchRes, winsRes, recentRes] = await Promise.all([
    sb.from("profiles").select("id,email,tier").range(0, MAX_ROWS),
    // Activation is "ran at least one search" — the kind='search' usage rows, user_id only.
    sb.from("usage_log").select("user_id").eq("kind", "search").range(0, MAX_ROWS),
    // Every win, for the revenue total + the distinct-winners count.
    sb.from("wins").select("user_id,amount").range(0, MAX_ROWS),
    // The latest 25 wins for the table (bounded via .range — dodges the 1000-row default).
    sb
      .from("wins")
      .select("id,user_id,client_name,amount,created_at")
      .order("created_at", { ascending: false })
      .range(0, 24),
  ]);

  const profiles = unwrap(profRes, "profiles").data || [];
  const isDemo = (p) => String(p.email || "").toLowerCase() === demoAddr;
  const real = profiles.filter((p) => !isDemo(p));
  const realIds = new Set(real.map((p) => String(p.id)));
  const emailById = new Map(profiles.map((p) => [String(p.id), p.email || ""]));

  const signedUp = real.length;
  const paying = real.filter((p) => priceOf(p.tier) > 0).length;

  const activatedSet = new Set();
  for (const r of unwrap(searchRes, "search usage").data || []) {
    const uid = String(r.user_id);
    if (realIds.has(uid)) activatedSet.add(uid);
  }
  const activated = activatedSet.size;

  const winnerSet = new Set();
  let revenue = 0;
  let winCount = 0;
  for (const r of unwrap(winsRes, "wins").data || []) {
    winCount++;
    revenue += Number(r.amount) || 0;
    const uid = String(r.user_id);
    if (realIds.has(uid)) winnerSet.add(uid);
  }
  const won = winnerSet.size;

  const recent = (unwrap(recentRes, "recent wins").data || []).map((w) => ({
    id: w.id,
    clientName: w.client_name || "Unnamed client",
    amount: w.amount,
    email: emailById.get(String(w.user_id)) || "Unknown user",
    createdAt: w.created_at,
  }));

  return { signedUp, activated, paying, won, revenue, winCount, recent };
}

function renderAnalytics(d, demo = false) {
  const cards = `<div class="stats">
${statCard(num(d.signedUp), "Signed up", "accounts, excluding demo")}
${statCard(num(d.activated), "Activated", pctOfSignups(d.activated, d.signedUp))}
${statCard(num(d.paying), "Paying", pctOfSignups(d.paying, d.signedUp))}
${statCard(num(d.won), "Won", pctOfSignups(d.won, d.signedUp))}
${statCard(money(d.revenue), "Closed revenue", `${num(d.winCount)} win${d.winCount === 1 ? "" : "s"} logged`)}
</div>`;

  const winsTable = d.recent.length
    ? `<div class="tblwrap"><table>
<thead><tr><th>Client / trade</th><th class="n">Amount</th><th>User</th><th>Date</th></tr></thead>
<tbody>${d.recent
        .map(
          (w) => `<tr>
  <td>${esc(w.clientName)}</td>
  <td class="n">${w.amount == null ? "n/a" : money(w.amount)}</td>
  <td>${esc(w.email)}</td>
  <td class="d">${fmtDate(w.createdAt)}</td>
</tr>`
        )
        .join("\n")}</tbody></table></div>`
    : `<div class="empty">No wins logged yet. Closed deals show up here as users log them.</div>`;

  const body =
    cards +
    `<div class="sectionhead">Recent wins</div>` +
    winsTable;
  return page(body, "", demo, "analytics");
}

// ── routes ───────────────────────────────────────────────────────────────────

// Shared guard for the three mutating endpoints: supabase mode + a real uuid.
// Returns the id, or null once it has already answered the request.
function mutableId(req, res) {
  if (dataProvider() !== "supabase") {
    res.status(400).json({ ok: false, error: "Admin edits need Supabase mode." });
    return null;
  }
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) {
    res.status(400).json({ ok: false, error: "Invalid user id." });
    return null;
  }
  return id;
}

adminRouter.get("/admin", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") {
    return res.send(
      page(
        noticeCard(
          "The admin panel needs Supabase mode",
          "This app is running on local SQLite, which is single-user, so there is nothing to administer. " +
            "Set <code>DATA_PROVIDER=supabase</code> in <code>.env</code> (with the project URL and service-role key) and restart to see users, usage and plans here."
        ),
        "",
        false,
        "overview"
      )
    );
  }
  try {
    // The spend lookup is a third-party call — never let it fail the page.
    const [data, spend] = await Promise.all([
      loadOverview(),
      apifySpend().catch(() => null),
    ]);
    res.send(renderOverview(data, spend, !!req.isDemo, req.userEmail || ""));
  } catch (e) {
    res
      .status(500)
      .send(
        page(
          noticeCard(
            "Could not load the admin data",
            `Supabase returned an error: <code>${esc(e && e.message ? e.message : String(e))}</code>`
          ),
          "",
          !!req.isDemo,
          "overview"
        )
      );
  }
});

// Funnel + closed-revenue analytics. Admin-guarded like every route here; all data is
// cross-user via the service client, which this module is the one place allowed to do.
adminRouter.get("/admin/analytics", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") {
    return res.send(
      page(
        noticeCard(
          "Analytics needs Supabase mode",
          "This app is running on local SQLite, which is single-user, so there is no cross-user funnel to chart. " +
            "Set <code>DATA_PROVIDER=supabase</code> in <code>.env</code> (with the project URL and service-role key) and restart to see signups, activation and closed revenue here."
        ),
        "",
        false,
        "analytics"
      )
    );
  }
  try {
    const data = await loadAnalytics();
    res.send(renderAnalytics(data, !!req.isDemo));
  } catch (e) {
    res
      .status(500)
      .send(
        page(
          noticeCard(
            "Could not load the analytics",
            `Supabase returned an error: <code>${esc(e && e.message ? e.message : String(e))}</code>`
          ),
          "",
          !!req.isDemo,
          "analytics"
        )
      );
  }
});

// Set a user's plan + allotment outright.
adminRouter.post(
  "/admin/api/user/:id",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = mutableId(req, res);
    if (!id) return;

    const body = req.body || {};
    const patch = {};

    if (body.tier !== undefined && body.tier !== null && body.tier !== "") {
      const tier = normalizeTier(body.tier);
      if (!tier) {
        return res.status(400).json({
          ok: false,
          error: `Plan must be one of: ${PLAN_KEYS.join(", ")} (or an existing custom tier).`,
        });
      }
      patch.tier = tier;
    }

    const allot = body.monthly_token_allotment;
    if (allot !== undefined && allot !== null && allot !== "") {
      const n = Number(allot);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, error: "Allotment must be zero or more." });
      }
      if (n > ALLOTMENT_MAX) {
        return res
          .status(400)
          .json({ ok: false, error: `Allotment must be ${num(ALLOTMENT_MAX)} or less.` });
      }
      patch.monthly_token_allotment = Math.round(n);
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: "Nothing to update." });
    }

    try {
      const sb = await getSupabase();
      const { data, error } = await sb
        .from("profiles")
        .update(patch)
        .eq("id", id)
        .select("id,tier,monthly_token_allotment");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) return res.status(404).json({ ok: false, error: "User not found." });
      res.json({ ok: true, profile: data[0] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Update failed." });
    }
  }
);

// Top up: add N tokens to this month's allotment (the "they ran out, they paid
// for more" lever). Also works from 0 (no plan yet): the top-up becomes the allotment.
adminRouter.post(
  "/admin/api/user/:id/topup",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = mutableId(req, res);
    if (!id) return;

    const raw = (req.body || {}).tokens;
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < TOPUP_MIN || n > TOPUP_MAX) {
      return res.status(400).json({
        ok: false,
        error: `Tokens to add must be a whole number between ${num(TOPUP_MIN)} and ${num(TOPUP_MAX)}.`,
      });
    }

    try {
      const sb = await getSupabase();
      const cur = await sb
        .from("profiles")
        .select("id,email,tier,monthly_token_allotment")
        .eq("id", id)
        .maybeSingle();
      if (cur.error) return res.status(500).json({ ok: false, error: cur.error.message });
      if (!cur.data) return res.status(404).json({ ok: false, error: "User not found." });

      // 0 = no plan yet (blocked). A top-up from 0 simply becomes the allotment,
      // which unblocks the account without forcing a plan pick first.
      const current = Number(cur.data.monthly_token_allotment ?? 0);
      const next = current + n;
      if (next > ALLOTMENT_MAX) {
        return res
          .status(400)
          .json({ ok: false, error: `That would push the allotment past ${num(ALLOTMENT_MAX)}.` });
      }

      const { data, error } = await sb
        .from("profiles")
        .update({ monthly_token_allotment: next })
        .eq("id", id)
        .select("id,tier,monthly_token_allotment");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) return res.status(404).json({ ok: false, error: "User not found." });
      res.json({ ok: true, added: n, previous: current, allotment: next, profile: data[0] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Top-up failed." });
    }
  }
);

// Reset usage: drop THIS calendar month's usage_log rows for one user, so a
// paying customer can be given a clean slate. Earlier months are left alone.
adminRouter.post(
  "/admin/api/user/:id/reset-usage",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = mutableId(req, res);
    if (!id) return;

    try {
      const sb = await getSupabase();
      const exists = await sb.from("profiles").select("id").eq("id", id).maybeSingle();
      if (exists.error) return res.status(500).json({ ok: false, error: exists.error.message });
      if (!exists.data) return res.status(404).json({ ok: false, error: "User not found." });

      const since = firstOfMonthISO();
      const { data, error } = await sb
        .from("usage_log")
        .delete()
        .eq("user_id", id)
        .gte("at", since)
        .select("id");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      res.json({ ok: true, deleted: (data || []).length, since });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Reset failed." });
    }
  }
);

export default adminRouter;
