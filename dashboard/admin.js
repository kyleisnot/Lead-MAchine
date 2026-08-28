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
//   GET  /admin                            - operator overview (stat cards + users table)
//   POST /admin/api/user/:id               - {tier, monthly_token_allotment} -> updates profiles
//   POST /admin/api/user/:id/topup         - {tokens} -> adds N to monthly_token_allotment
//   POST /admin/api/user/:id/reset-usage   - clears THIS calendar month's usage_log rows
//   GET  /admin/inbox                      - operator inbox (token requests + support messages)
//   POST /admin/api/request/:id/approve    - {tokens, priceUsd, note} -> grants and closes a request
//   POST /admin/api/request/:id/decline    - {note} -> closes a request, grants nothing
//   POST /admin/api/support/:id/reply      - {reply} -> stores the reply, status answered
//   POST /admin/api/support/:id/close      - status closed
import express from "express";
import { requireUser, requireAdmin } from "./auth.js";
import { dataProvider, getSupabase } from "../lib/supabase.js";
import { apifySpend } from "../lib/spend.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar, FAVICON } from "./shell.js";

export const adminRouter = express.Router();

// ── plans: the single source of truth for what the operator sells ────────────
// `tokens` is the monthly allotment the plan implies. 0 means NO TOKENS (a
// not-yet-activated account is blocked until an admin assigns a plan). `price` is
// USD per month, 0 for non-paying plans. `prospect` is the near-nothing plan
// demo-created accounts sit on.
//
// The old `unlimited` tier is retired. Rows in the DB that still carry it (or any
// other hand-edited string) are NOT migrated: normalizeTier / planFor tolerate an
// unknown tier, so such a user still renders, still saves, and counts $0 toward
// MRR until the operator reassigns them by hand.
export const PLANS = {
  prospect: { label: "Prospect (demo)", tokens: 1, price: 0 },
  trial: { label: "Trial", tokens: 300, price: 0 },
  starter: { label: "Starter", tokens: 800, price: 50 },
  pro: { label: "Pro", tokens: 2000, price: 100 },
  agency: { label: "Agency", tokens: 9000, price: 400 },
};
const PLAN_KEYS = Object.keys(PLANS);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A top-up has to be a real number of tokens, not a typo that silently gifts a
// customer a million credits (or an integer-column overflow).
const TOPUP_MIN = 1;
const TOPUP_MAX = 1000000;
const ALLOTMENT_MAX = 1000000000; // stays inside a postgres int4

// Inbox free text: what an operator can type on a decision or a support reply.
const NOTE_MAX = 2000;
const REPLY_MAX = 5000;
// A single approval can be recorded at any sane invoice size, but not at a typo'd one.
const PRICE_MAX = 1000000;

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

// USD per token when a customer buys more AFTER burning their allotment. Priced
// deliberately above every plan's per-token rate, so topping up mid-month is worse
// value than moving up a plan. Validated exactly like tokensPerUsd().
function overageRatePerToken() {
  const n = parseFloat(process.env.OVERAGE_RATE_PER_TOKEN || "0.09");
  return Number.isFinite(n) && n > 0 ? n : 0.09;
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

// Date plus wall-clock time, server-local. The inbox needs the time of day: two
// requests from the same customer on the same day have to be tellable apart.
function fmtWhen(v) {
  if (!v) return "n/a";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "n/a";
  const p = (x) => String(x).padStart(2, "0");
  return `${fmtDate(v)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Operator-typed free text on its way into the DB: normalized newlines, trimmed,
// hard length cap. Returns "" for anything empty, so callers can test truthiness.
function cleanText(v, max) {
  const s = String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return s.length > max ? s.slice(0, max) : s;
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

// The admin console's tab bar. Five tabs: Overview (/admin, where the users table
// lives too), Analytics (/admin/analytics), Inbox (/admin/inbox), Pricing
// (/admin/pricing) and Demo (/demo), so Demo reads as part of the console rather
// than a stray nav item. Exported: demo.js renders it too, so the same bar sits
// above every console page. The `.tabs`/`.tab`/`.pill` colours come from SHARED_CSS;
// page() (here) and demo.js each add the shared layout rules.
//
// `pending` is the count of work waiting in the inbox. It is optional so the old
// one-argument call (demo.js) keeps working: 0 or missing means no badge at all.
export function adminTabs(active, pending = 0) {
  const n = Math.max(0, Math.round(Number(pending) || 0));
  const badge = n
    ? `<span class="pill" id="lm-inbox-badge" title="${n} waiting in the inbox">${
        n > 99 ? "99+" : n
      }</span>`
    : "";
  const tab = (href, key, label, extra = "") =>
    `<a class="tab${active === key ? " active" : ""}" href="${href}">${label}${extra}</a>`;
  return `<div class="tabs">${tab("/admin", "overview", "Overview")}${tab(
    "/admin/analytics",
    "analytics",
    "Analytics"
  )}${tab("/admin/inbox", "inbox", "Inbox", badge)}${tab("/admin/pricing", "pricing", "Pricing")}${tab(
    "/demo",
    "demo",
    "Demo"
  )}</div>`;
}

// `sub` overrides the page subtitle; the default is the operator overview's wording,
// so Overview and Analytics render byte-for-byte as before.
function page(body, extraScript = "", demo = false, active = null, sub = null, pending = 0) {
  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Admin · Prospector</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  /* Console tab bar layout (colours live in SHARED_CSS). */
  .tabs{display:flex;gap:8px;margin:0 0 20px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14px;border-radius:9px;padding:9px 16px}
  /* Pending-work badge on the Inbox tab (colours live in SHARED_CSS). */
  .tab .pill{display:inline-block;min-width:19px;text-align:center;font-size:11px;font-weight:800;line-height:1;border-radius:999px;padding:4px 6px;font-variant-numeric:tabular-nums}
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
  /* Pricing tab. The flow diagram scrolls sideways rather than shrinking its
     labels below legibility; every colour is a var so both themes work. */
  .pricehead{margin-top:28px}
  .flowwrap{overflow-x:auto;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:4px}
  .flowsvg{display:block;width:100%;height:auto;max-width:980px;min-width:760px;margin:0 auto}
  .flowsvg text{font-family:inherit}
  .pricetbl{min-width:960px}
  .plantbl{min-width:860px}
  .mgn{font-weight:700;font-variant-numeric:tabular-nums}
  .mgn.hi{color:var(--accent-ink)}
  .mgn.mid{color:var(--text)}
  .mgn.low{color:var(--warn)}
  .stat.sm .n{font-size:19px}
  .foot{margin-top:16px;font-size:12.5px;color:var(--muted);line-height:1.7;max-width:900px}
  .foot b{color:var(--text)}
  .foot code{background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:12px;color:var(--text)}
  .foot ul{margin:8px 0 0;padding-left:18px}
  .foot li{margin-bottom:5px}
  /* Inbox tab. Two tables of operator work: token requests and support messages. */
  .inboxtbl{min-width:1020px}
  .msgtbl{min-width:940px}
  /* Wider than the overview's user cell: these tables have the room, and an email
     that wraps mid-word is hard to read back to a customer. */
  .inboxtbl td.usercell,.msgtbl td.usercell{max-width:250px;min-width:186px}
  tr.done td{color:var(--muted)}
  td.body{max-width:360px}
  .msgbody{font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:132px;overflow-y:auto}
  .rnote{font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-width:260px}
  .rnote.none{color:var(--faint)}
  .rstatus{display:inline-block;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;border-radius:5px;padding:3px 7px;background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
  .rstatus.wait{background:var(--warn-weak);color:var(--warn);border-color:transparent}
  .rstatus.yes{background:var(--accent-weak);color:var(--accent-ink);border-color:transparent}
  td.decide{min-width:330px}
  .fld{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);white-space:nowrap}
  input.gtok,input.gusd{border-radius:7px;padding:5px 6px;font-size:12px;width:80px;text-align:right}
  input.gnote{border-radius:7px;padding:5px 7px;font-size:12px;width:100%;max-width:310px}
  textarea.reply{border-radius:7px;padding:7px 8px;font-size:13px;width:100%;max-width:330px;min-height:62px;resize:vertical;font-family:inherit;line-height:1.5}
  .outcome{font-size:12.5px;color:var(--muted);line-height:1.6;max-width:310px}
  .outcome b{color:var(--text)}
  .inboxnote{margin:0 0 12px;font-size:12.5px;color:var(--muted);line-height:1.6;max-width:900px}
  .inboxnote b{color:var(--text)}
  @media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}}
${SHARED_CSS}</style></head><body>
${sidebar("admin", { isAdmin: true, demo })}<div class="pagehead"><div class="titlewrap"><h1>Admin</h1><div class="pagesub">${
    sub ? esc(sub) : "Operator overview: every user, their usage this month, and their plan"
  }</div></div><div class="spacer"></div></div>
${active ? adminTabs(active, pending) : ""}
${body}
${extraScript}${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

function statCard(n, label, sub = "", cls = "") {
  return `<div class="stat${cls ? " " + cls : ""}"><div class="n">${n}</div><div class="l">${esc(
    label
  )}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
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

function renderOverview(d, spend, demo = false, meEmail = "", pending = 0) {
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
      }, ${num(PLANS[k].tokens)} tokens`
  ).join('<span class="lsep">·</span>')}<br>Picking a plan fills in its allotment, and you can still override the number before saving. An allotment of <b>0</b> blocks the account (no tokens), so use it for signups you have not activated yet. <b>Add</b> tops up this month's allotment when a customer runs out; <b>Reset month</b> clears their usage rows for the current calendar month only.<br>The old <b>Unlimited</b> plan is retired and is no longer in the picker. An account still sitting on it (or on any other hand-edited tier) keeps showing that tier verbatim, counts $0 toward MRR, and saves fine, so move those accounts onto ${esc(
    PLANS.agency.label
  )} or ${esc(
    PLANS.pro.label
  )} by hand. Selling more tokens mid-month is priced at ${usd4(
    overageRatePerToken()
  )} per token; see the Pricing tab.</div>`;

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

  return page(cards + table, script, demo, "overview", null, pending);
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

function renderAnalytics(d, demo = false, pending = 0) {
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
  return page(body, "", demo, "analytics", null, pending);
}

// ── pricing ──────────────────────────────────────────────────────────────────
//
// The operator's money page: what a scan costs us, what the meter turns it into,
// and what each plan sells that token for. It reads no user data at all, so it
// renders identically in sqlite and supabase mode.
//
// Everything below is derived at request time from three env vars. Nothing is
// precomputed, cached or hardcoded, so changing APIFY_RATE_PER_1K (or either of
// the other two) reprices the entire page on the next load.

// Our supplier rate: USD per 1,000 businesses scanned. Measured across a 3-source
// scan, where each scraper carries its own startup cost.
function apifyRatePer1k() {
  const n = parseFloat(process.env.APIFY_RATE_PER_1K || "7.5");
  return Number.isFinite(n) && n > 0 ? n : 7.5;
}

// The flat token price of the "Guaranteed 5 companies" search mode. Read with a
// fallback so this page prices correctly whether or not that var is deployed yet.
function guaranteedFiveTokens() {
  const n = parseFloat(process.env.GUARANTEED_FIVE_TOKENS || "60");
  return Number.isFinite(n) && n > 0 ? n : 60;
}

// Measured assumptions rather than env: the size of one standard scan cell, how
// many qualified no-website companies a scan yields, and the hard stop the
// guaranteed mode scans to before it gives up and bills per place instead.
const SCAN_CELL_PLACES = 50;
const GUARANTEE_TARGET = 5;
const YIELD_TYPICAL = 7; // businesses scanned per qualified company, typical market
const YIELD_WORST = 20; // ... and in a thin one
const GUARANTEE_CAP_PLACES = 120;

// The sample basket the overage card prices, so the rate lands as a real number a
// customer would actually be quoted rather than a fraction of a cent.
const OVERAGE_SAMPLE_TOKENS = 500;

// Plans the pricing page reasons about. `prospect` is the 1-token demo shell, not
// something the operator sells, so it stays out of the margin maths.
const PRICING_PLAN_KEYS = PLAN_KEYS.filter((k) => k !== "prospect");

function usd2(n) {
  return (
    "$" +
    Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

// The per-business cost is fractions of a cent, so it needs four places to be true.
function usd4(n) {
  return "$" + Number(n || 0).toFixed(4);
}

function centsPerToken(usdPerToken) {
  return (Number(usdPerToken || 0) * 100).toFixed(2) + "c";
}

// Whole tokens once the number is big enough for the fraction to be noise, two
// decimals below that (so 0.5625 reads as 0.56 and 28.125 reads as 28).
function tokenAmt(n) {
  const v = Number(n || 0);
  return v >= 10 ? num(Math.round(v)) : v.toFixed(2);
}

function pctText(fraction) {
  return Math.round(Number(fraction) * 100) + "%";
}

// Margin colour: healthy at 70 and up, plain in the middle, amber below 50.
function marginClass(fraction) {
  const p = Number(fraction) * 100;
  if (p >= 70) return "hi";
  if (p >= 50) return "mid";
  return "low";
}

function marginCell(fraction, sub = "") {
  return `<td class="n"><span class="mgn ${marginClass(fraction)}">${pctText(
    fraction
  )}</span>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</td>`;
}

// The whole economic model, computed fresh per request.
function pricingModel() {
  const rate = apifyRatePer1k();
  const tpu = tokensPerUsd();
  const flatFive = guaranteedFiveTokens();
  const overageRate = overageRatePerToken();

  const usdPerPlace = rate / 1000; // what one scanned business costs us
  const tokensPerPlace = usdPerPlace * tpu; // what we charge for one, in tokens

  const plans = PRICING_PLAN_KEYS.map((k) => {
    const p = PLANS[k];
    const usdPerToken = p.price > 0 && p.tokens > 0 ? p.price / p.tokens : 0;
    // Tokens charged always equal places x rate/1000 x tpu, so the Apify cost of a
    // fully consumed allotment collapses to tokens / tpu: the rate cancels out.
    const worstCostUsd = p.tokens / tpu;
    // ... unless every token is spent in guaranteed mode and every one of those
    // searches runs to the cap, which buys more places per token than the meter.
    const guaranteedCeilingUsd = (p.tokens / flatFive) * GUARANTEE_CAP_PLACES * usdPerPlace;
    return {
      key: k,
      label: p.label,
      price: p.price,
      tokens: p.tokens,
      usdPerToken,
      scanCells: Math.floor(p.tokens / (SCAN_CELL_PLACES * tokensPerPlace)),
      guaranteedRuns: Math.floor(p.tokens / flatFive),
      worstCostUsd,
      guaranteedCeilingUsd,
      margin: p.price > 0 ? 1 - worstCostUsd / p.price : null,
    };
  });
  const planBy = (k) => plans.find((p) => p.key === k) || null;

  // Businesses we have to scan to hand over five no-website companies.
  const typicalPlaces = GUARANTEE_TARGET * YIELD_TYPICAL;
  const worstPlaces = GUARANTEE_TARGET * YIELD_WORST;

  const modes = [
    {
      name: "Scan 50 businesses",
      note: "one standard cell, billed per place",
      placesText: num(SCAN_CELL_PLACES),
      tokens: SCAN_CELL_PLACES * tokensPerPlace,
      costTypical: SCAN_CELL_PLACES * usdPerPlace,
      costWorst: SCAN_CELL_PLACES * usdPerPlace,
    },
    {
      name: "Guaranteed 5 companies, met",
      note: "flat token price, whatever the scan costs us",
      placesText: `${num(typicalPlaces)} to ${num(worstPlaces)}`,
      tokens: flatFive,
      costTypical: typicalPlaces * usdPerPlace,
      costWorst: worstPlaces * usdPerPlace,
    },
    {
      name: "Guaranteed 5, not met at the cap",
      note: "stops at the cap and falls back to per place billing",
      placesText: num(GUARANTEE_CAP_PLACES),
      tokens: GUARANTEE_CAP_PLACES * tokensPerPlace,
      costTypical: GUARANTEE_CAP_PLACES * usdPerPlace,
      costWorst: GUARANTEE_CAP_PLACES * usdPerPlace,
    },
  ];

  // Overage: what a customer pays for extra tokens once the allotment is gone.
  // Per place billing makes our cost exactly tokens / tpu, so the margin reduces to
  // 1 - (1 / tpu) / rate and is the same whatever basket size we quote.
  const overageCustomerUsd = OVERAGE_SAMPLE_TOKENS * overageRate;
  const overageCostUsd = OVERAGE_SAMPLE_TOKENS / tpu;
  const overage = {
    rate: overageRate,
    sampleTokens: OVERAGE_SAMPLE_TOKENS,
    customerUsd: overageCustomerUsd,
    ourCostUsd: overageCostUsd,
    margin: overageCustomerUsd > 0 ? 1 - overageCostUsd / overageCustomerUsd : 0,
    // The paid plans it has to beat, cheapest per token last.
    beats: plans
      .filter((p) => p.price > 0 && p.usdPerToken > 0)
      .sort((a, b) => b.usdPerToken - a.usdPerToken),
  };

  return {
    rate,
    tpu,
    flatFive,
    usdPerPlace,
    tokensPerPlace,
    plans,
    planBy,
    modes,
    overage,
    typicalPlaces,
    worstPlaces,
    typicalCostUsd: typicalPlaces * usdPerPlace,
    worstCostUsd: worstPlaces * usdPerPlace,
    scanCellTokens: SCAN_CELL_PLACES * tokensPerPlace,
  };
}

// Three boxes left to right: what we pay, what the meter charges, what a token
// sells for. The live constants ride on the two arrows between them. Deliberately
// flat and horizontal so it stays readable at any width down to the scroll floor.
function flowDiagram(m) {
  const paid = m.plans.filter((p) => p.price > 0).slice(0, 3);
  const planLines = paid
    .map((p, i) => {
      const y = 92 + i * 24;
      return `<text x="699" y="${y}" font-size="11.5" fill="var(--text)">${esc(
        p.label
      )}, $${num(p.price)}</text><text x="959" y="${y}" text-anchor="end" font-size="11.5" font-weight="700" fill="var(--accent)">${centsPerToken(
        p.usdPerToken
      )} per token</text>`;
    })
    .join("");

  return `<div class="flowwrap"><svg class="flowsvg" viewBox="0 0 980 200" role="img" aria-label="Apify cost feeds the token meter, which feeds the customer plan prices" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="lmpricearrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,1 L9,5 L0,9 z" fill="var(--border-strong)"/></marker></defs>

<rect x="1" y="16" width="228" height="168" rx="12" fill="var(--surface2)" stroke="var(--border)"/>
<text x="115" y="45" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">Apify scan</text>
<text x="115" y="63" text-anchor="middle" font-size="10.5" fill="var(--muted)">what we pay the supplier</text>
<text x="115" y="113" text-anchor="middle" font-size="27" font-weight="800" fill="var(--text)">${usd4(
    m.usdPerPlace
  )}</text>
<text x="115" y="134" text-anchor="middle" font-size="11" fill="var(--muted)">per business scanned</text>
<text x="115" y="166" text-anchor="middle" font-size="10" fill="var(--faint)">APIFY_RATE_PER_1K = ${esc(
    String(m.rate)
  )}</text>

<line x1="233" y1="100" x2="330" y2="100" stroke="var(--border-strong)" stroke-width="2" marker-end="url(#lmpricearrow)"/>
<text x="285" y="76" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">$${m.rate.toFixed(
    2
  )} per 1,000</text>
<text x="285" y="90" text-anchor="middle" font-size="10.5" fill="var(--muted)">businesses scanned</text>

<rect x="340" y="16" width="228" height="168" rx="12" fill="var(--surface2)" stroke="var(--border)"/>
<text x="454" y="45" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">Token meter</text>
<text x="454" y="63" text-anchor="middle" font-size="10.5" fill="var(--muted)">our unit of account</text>
<text x="454" y="113" text-anchor="middle" font-size="27" font-weight="800" fill="var(--text)">${tokenAmt(
    m.tokensPerPlace
  )}</text>
<text x="454" y="134" text-anchor="middle" font-size="11" fill="var(--muted)">tokens charged per business</text>
<text x="454" y="166" text-anchor="middle" font-size="10" fill="var(--faint)">TOKENS_PER_USD = ${esc(
    String(m.tpu)
  )}</text>

<line x1="572" y1="100" x2="669" y2="100" stroke="var(--border-strong)" stroke-width="2" marker-end="url(#lmpricearrow)"/>
<text x="624" y="76" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">x${esc(
    String(m.tpu)
  )} tokens per $1</text>
<text x="624" y="90" text-anchor="middle" font-size="10.5" fill="var(--muted)">${tokenAmt(
    m.tokensPerPlace
  )} tokens each</text>

<rect x="679" y="16" width="300" height="168" rx="12" fill="var(--surface2)" stroke="var(--border)"/>
<text x="829" y="45" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">Customer plans</text>
<text x="829" y="63" text-anchor="middle" font-size="10.5" fill="var(--muted)">what a token sells for</text>
${planLines}
<text x="829" y="170" text-anchor="middle" font-size="10" fill="var(--faint)">Overage after the allotment: ${centsPerToken(
    m.overage.rate
  )} per token, above every plan rate</text>
</svg></div>`;
}

// One row per search mode, with the customer value and margin for the two plans
// that carry a real per-token rate. Margin is stated against our WORST case cost.
function modeTable(m) {
  const starter = m.planBy("starter");
  const pro = m.planBy("pro");

  const rows = m.modes
    .map((mode) => {
      const cells = [starter, pro]
        .map((p) => {
          if (!p || !p.usdPerToken) return `<td class="n">n/a</td><td class="n">n/a</td>`;
          const value = mode.tokens * p.usdPerToken;
          return `<td class="n">${usd2(value)}</td>${marginCell(1 - mode.costWorst / value)}`;
        })
        .join("");
      return `<tr>
  <td><div class="who">${esc(mode.name)}</div><div class="sub">${esc(mode.note)}</div></td>
  <td class="n">${esc(mode.placesText)}</td>
  <td class="n">${tokenAmt(mode.tokens)}</td>
  <td class="n">${usd2(mode.costTypical)}</td>
  <td class="n">${usd2(mode.costWorst)}</td>
  ${cells}
</tr>`;
    })
    .join("\n");

  return `<div class="tblwrap"><table class="pricetbl">
<thead><tr>
  <th>Search mode</th>
  <th class="n">Businesses scanned</th>
  <th class="n">Tokens charged</th>
  <th class="n">Our cost, typical</th>
  <th class="n">Our cost, worst</th>
  <th class="n">Starter value</th>
  <th class="n">Starter margin, worst</th>
  <th class="n">Pro value</th>
  <th class="n">Pro margin, worst</th>
</tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

// The spread the guarantee monetizes: the same flat price covers a cheap market
// and an expensive one, and the customer pays the same either way.
function guaranteeCards(m) {
  const starter = m.planBy("starter");
  const rateNote = `at ${usd4(m.usdPerPlace)} per business`;
  const flatValue = starter && starter.usdPerToken ? m.flatFive * starter.usdPerToken : 0;
  const cellsTypical = Math.ceil(m.typicalPlaces / SCAN_CELL_PLACES);
  const cellsWorst = Math.ceil(m.worstPlaces / SCAN_CELL_PLACES);
  const scanTypical =
    starter && starter.usdPerToken ? cellsTypical * m.scanCellTokens * starter.usdPerToken : 0;
  const scanWorst =
    starter && starter.usdPerToken ? cellsWorst * m.scanCellTokens * starter.usdPerToken : 0;

  return `<div class="stats">
${statCard(
  num(m.typicalPlaces),
  "Scanned to find 5, typical",
  `our cost ${usd2(m.typicalCostUsd)}, 1 per ${YIELD_TYPICAL} scanned`
)}
${statCard(
  num(m.worstPlaces),
  "Scanned to find 5, thin market",
  `our cost ${usd2(m.worstCostUsd)}, 1 per ${YIELD_WORST} scanned`
)}
${statCard(
  usd2(flatValue),
  "Customer pays, guaranteed 5",
  `${tokenAmt(m.flatFive)} tokens on Starter, either market`
)}
${statCard(
  `${usd2(scanTypical)} to ${usd2(scanWorst)}`,
  "Customer pays, scan 50 cells",
  `${cellsTypical} cell typical, ${cellsWorst} cells thin market`,
  "sm"
)}
${statCard(
  `${usd2(flatValue - m.worstCostUsd)} to ${usd2(flatValue - m.typicalCostUsd)}`,
  "Gross per guaranteed 5",
  "on Starter, thin market to typical",
  "sm"
)}
</div>`;
}

// Per plan: what it costs the customer, what it buys, and the most it can cost us.
function planTable(m) {
  const rows = m.plans
    .map((p) => {
      const worst = `<td class="n">${usd2(p.worstCostUsd)}</td>`;
      const margin =
        p.price > 0
          ? marginCell(p.margin)
          : `<td class="n"><span class="sub">acquisition cost, up to ${usd2(
              p.worstCostUsd
            )}</span></td>`;
      return `<tr>
  <td><div class="who">${esc(p.label)}</div></td>
  <td class="n">${p.price > 0 ? "$" + num(p.price) : "free"}</td>
  <td class="n">${num(p.tokens)}</td>
  <td class="n">${p.usdPerToken ? centsPerToken(p.usdPerToken) : "free"}</td>
  <td class="n">${num(p.scanCells)}</td>
  <td class="n">${num(p.guaranteedRuns)}</td>
  ${worst}
  ${margin}
</tr>`;
    })
    .join("\n");

  return `<div class="tblwrap"><table class="plantbl">
<thead><tr>
  <th>Plan</th>
  <th class="n">Price</th>
  <th class="n">Tokens</th>
  <th class="n">Price per token</th>
  <th class="n">Scan 50 searches</th>
  <th class="n">Guaranteed 5s</th>
  <th class="n">Worst case Apify cost</th>
  <th class="n">Gross margin</th>
</tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

// What a customer pays for tokens bought AFTER the allotment is gone, and why the
// rate sits above every plan. Same worst case cost basis as the plan table, so the
// two margins are comparable.
function overageCards(m) {
  const o = m.overage;
  const cheaper = o.beats.map((p) => `${esc(p.label)} at ${centsPerToken(p.usdPerToken)}`);
  const beatsLine = cheaper.length
    ? cheaper.length === 1
      ? cheaper[0]
      : cheaper.slice(0, -1).join(", ") + " and " + cheaper[cheaper.length - 1]
    : "every paid plan";

  return `<div class="stats">
${statCard(
  usd4(o.rate),
  "Overage rate, per token",
  `${centsPerToken(o.rate)} each, set by OVERAGE_RATE_PER_TOKEN`
)}
${statCard(
  usd2(o.customerUsd),
  `Customer pays, ${num(o.sampleTokens)} extra tokens`,
  `${num(o.sampleTokens)} tokens at ${centsPerToken(o.rate)} each`
)}
${statCard(
  usd2(o.ourCostUsd),
  "Our cost for those tokens",
  `${num(o.sampleTokens)} tokens at ${num(m.tpu)} tokens per $1`
)}
${statCard(
  `<span class="mgn ${marginClass(o.margin)}">${pctText(o.margin)}</span>`,
  "Overage margin, worst case",
  "same per place cost basis as the plans"
)}
</div>
<div class="foot">Overage is priced above every plan rate on purpose: ${centsPerToken(
    o.rate
  )} per token beats ${beatsLine}, so a customer who keeps running out mid-month is always better off upgrading than buying more tokens at this rate.</div>`;
}

function pricingFootnote(m) {
  const paid = m.plans.filter((p) => p.price > 0);
  const ceilings = paid
    .map((p) => `${usd2(p.guaranteedCeilingUsd)} on ${esc(p.label)}`)
    .join(", ");

  return `<div class="foot"><b>Assumptions and where the numbers come from</b>
<ul>
  <li>Measured yield: about 1 qualified no-website company per ${YIELD_TYPICAL} businesses scanned in a typical market, and about 1 per ${YIELD_WORST} in a thin one. Five companies therefore costs us ${usd2(
    m.typicalCostUsd
  )} typically and ${usd2(m.worstCostUsd)} at the bad end.</li>
  <li>The guaranteed mode scans at most ${num(
    GUARANTEE_CAP_PLACES
  )} businesses. Past that it stops, the guarantee is not met, and the search bills per place like a normal scan.</li>
  <li>Every figure on this page is computed when the page loads, from <code>APIFY_RATE_PER_1K</code> (now ${esc(
    String(m.rate)
  )}), <code>TOKENS_PER_USD</code> (now ${esc(
    String(m.tpu)
  )}), <code>GUARANTEED_FIVE_TOKENS</code> (now ${esc(
    String(m.flatFive)
  )}) and <code>OVERAGE_RATE_PER_TOKEN</code> (now ${esc(
    String(m.overage.rate)
  )}). Change one in the environment and everything here reprices on the next load.</li>
  <li>Per place billing makes our cost exactly tokens divided by <code>TOKENS_PER_USD</code>, whatever the Apify rate is, which is why the worst case column matches the plan margin. If a customer instead spent a whole allotment on guaranteed searches that all ran to the cap, our cost would top out slightly higher: ${ceilings}.</li>
  <li>Trial is free, so it has no margin. Treat its ${usd2(
    (m.planBy("trial") || { worstCostUsd: 0 }).worstCostUsd
  )} as acquisition cost.</li>
  <li>Overage sits above every plan rate by design, so the upgrade is always the better deal for the customer and we never sell our cheapest tokens to the customers using the most. Its margin uses the same worst case basis as the plan rows.</li>
  <li>The old Unlimited plan is retired and no longer sells. Any account still carrying that tier renders with its raw tier and counts $0 toward MRR until the operator reassigns it, and is deliberately left out of this page.</li>
  <li>The 1-token Prospect (demo) plan is left out: it is a demo shell, not something the operator sells.</li>
</ul></div>`;
}

function renderPricing(m, demo = false, pending = 0) {
  const body =
    `<div class="sectionhead">Money flow, supplier cost to plan price</div>` +
    flowDiagram(m) +
    `<div class="sectionhead pricehead">Search mode economics</div>` +
    modeTable(m) +
    `<div class="sectionhead pricehead">Cost of five no-website companies</div>` +
    guaranteeCards(m) +
    `<div class="sectionhead pricehead">Plan margins</div>` +
    planTable(m) +
    `<div class="sectionhead pricehead">Overage, after the allotment runs out</div>` +
    overageCards(m) +
    pricingFootnote(m);
  return page(
    body,
    "",
    demo,
    "pricing",
    "What a scan costs us, what the meter charges for it, and what each plan earns",
    pending
  );
}

// ── inbox ────────────────────────────────────────────────────────────────────
//
// The operator's work queue: customers asking for more tokens, and customers
// asking for help. Both tables are read cross-user through the service client,
// which this module is the one place allowed to do.

// How the plan column reads for one requester. A tier we no longer sell (the
// retired `unlimited`, or anything hand-edited) is shown verbatim and flagged, so
// the operator can see at a glance who still needs reassigning.
function tierLabel(tier) {
  const raw = String(tier ?? "").trim();
  if (!raw) return "no plan";
  const p = planFor(raw);
  return p ? p.label : `${raw} (retired or custom)`;
}

// Pending token requests plus open support messages: the number on the Inbox tab.
// Two head:true count queries, no row transfer, and it NEVER throws. A badge is a
// convenience, so a missing table or a sqlite deployment just means no badge at all
// rather than a dead admin page.
async function pendingInboxCount() {
  if (dataProvider() !== "supabase") return 0;
  try {
    const sb = await getSupabase();
    const [reqRes, msgRes] = await Promise.all([
      sb.from("token_requests").select("*", { count: "exact", head: true }).eq("status", "pending"),
      sb.from("support_messages").select("*", { count: "exact", head: true }).eq("status", "open"),
    ]);
    if (reqRes.error || msgRes.error) return 0;
    return (reqRes.count || 0) + (msgRes.count || 0);
  } catch {
    return 0;
  }
}

// Both inbox tables, newest first, with the requester details each row needs.
// Ranged like loadOverview so PostgREST's 1000-row default cannot silently truncate.
async function loadInbox() {
  const sb = await getSupabase();
  const since = firstOfMonthISO();
  const rate = overageRatePerToken();

  const [reqRes, msgRes] = await Promise.all([
    sb
      .from("token_requests")
      .select(
        "id,user_id,tokens_requested,note,status,created_at,decided_at,tokens_granted,price_usd,admin_note"
      )
      .order("created_at", { ascending: false })
      .range(0, MAX_ROWS),
    sb
      .from("support_messages")
      .select("id,user_id,subject,body,status,created_at,admin_reply,replied_at")
      .order("created_at", { ascending: false })
      .range(0, MAX_ROWS),
  ]);
  const rawRequests = unwrap(reqRes, "token requests").data || [];
  const rawMessages = unwrap(msgRes, "support messages").data || [];

  // The profiles behind every row on the page, loaded once for both sections.
  const ids = [
    ...new Set(
      [...rawRequests, ...rawMessages].map((r) => String(r.user_id || "")).filter(Boolean)
    ),
  ];
  const profiles = ids.length
    ? unwrap(
        await sb
          .from("profiles")
          .select("id,email,tier,monthly_token_allotment")
          .in("id", ids)
          .range(0, MAX_ROWS),
        "profiles"
      ).data || []
    : [];
  const profById = new Map(profiles.map((p) => [String(p.id), p]));

  // This month's spend, same maths as the overview's usage cell, for the requesters
  // only: the support rows do not show a usage figure, so they cost no queries here.
  const reqIds = [
    ...new Set(rawRequests.map((r) => String(r.user_id || "")).filter(Boolean)),
  ];
  const usedById = new Map();
  await mapPool(reqIds, 6, async (uid) => {
    const r = await sb
      .from("usage_log")
      .select("cost")
      .eq("user_id", uid)
      .gte("at", since)
      .range(0, MAX_ROWS);
    const costUsd = (unwrap(r, "usage").data || []).reduce((a, x) => a + (Number(x.cost) || 0), 0);
    usedById.set(uid, Math.round(costUsd * tokensPerUsd()));
  });

  const who = (uid) => {
    const key = String(uid || "");
    const p = profById.get(key);
    return {
      email: (p && p.email) || "No email on file",
      shortId: key ? key.slice(0, 8) : "no user id",
      tier: (p && p.tier) || "",
      allotment: Number((p && p.monthly_token_allotment) ?? 0),
    };
  };

  const requests = rawRequests.map((r) => {
    const w = who(r.user_id);
    const asked = Math.max(0, Math.round(Number(r.tokens_requested) || 0));
    return {
      id: r.id,
      userId: String(r.user_id || ""),
      email: w.email,
      shortId: w.shortId,
      tierLabel: tierLabel(w.tier),
      allotment: w.allotment,
      used: usedById.get(String(r.user_id || "")) || 0,
      tokensRequested: asked,
      // Prefilled price: what the overage rate says that many tokens is worth.
      suggestedPrice: (Math.round(asked * rate * 100) / 100).toFixed(2),
      note: String(r.note || ""),
      status: String(r.status || "pending").toLowerCase(),
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      tokensGranted: r.tokens_granted,
      priceUsd: r.price_usd,
      adminNote: String(r.admin_note || ""),
    };
  });

  const messages = rawMessages.map((m) => {
    const w = who(m.user_id);
    return {
      id: m.id,
      email: w.email,
      shortId: w.shortId,
      subject: String(m.subject || "No subject"),
      body: String(m.body || ""),
      status: String(m.status || "open").toLowerCase(),
      createdAt: m.created_at,
      adminReply: String(m.admin_reply || ""),
      repliedAt: m.replied_at,
    };
  });

  // Work waiting floats to the top; everything else keeps the newest-first order
  // the queries already came back in (Array.sort is stable).
  requests.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));
  messages.sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1));

  const pendingRequests = requests.filter((r) => r.status === "pending").length;
  const openMessages = messages.filter((m) => m.status === "open").length;

  return { requests, messages, pendingRequests, openMessages, rate };
}

// ── inbox render ─────────────────────────────────────────────────────────────

function requestStatusClass(s) {
  if (s === "pending") return "wait";
  if (s === "approved") return "yes";
  return "";
}

function messageStatusClass(s) {
  if (s === "open") return "wait";
  if (s === "answered") return "yes";
  return "";
}

// The decision cell for a request still waiting: how many tokens to hand over, what
// to charge for them, an optional note, and the two buttons.
function approveControls(r) {
  const id = esc(String(r.id));
  return `<div class="rowact2"><span class="fld">Grant <input class="gtok" type="number" min="${TOPUP_MIN}" step="10" value="${
    r.tokensRequested
  }" aria-label="Tokens to grant"></span><span class="fld">Price $ <input class="gusd" type="number" min="0" step="0.01" value="${esc(
    r.suggestedPrice
  )}" aria-label="Price charged in USD"></span></div>
    <div class="rowact2"><input class="gnote" type="text" maxlength="${NOTE_MAX}" placeholder="Note for the record (optional)" aria-label="Admin note"></div>
    <div class="rowact"><button class="savebtn" onclick="lmApprove('${id}',this)">Approve</button><button class="minibtn danger" onclick="lmDecline('${id}',this)">Decline</button><span class="flag" id="rf-${id}"></span></div>`;
}

// The same cell once the request is decided. Mirrored by lmReqOutcome() in the
// inline script, which paints it in place after a click instead of reloading.
function requestOutcome(r) {
  const when = esc(fmtWhen(r.decidedAt));
  const note = r.adminNote ? `<br>Note: ${esc(r.adminNote)}` : "";
  if (r.status === "approved") {
    return `<div class="outcome"><b>Approved</b>, granted ${num(
      r.tokensGranted
    )} tokens for ${usd2(r.priceUsd)}${note}<br>${when}</div>`;
  }
  if (r.status === "declined") {
    return `<div class="outcome"><b>Declined</b>, nothing granted${note}<br>${when}</div>`;
  }
  return `<div class="outcome"><b>${esc(r.status)}</b>${note}<br>${when}</div>`;
}

function requestRow(r) {
  const id = esc(String(r.id));
  const pending = r.status === "pending";
  const usage = r.allotment
    ? `${num(r.used)} / ${num(r.allotment)} tokens this month`
    : `${num(r.used)} tokens used, no allotment`;
  return `<tr id="rq-${id}"${pending ? "" : ' class="done"'}>
  <td class="usercell"><div class="who">${esc(r.email)}</div><div class="sub muted">${esc(
    r.shortId
  )}</div><div class="sub muted">${esc(fmtWhen(r.createdAt))}</div></td>
  <td><div class="who">${esc(r.tierLabel)}</div><div class="sub muted">${esc(usage)}</div></td>
  <td class="n">${num(r.tokensRequested)}</td>
  <td><div class="rnote${r.note ? "" : " none"}">${
    r.note ? esc(r.note) : "No note"
  }</div></td>
  <td><span class="rstatus ${requestStatusClass(r.status)}" id="rs-${id}">${esc(
    r.status
  )}</span></td>
  <td class="decide" id="rd-${id}">${pending ? approveControls(r) : requestOutcome(r)}</td>
</tr>`;
}

function messageRow(m) {
  const id = esc(String(m.id));
  const open = m.status === "open";
  const closed = m.status === "closed";
  const replied = m.adminReply
    ? `<b>Replied</b> ${esc(fmtWhen(m.repliedAt))}<br>${esc(m.adminReply)}`
    : "";
  return `<tr id="ms-${id}"${open ? "" : ' class="done"'}>
  <td class="usercell"><div class="who">${esc(m.email)}</div><div class="sub muted">${esc(
    m.shortId
  )}</div><div class="sub muted">${esc(fmtWhen(m.createdAt))}</div></td>
  <td><div class="who">${esc(m.subject)}</div></td>
  <td class="body"><div class="msgbody">${esc(m.body)}</div></td>
  <td><span class="rstatus ${messageStatusClass(m.status)}" id="mst-${id}">${esc(
    m.status
  )}</span></td>
  <td class="decide">
    <div class="outcome" id="mo-${id}"${
      replied ? "" : ' style="display:none"'
    }>${replied}</div>
    <div id="mc-${id}"${closed ? ' style="display:none"' : ""}>
      <div class="rowact2"><textarea class="reply" maxlength="${REPLY_MAX}" placeholder="Write a reply" aria-label="Reply to ${esc(
        m.email
      )}"></textarea></div>
      <div class="rowact"><button class="savebtn" onclick="lmReply('${id}',this)">Send reply</button><button class="minibtn" onclick="lmCloseMsg('${id}',this)">Close</button><span class="flag" id="mf-${id}"></span></div>
    </div>
  </td>
</tr>`;
}

function renderInbox(d, demo = false) {
  const pending = d.pendingRequests + d.openMessages;

  const intro = `<div class="inboxnote">Requests waiting on you sort to the top. Approving one adds the tokens you enter to that customer's monthly allotment straight away, exactly like the <b>Add</b> button on the overview, and records what you charged. Extra tokens are priced at ${usd4(
    d.rate
  )} each (${centsPerToken(
    d.rate
  )} per token), which is above every plan rate on purpose, so a customer asking for a third top-up is a customer who should be upgrading.</div>`;

  const requestsTable = d.requests.length
    ? `<div class="tblwrap"><table class="inboxtbl">
<thead><tr>
  <th>Requester</th><th>Plan and usage</th><th class="n">Tokens requested</th>
  <th>Their note</th><th>Status</th><th>Decision</th>
</tr></thead>
<tbody>${d.requests.map(requestRow).join("\n")}</tbody></table></div>`
    : `<div class="empty">No token requests yet. They appear here as soon as a customer asks for more.</div>`;

  const messagesTable = d.messages.length
    ? `<div class="tblwrap"><table class="msgtbl">
<thead><tr>
  <th>From</th><th>Subject</th><th>Message</th><th>Status</th><th>Reply</th>
</tr></thead>
<tbody>${d.messages.map(messageRow).join("\n")}</tbody></table></div>`
    : `<div class="empty">No support messages yet. Anything a customer sends lands here.</div>`;

  const script = `<script>
var LM_INBOX_PENDING=${pending};
function lmNum(n){return Number(n||0).toLocaleString('en-US')}
function lmUsd(n){return '$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function lmEsc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML}
function lmFlagAt(elId,cls,txt,hold){
  var f=document.getElementById(elId); if(!f)return;
  f.className='flag'+(cls?' '+cls:''); f.textContent=txt||'';
  if(txt&&cls==='ok'&&!hold)setTimeout(function(){if(f.textContent===txt){f.textContent='';f.className='flag'}},2500);
}
function lmSetStatus(elId,txt,cls){
  var s=document.getElementById(elId); if(!s)return;
  s.className='rstatus'+(cls?' '+cls:''); s.textContent=txt;
}
// Keeps the Inbox tab badge honest without a reload: one less piece of work waiting.
function lmBadge(delta){
  LM_INBOX_PENDING=Math.max(0,LM_INBOX_PENDING+delta);
  var b=document.getElementById('lm-inbox-badge'); if(!b)return;
  if(!LM_INBOX_PENDING){b.style.display='none';b.textContent='';b.title='';return}
  b.style.display=''; b.textContent=LM_INBOX_PENDING>99?'99+':String(LM_INBOX_PENDING);
  b.title=LM_INBOX_PENDING+' waiting in the inbox';
}
async function lmPost(url,body){
  var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  var j=null; try{j=await r.json()}catch(e){}
  return j||{ok:false,error:'HTTP '+r.status};
}
// Mirrors requestOutcome() on the server, so a repainted row matches a reloaded one.
function lmReqOutcome(status,tokens,price,note,when){
  var head=status==='approved'
    ?'<b>Approved<\\/b>, granted '+lmNum(tokens)+' tokens for '+lmUsd(price)
    :'<b>Declined<\\/b>, nothing granted';
  return '<div class="outcome">'+head+(note?'<br>Note: '+lmEsc(note):'')+'<br>'+lmEsc(when||'')+'<\\/div>';
}
async function lmDecide(id,btn,path,status){
  var row=document.getElementById('rq-'+id), cell=document.getElementById('rd-'+id);
  if(!row||!cell)return;
  var body={note:(cell.querySelector('input.gnote')||{value:''}).value};
  if(status==='approved'){
    var tok=parseInt((cell.querySelector('input.gtok')||{value:''}).value,10);
    var usd=parseFloat((cell.querySelector('input.gusd')||{value:''}).value);
    if(!isFinite(tok)||tok<1){lmFlagAt('rf-'+id,'err','Enter how many tokens to grant.',true);return}
    if(!isFinite(usd)||usd<0){lmFlagAt('rf-'+id,'err','Enter the price to charge, 0 or more.',true);return}
    body.tokens=tok; body.priceUsd=usd;
  }
  btn.disabled=true; lmFlagAt('rf-'+id,'','');
  try{
    var j=await lmPost('/admin/api/request/'+encodeURIComponent(id)+'/'+path,body);
    if(j&&j.ok){
      cell.innerHTML=lmReqOutcome(status,j.tokens,j.priceUsd,j.note,j.decidedAtText);
      lmSetStatus('rs-'+id,status,status==='approved'?'yes':'');
      row.className='done'; lmBadge(-1);
    }else{lmFlagAt('rf-'+id,'err',(j&&j.error)?j.error:'Could not save that.',true); btn.disabled=false}
  }catch(e){lmFlagAt('rf-'+id,'err','Could not save that.',true); btn.disabled=false}
}
function lmApprove(id,btn){return lmDecide(id,btn,'approve','approved')}
function lmDecline(id,btn){return lmDecide(id,btn,'decline','declined')}
async function lmReply(id,btn){
  var row=document.getElementById('ms-'+id), box=document.getElementById('mc-'+id);
  if(!row||!box)return;
  var ta=box.querySelector('textarea.reply');
  var txt=ta?String(ta.value||'').trim():'';
  if(!txt){lmFlagAt('mf-'+id,'err','Write a reply before sending it.',true); if(ta)ta.focus(); return}
  btn.disabled=true; lmFlagAt('mf-'+id,'','');
  try{
    var j=await lmPost('/admin/api/support/'+encodeURIComponent(id)+'/reply',{reply:txt});
    if(j&&j.ok){
      var was=row.className!=='done';
      var out=document.getElementById('mo-'+id);
      if(out){out.style.display=''; out.innerHTML='<b>Replied<\\/b> '+lmEsc(j.repliedAtText||'')+'<br>'+lmEsc(j.reply||txt)}
      lmSetStatus('mst-'+id,'answered','yes'); row.className='done';
      if(ta)ta.value='';
      if(was)lmBadge(-1);
      lmFlagAt('mf-'+id,'ok','Sent');
    }else lmFlagAt('mf-'+id,'err',(j&&j.error)?j.error:'Could not send that.',true);
  }catch(e){lmFlagAt('mf-'+id,'err','Could not send that.',true)}
  btn.disabled=false;
}
async function lmCloseMsg(id,btn){
  var row=document.getElementById('ms-'+id), box=document.getElementById('mc-'+id);
  if(!row||!box)return;
  btn.disabled=true; lmFlagAt('mf-'+id,'','');
  try{
    var j=await lmPost('/admin/api/support/'+encodeURIComponent(id)+'/close',{});
    if(j&&j.ok){
      var was=row.className!=='done';
      lmSetStatus('mst-'+id,'closed',''); row.className='done'; box.style.display='none';
      if(was)lmBadge(-1);
    }else{lmFlagAt('mf-'+id,'err',(j&&j.error)?j.error:'Could not close that.',true); btn.disabled=false}
  }catch(e){lmFlagAt('mf-'+id,'err','Could not close that.',true); btn.disabled=false}
}
</script>`;

  const body =
    intro +
    `<div class="sectionhead">Token requests${
      d.pendingRequests ? ` (${num(d.pendingRequests)} pending)` : ""
    }</div>` +
    requestsTable +
    `<div class="sectionhead pricehead">Support messages${
      d.openMessages ? ` (${num(d.openMessages)} open)` : ""
    }</div>` +
    messagesTable;

  return page(
    body,
    script,
    demo,
    "inbox",
    "Token requests and support messages waiting on you",
    pending
  );
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

// Same guard for the inbox rows, whose primary key may be a uuid or a bigint
// depending on how the table was created, so both shapes are accepted.
function inboxRowId(req, res, what) {
  if (dataProvider() !== "supabase") {
    res.status(400).json({ ok: false, error: "Admin edits need Supabase mode." });
    return null;
  }
  const id = String(req.params.id || "").trim();
  if (!UUID_RE.test(id) && !/^[0-9]{1,19}$/.test(id)) {
    res.status(400).json({ ok: false, error: `Invalid ${what} id.` });
    return null;
  }
  return id;
}

// A top-up has to be a whole number of tokens inside the bounds. Returns the
// number, or null when it is unusable. Shared by the Add button and an approval so
// the two can never drift apart.
function topupTokens(raw) {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < TOPUP_MIN || n > TOPUP_MAX) return null;
  return n;
}

// THE top-up rule, in one place: add N tokens to a user's monthly allotment,
// refusing to go past the column ceiling. Works from a 0 allotment (no plan yet,
// account blocked): the top-up simply becomes the allotment and unblocks them.
// Returns {ok:true, previous, allotment, profile} or {ok:false, status, error}.
async function addAllotment(sb, id, n) {
  const cur = await sb
    .from("profiles")
    .select("id,email,tier,monthly_token_allotment")
    .eq("id", id)
    .maybeSingle();
  if (cur.error) return { ok: false, status: 500, error: cur.error.message };
  if (!cur.data) return { ok: false, status: 404, error: "User not found." };

  const current = Number(cur.data.monthly_token_allotment ?? 0);
  const next = current + n;
  if (next > ALLOTMENT_MAX) {
    return {
      ok: false,
      status: 400,
      error: `That would push the allotment past ${num(ALLOTMENT_MAX)}.`,
    };
  }

  const { data, error } = await sb
    .from("profiles")
    .update({ monthly_token_allotment: next })
    .eq("id", id)
    .select("id,tier,monthly_token_allotment");
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data || !data.length) return { ok: false, status: 404, error: "User not found." };
  return { ok: true, previous: current, allotment: next, profile: data[0] };
}

// Why a conditional claim came back empty: the row is gone, or somebody already
// decided it. Used to turn a lost race into one clear sentence for the operator.
async function decidedAlreadyMessage(sb, id) {
  try {
    const r = await sb.from("token_requests").select("status").eq("id", id).maybeSingle();
    const st = r && r.data ? String(r.data.status || "").toLowerCase() : "";
    if (!st) return "That request no longer exists. Nothing was granted.";
    return `That request is already ${st}, so it was left alone. Nothing was granted.`;
  } catch {
    return "That request is no longer pending. Nothing was granted.";
  }
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
    // The spend lookup is a third-party call: never let it fail the page. The
    // inbox count is best-effort for the same reason and resolves to 0 on trouble.
    const [data, spend, pending] = await Promise.all([
      loadOverview(),
      apifySpend().catch(() => null),
      pendingInboxCount(),
    ]);
    res.send(renderOverview(data, spend, !!req.isDemo, req.userEmail || "", pending));
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
    const [data, pending] = await Promise.all([loadAnalytics(), pendingInboxCount()]);
    res.send(renderAnalytics(data, !!req.isDemo, pending));
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

// Unit economics. Guarded exactly like the other admin pages, but deliberately NOT
// gated on supabase mode: it reads no user data, only the env constants, so it is
// just as useful against a local sqlite instance.
adminRouter.get("/admin/pricing", requireUser, requireAdmin, async (req, res) => {
  try {
    const pending = await pendingInboxCount();
    res.send(renderPricing(pricingModel(), !!req.isDemo, pending));
  } catch (e) {
    res
      .status(500)
      .send(
        page(
          noticeCard(
            "Could not work out the pricing",
            `Something in the pricing constants is unusable: <code>${esc(
              e && e.message ? e.message : String(e)
            )}</code>`
          ),
          "",
          !!req.isDemo,
          "pricing"
        )
      );
  }
});

// The operator inbox: token requests and support messages. Same guard chain and
// same supabase-mode gate as the overview, since both sections are cross-user data.
adminRouter.get("/admin/inbox", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") {
    return res.send(
      page(
        noticeCard(
          "The inbox needs Supabase mode",
          "This app is running on local SQLite, which is single-user, so there is nobody to be asking for tokens or writing in for help. " +
            "Set <code>DATA_PROVIDER=supabase</code> in <code>.env</code> (with the project URL and service-role key) and restart to work the queue here."
        ),
        "",
        false,
        "inbox",
        "Token requests and support messages waiting on you"
      )
    );
  }
  try {
    const data = await loadInbox();
    res.send(renderInbox(data, !!req.isDemo));
  } catch (e) {
    res
      .status(500)
      .send(
        page(
          noticeCard(
            "Could not load the inbox",
            `Supabase returned an error: <code>${esc(e && e.message ? e.message : String(e))}</code>`
          ),
          "",
          !!req.isDemo,
          "inbox",
          "Token requests and support messages waiting on you"
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

    const n = topupTokens((req.body || {}).tokens);
    if (n === null) {
      return res.status(400).json({
        ok: false,
        error: `Tokens to add must be a whole number between ${num(TOPUP_MIN)} and ${num(TOPUP_MAX)}.`,
      });
    }

    try {
      const sb = await getSupabase();
      const r = await addAllotment(sb, id, n);
      if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
      res.json({
        ok: true,
        added: n,
        previous: r.previous,
        allotment: r.allotment,
        profile: r.profile,
      });
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

// ── inbox routes ─────────────────────────────────────────────────────────────

// Approve a token request: hand over the tokens the operator entered and record
// what was charged for them.
//
// Double-click safety. The status flip happens FIRST, as an update filtered on
// `status = 'pending'`. PostgREST returns the rows it actually changed, so exactly
// one caller can ever see a row come back: the loser gets an empty result, is told
// the request is already decided, and grants nothing. Only the winner goes on to
// touch the allotment. If that grant then fails the row is put back to pending, so
// a request is never left marked approved with nothing handed over.
adminRouter.post(
  "/admin/api/request/:id/approve",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = inboxRowId(req, res, "request");
    if (!id) return;

    const body = req.body || {};
    const tokens = topupTokens(body.tokens);
    if (tokens === null) {
      return res.status(400).json({
        ok: false,
        error: `Tokens to grant must be a whole number between ${num(TOPUP_MIN)} and ${num(
          TOPUP_MAX
        )}.`,
      });
    }

    const rawPrice = body.priceUsd;
    const price = typeof rawPrice === "number" ? rawPrice : Number(String(rawPrice ?? "").trim());
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ ok: false, error: "Price charged must be zero or more." });
    }
    if (price > PRICE_MAX) {
      return res
        .status(400)
        .json({ ok: false, error: `Price charged must be ${usd2(PRICE_MAX)} or less.` });
    }
    const priceUsd = Math.round(price * 100) / 100;
    const note = cleanText(body.note, NOTE_MAX);

    try {
      const sb = await getSupabase();
      const decidedAt = new Date().toISOString();

      const claim = await sb
        .from("token_requests")
        .update({
          status: "approved",
          tokens_granted: tokens,
          price_usd: priceUsd,
          admin_note: note || null,
          decided_at: decidedAt,
        })
        .eq("id", id)
        .eq("status", "pending")
        .select("id,user_id,status,tokens_requested,tokens_granted,price_usd,decided_at");
      if (claim.error) return res.status(500).json({ ok: false, error: claim.error.message });

      const row = (claim.data || [])[0];
      if (!row) {
        return res.status(409).json({ ok: false, error: await decidedAlreadyMessage(sb, id) });
      }

      const grant = await addAllotment(sb, String(row.user_id || ""), tokens);
      if (!grant.ok) {
        await sb
          .from("token_requests")
          .update({
            status: "pending",
            tokens_granted: null,
            price_usd: null,
            admin_note: null,
            decided_at: null,
          })
          .eq("id", id);
        return res
          .status(grant.status)
          .json({ ok: false, error: `${grant.error} Nothing was granted, the request is still pending.` });
      }

      res.json({
        ok: true,
        id: row.id,
        userId: String(row.user_id || ""),
        status: "approved",
        tokens,
        priceUsd,
        note,
        decidedAt,
        decidedAtText: fmtWhen(decidedAt),
        previous: grant.previous,
        allotment: grant.allotment,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Approve failed." });
    }
  }
);

// Decline a token request. Same conditional claim, so a second click is refused
// the same way, and nothing is ever added to anyone's allotment.
adminRouter.post(
  "/admin/api/request/:id/decline",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = inboxRowId(req, res, "request");
    if (!id) return;

    const note = cleanText((req.body || {}).note, NOTE_MAX);

    try {
      const sb = await getSupabase();
      const decidedAt = new Date().toISOString();

      const claim = await sb
        .from("token_requests")
        .update({ status: "declined", admin_note: note || null, decided_at: decidedAt })
        .eq("id", id)
        .eq("status", "pending")
        .select("id,user_id,status,decided_at");
      if (claim.error) return res.status(500).json({ ok: false, error: claim.error.message });

      const row = (claim.data || [])[0];
      if (!row) {
        return res.status(409).json({ ok: false, error: await decidedAlreadyMessage(sb, id) });
      }

      res.json({
        ok: true,
        id: row.id,
        userId: String(row.user_id || ""),
        status: "declined",
        note,
        decidedAt,
        decidedAtText: fmtWhen(decidedAt),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Decline failed." });
    }
  }
);

// Answer a support message. Replying to an already answered thread is allowed
// (the operator is following up); the newest reply is the one stored.
adminRouter.post(
  "/admin/api/support/:id/reply",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = inboxRowId(req, res, "message");
    if (!id) return;

    const reply = cleanText((req.body || {}).reply, REPLY_MAX);
    if (!reply) {
      return res.status(400).json({ ok: false, error: "Write a reply before sending it." });
    }

    try {
      const sb = await getSupabase();
      const repliedAt = new Date().toISOString();
      const { data, error } = await sb
        .from("support_messages")
        .update({ admin_reply: reply, replied_at: repliedAt, status: "answered" })
        .eq("id", id)
        .select("id,user_id,status,admin_reply,replied_at");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) {
        return res.status(404).json({ ok: false, error: "That message no longer exists." });
      }

      res.json({
        ok: true,
        id: data[0].id,
        status: "answered",
        reply,
        repliedAt,
        repliedAtText: fmtWhen(repliedAt),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Reply failed." });
    }
  }
);

// Close a support message: done with, whether or not it was answered.
adminRouter.post(
  "/admin/api/support/:id/close",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    const id = inboxRowId(req, res, "message");
    if (!id) return;

    try {
      const sb = await getSupabase();
      const { data, error } = await sb
        .from("support_messages")
        .update({ status: "closed" })
        .eq("id", id)
        .select("id,user_id,status");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) {
        return res.status(404).json({ ok: false, error: "That message no longer exists." });
      }
      res.json({ ok: true, id: data[0].id, status: "closed" });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Close failed." });
    }
  }
);

export default adminRouter;
