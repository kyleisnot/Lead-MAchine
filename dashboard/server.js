// server.js — the Prospector dashboard: find local businesses with no website (Search)
// and work them on one Leads page (found · tracked · follow-up).
//
// Multi-user: ./auth.js resolves WHO is asking (req.userId / req.userEmail / req.isAdmin)
// and every data call goes through ../data/store.js scoped to that user. In sqlite (local
// dev) mode there is a single "local" user and no login at all.

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as store from "../data/store.js";
import { discover, discoverMany, willSearchSpend } from "../lib/pipeline.js";
import { NICHES } from "../lib/niches.js";
import { lastActiveLabel, activityStatus, activitySignal, cutoffLabel, freshnessConfig } from "../lib/freshness.js";
import { spendCapState, RATE_PER_1K } from "../lib/spend.js";
import { detectLicenseSignal, licenseSearchUrl } from "../lib/license.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar, FAVICON } from "./shell.js";
import { authRouter, requireUser } from "./auth.js";
import { adminRouter } from "./admin.js";
import { demoRouter } from "./demo.js";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

// Express 4 doesn't await handlers, so an async route that throws would become an
// unhandled rejection. Wrap them so failures become normal 500s.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json());
app.use(express.static(join(__dirname, "public"))); // serves /logo.png, /mark.png

// ── Wiring order matters ──
// 1. authRouter: /login, /signup, /logout must stay reachable while logged out.
// 2. requireUser: everything below this line has req.userId / req.userEmail / req.isAdmin.
// (adminRouter is mounted after the routes, near app.listen.)
// Public config health check (booleans only — never values). Lets us see whether the
// deployment actually received its Supabase env vars, under any of the common names.
app.get("/healthz", (req, res) => {
  const has = (k) => !!(process.env[k] && String(process.env[k]).trim());
  res.json({
    ok: true,
    provider: (process.env.DATA_PROVIDER || "sqlite").toLowerCase(),
    urlSet: has("SUPABASE_URL") || has("NEXT_PUBLIC_SUPABASE_URL"),
    anonKeySet: has("SUPABASE_ANON_KEY") || has("NEXT_PUBLIC_SUPABASE_ANON_KEY") || has("SUPABASE_KEY") || has("SUPABASE_PUBLISHABLE_KEY"),
    serviceKeySet: has("SUPABASE_SERVICE_ROLE_KEY") || has("SUPABASE_SERVICE_KEY") || has("SUPABASE_SECRET_KEY"),
    jwtSecretSet: has("SUPABASE_JWT_SECRET"),
    apifyTokenSet: has("APIFY_TOKEN"),
  });
});

app.use(authRouter);
app.use(requireUser);

// Cost is shown as "tokens" (a credit unit) instead of raw dollars. 1 USD = TOKENS_PER_USD tokens.
const TOKENS_PER_USD = parseFloat(process.env.TOKENS_PER_USD || "75") || 75;
const usdToTokens = (usd) => Math.max(0, Math.round((Number(usd) || 0) * TOKENS_PER_USD));

function planResetLabel() {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
// Tokens THIS USER has spent this calendar month (their metered search/AI cost).
async function monthTokensUsed(userId) {
  const u = await store.usageSummary(userId);
  return usdToTokens(u.aiUsd || 0);
}
// Block a live (credit-spending) search once this user's monthly allotment is used up.
// Their allotment lives on their profile row (0 = unlimited); it refills on the 1st.
async function blockedByAllotment(req, res, { live }) {
  if (!live) return false;
  // An admin presenting a demo (staged or prospect) must never be stalled mid-meeting
  // by the TARGET account's plan — the gate applies to real customers only.
  if (req.isDemo) return false;
  const profile = await store.getProfile(req.userId);
  const allotment = parseInt(profile?.monthly_token_allotment, 10) || 0;
  if (!allotment) return false;
  const used = await monthTokensUsed(req.userId);
  if (used >= allotment) {
    res.status(429).json({
      ok: false,
      error: `You've used all ${allotment.toLocaleString()} tokens in your plan this month. ` +
             `They refill on ${planResetLabel()} — or add a token pack to keep searching now.`,
    });
    return true;
  }
  return false;
}

// Block a search if this month's Apify spend has hit the configured cap.
// This is the OPERATOR's kill-switch (our real Apify bill), separate from a user's plan
// allotment above. `forceRefresh`/batch runs spend credits; cached single searches don't,
// so we only guard live calls. Returns true when it has already answered the request.
async function blockedBySpendCap(res, { live }) {
  if (!live) return false;
  const cap = await spendCapState();
  if (cap.blocked) {
    res.status(429).json({
      ok: false,
      error: `Token cap reached: ${usdToTokens(cap.spent).toLocaleString()} / ${usdToTokens(cap.cap).toLocaleString()} tokens this month. ` +
             `Raise APIFY_MONTHLY_CAP in .env to keep scanning.`,
    });
    return true;
  }
  return false;
}

// ── SEARCH API: run a live lookup (Google + Facebook) for a niche + city ──
app.post("/api/search", async (req, res) => {
  const { niche, city, state, sources, limit, forceRefresh } = req.body;
  if (!niche || !city) return res.status(400).json({ ok: false, error: "Need a niche and a city." });
  try {
    // Any search that will actually hit Apify (a cold/uncached lookup OR a forced re-scan)
    // spends credits — guard ALL of those, not just forced re-scans. Cached searches are
    // free and stay allowed even when capped.
    const resolvedSources = sources?.length ? sources : ["google", "facebook"];
    const willSpend = await willSearchSpend({ userId: req.userId, niche, city, state, sources: resolvedSources, limit: limit || 30, forceRefresh: !!forceRefresh });
    if (await blockedBySpendCap(res, { live: willSpend })) return;
    if (await blockedByAllotment(req, res, { live: willSpend })) return;
    const { prospects, stats, cached, cachedAt } = await discover({
      userId: req.userId,
      niche,
      city,
      state,
      sources: resolvedSources,
      limit: limit || 30,
      forceRefresh: !!forceRefresh,
    });
    res.json({ ok: true, stats, cached: !!cached, cachedAt: cachedAt || null, prospects: prospects.map(slimProspect) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── BATCH SEARCH API: many niches × many cities in one run (the "scan more" lever) ──
app.post("/api/search-batch", async (req, res) => {
  const { niches, cities, state, sources, limit, forceRefresh } = req.body;
  const nicheList = (Array.isArray(niches) ? niches : []).filter(Boolean);
  const cityList = (Array.isArray(cities) ? cities : []).filter(Boolean);
  if (!nicheList.length || !cityList.length) {
    return res.status(400).json({ ok: false, error: "Pick at least one niche and one city." });
  }
  try {
    if (await blockedBySpendCap(res, { live: true })) return;
    if (await blockedByAllotment(req, res, { live: true })) return;
    const { prospects, stats } = await discoverMany({
      userId: req.userId,
      niches: nicheList,
      cities: cityList,
      state,
      sources: sources?.length ? sources : ["google", "facebook"],
      limit: limit || 30,
      forceRefresh: !!forceRefresh,
    });
    res.json({ ok: true, stats, prospects: prospects.map(slimProspect) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CRM API ──
app.post("/api/crm/save/:id", route(async (req, res) => {
  await store.saveToCrm(req.userId, req.params.id);
  res.json({ ok: true });
}));
app.post("/api/crm/remove/:id", route(async (req, res) => {
  await store.removeFromCrm(req.userId, req.params.id);
  res.json({ ok: true });
}));
// Mark off a business so it won't show up in future searches.
app.post("/api/dismiss/:id", route(async (req, res) => {
  await store.dismissLead(req.userId, req.params.id);
  res.json({ ok: true });
}));

// Your ✓/✗ on whether our "last active" tag was right (trains/validates the dating).
app.post("/api/activity-feedback/:id", route(async (req, res) => {
  const { verdict, seen } = req.body || {};
  await store.setActivityFeedback(req.userId, req.params.id, verdict, seen || "");
  res.json({ ok: true, counts: await store.activityFeedbackCounts(req.userId) });
}));
app.post("/api/crm/update/:id", route(async (req, res) => {
  await store.updateCrm(req.userId, req.params.id, { stage: req.body.stage, notes: req.body.notes });
  res.json({ ok: true });
}));

// ── LEADS: one page, three tabs (tracked · found · follow-up) ──
// `tracked` is the old CRM table, `found` is every lead the machine has surfaced
// (the old Brain "Your leads" tab, now actionable), `followup` is the old CRM tab.
app.get("/leads", route(async (req, res) => res.send(await renderLeadsPage(req, req.query.view))));

// Old URLs keep working: /crm and /brain are now tabs of /leads.
app.get("/crm", (req, res) =>
  res.redirect(302, req.query.view === "followup" ? "/leads?view=followup" : "/leads")
);
app.get("/brain", (req, res) => res.redirect(302, "/leads?view=found"));

// ── Manual follow-ups (your own reminders) ──
app.post("/api/followup/add", route(async (req, res) => {
  const { title, note, due } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ ok: false, error: "Add a name first." });
  const id = await store.addFollowup(req.userId, { title: title.trim(), note, due });
  res.json({ ok: true, id });
}));
app.post("/api/followup/update/:id", route(async (req, res) => {
  await store.updateFollowup(req.userId, req.params.id, req.body || {});
  res.json({ ok: true });
}));
app.post("/api/followup/remove/:id", route(async (req, res) => {
  await store.removeFollowup(req.userId, req.params.id);
  res.json({ ok: true });
}));

// Usage tracker — PER USER: the tokens they've spent this month against their plan.
// (Our real operator cost, e.g. the Apify bill, lives in the admin panel instead.)
app.get("/api/usage", route(async (req, res) => {
  const [u, profile] = await Promise.all([store.usageSummary(req.userId), store.getProfile(req.userId)]);
  const allotment = parseInt(profile?.monthly_token_allotment, 10) || 0; // 0 = unlimited
  const tokens = usdToTokens(u.aiUsd || 0);
  res.json({
    ok: true,
    tokens,
    allotment: allotment || null,
    planRemaining: allotment ? Math.max(0, allotment - tokens) : null,
    resetsOn: planResetLabel(),
    searches: u.searches,
    builds: u.builds,
  });
}));

// How many businesses this user's brain has remembered (and how many had websites).
app.get("/api/memory", route(async (req, res) => {
  const s = await store.checkedStats(req.userId);
  res.json({ ok: true, total: s.total || 0, withSite: s.withSite || 0, noSite: (s.total || 0) - (s.withSite || 0) });
}));

function slimProspect(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    city: l.city,
    state: l.state,
    phone: l.phone,
    email: l.email || "",
    source: l.source,
    website: l.website || "",
    reviews: l.reviews ?? null,
    rating: l.rating ?? null,
    lastActive: lastActiveLabel(lj), // "Mar 2025" or "" when unknown
    activeStatus: activityStatus(lj), // "active" | "stale" | "unknown"
    activeSignal: activitySignal(lj), // "FB post" | "IG post" | "Google review"
    verdict: l.activity_verdict || "", // your ✓/✗ on the activity tag, if given
    license: detectLicenseSignal(lj), // { status, number, evidence } — best-effort license/registration signal
    licenseUrl: licenseSearchUrl(lj), // one-click official-search link to confirm
    saved: !!l.saved,
  };
}

// Restore the most recent search (so leaving for the CRM and coming back keeps results).
app.get("/api/last-search", route(async (req, res) => {
  const ls = await store.getState(req.userId, "last_search");
  if (!ls) return res.json({ ok: true, empty: true });
  const rows = await store.getLeadsByIds(req.userId, ls.ids || []);
  res.json({
    ok: true,
    query: { niche: ls.niche, city: ls.city, state: ls.state, sources: ls.sources, limit: ls.limit },
    stats: ls.stats,
    prospects: rows.map(slimProspect),
  });
}));

// Landing page = the search/prospector UI.
app.get("/", route(async (req, res) => res.send(await renderSearchPage(req))));

// Operator-only panel. Mounted LAST so it can't shadow a user route; its own
// requireUser + requireAdmin guards live inside admin.js.
app.use(adminRouter);
// Live-meeting demo screen (admin only). Same deal: guards live inside demo.js.
app.use(demoRouter);

// Default to loopback: this dashboard spends credits, so it should only be reachable
// from other machines when you deliberately set BIND_HOST (e.g. 0.0.0.0 in a container).
// On Vercel the platform owns the socket — api/index.js just exports this app, so we
// must NOT bind a port there.
if (!process.env.VERCEL) {
  app.listen(PORT, process.env.BIND_HOST || "127.0.0.1", () => {
    console.log(`\n🛰  Prospector → http://localhost:${PORT}\n`);
  });
}

// Default export so a serverless host (api/index.js) can use the app as its handler.
export default app;

// ── HTML rendering (kept simple: server-rendered + a little fetch JS) ──
function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// License/registration badge (server-rendered) for the CRM table. Best-effort signal
// from the lead's own profile text + a one-click official-verify link. Inline-styled so it
// works on every page with no extra CSS.
function licenseBadgeHtml(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  const sig = detectLicenseSignal(lj);
  const url = licenseSearchUrl(lj);
  const on = sig.status === "mentioned";
  const label = on ? `🪪 ${esc(sig.evidence || "licensed/registered")}` : "🪪 no license info";
  const bg = on ? "rgba(40,200,100,.14)" : "rgba(255,255,255,.06)";
  const color = on ? "#28c864" : "#7b8499";
  return `<span title="${on ? "What the business advertises — confirm with Verify" : "Nothing found in their profile — check the official search"}" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;background:${bg};color:${color}">${label}</span> <a href="${url}" target="_blank" rel="noopener" style="color:#14FFB9;font-size:12px;text-decoration:none">verify ↗</a>`;
}

// ── SEARCH / PROSPECTOR PAGE ──
async function renderSearchPage(req) {
  const nicheButtons = NICHES.map(
    (n) => `<button type="button" class="chip" onclick="setNiche('${n.key}')">${esc(n.key)}</button>`
  ).join("");
  // Plain-English explainer values (the tool's targeting rules, shown in the UI).
  const explainNiches = NICHES.map((n) => esc(n.key)).join(" · ");
  const fcfg = freshnessConfig();
  const activeExplain = !fcfg.enabled
    ? "This check is currently off, so businesses are kept no matter how long ago they were last active."
    : `We look at each business's newest Facebook or Instagram post (or Google review). If the most recent one is older than <b>${esc(cutoffLabel())}</b>, we skip them &mdash; a business that's gone quiet probably isn't taking new customers.`;
  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector — Search</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1100px;margin:auto}
  header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .nav{margin-left:auto;display:flex;gap:16px;align-items:center;flex-wrap:wrap;row-gap:10px}.nav a{color:var(--gold);text-decoration:none;font-weight:600;font-size:14px}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .row{display:grid;grid-template-columns:1.4fr 1.4fr .7fr .9fr auto;gap:12px;align-items:end}
  label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);display:block;margin-bottom:5px}
  input,select{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .chip{background:rgba(20,255,185,.08);border:1px solid var(--border);color:var(--text);border-radius:20px;padding:6px 13px;font-size:12px;cursor:pointer}
  .chip:hover{background:rgba(20,255,185,.2)}
  .go{background:var(--gold);color:#000;border:none;border-radius:8px;padding:11px 22px;font-weight:700;cursor:pointer;font-size:15px;white-space:nowrap}
  .go:disabled{opacity:.5;cursor:wait}
  .rescan{background:transparent;border:1px solid var(--border);color:var(--gold);border-radius:8px;padding:11px 14px;cursor:pointer;font-size:15px}
  .rescan:hover{background:rgba(20,255,185,.12)}.rescan:disabled{opacity:.5;cursor:wait}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
  .stat{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
  .stat .n{font-size:28px;font-weight:800}.stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-top:3px}
  .good .n{color:#28c864}
  .lead{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
  .lead h3{font-size:16px}.lead .meta{color:var(--muted);font-size:13px;margin-top:4px}
  .badge{display:inline-block;background:rgba(20,255,185,.18);color:var(--gold);font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;margin-left:6px}
  .src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .build{background:rgba(20,255,185,.15);border:1px solid var(--border);color:var(--gold);border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer;font-size:13px}
  .build:hover{background:rgba(20,255,185,.28)}
  .save{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:var(--text);border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer;font-size:13px}
  .save:hover{background:rgba(255,255,255,.12)}.save.saved-on{background:rgba(40,200,100,.18);border-color:rgba(40,200,100,.4);color:#28c864}
  .hide{background:transparent;border:1px solid rgba(255,255,255,.14);color:var(--muted);border-radius:8px;padding:9px 12px;cursor:pointer;font-size:13px}
  .hide:hover{color:#e05b5b;border-color:#e05b5b}
  .muted{color:var(--muted)}.email{color:#28c864;font-size:13px}.noemail{color:#e0a93b;font-size:13px}
  #status{margin:10px 0;min-height:20px;font-size:14px}
  .memline{margin:4px 0 2px;font-size:13px;color:var(--muted)}.memline b{color:var(--gold)}
  .opts{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px;font-size:13px}
  .opt{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
  .opt input{width:auto;margin:0}
  .optsep{width:1px;height:16px;background:rgba(255,255,255,.14)}
  .estimate{margin-top:10px;font-size:13px;color:var(--muted)}
  .estimate b{color:var(--gold)}.estimate.big{color:#e0a93b}.estimate.big b{color:#e0a93b}
  .fresh-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;margin-top:6px}
  .fresh-active{background:rgba(40,200,100,.16);color:#28c864}
  .fresh-unknown{background:rgba(224,169,59,.16);color:#e0a93b}
  .lic-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .lic-yes{background:rgba(40,200,100,.14);color:#28c864}
  .lic-no{background:rgba(255,255,255,.06);color:var(--muted)}
  .lic-verify{color:var(--gold);font-size:12px;text-decoration:none;margin-left:6px}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--gold);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
${SHARED_CSS}</style></head><body>
${sidebar("search", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Search</h1><div class="pagesub">Find local businesses that don't have a website yet</div></div><div class="spacer"></div>
  <div class="statbox">
    <div class="cell"><span class="k"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:4px"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>Remembered</span><span class="v" id="sbMem">—</span><span class="s2" id="sbMemSub"></span></div>
    <div class="sep"></div>
    <div class="cell"><span class="k">Tokens used</span><span class="v" id="sbTok">—</span><span class="s2" id="sbSearches"></span><div class="tokbar" id="sbBarWrap"><div class="tokbar-fill" id="sbBar"></div></div></div>
  </div>
</div>

<details class="explain">
  <summary><span class="ex-ttl">What counts as a lead?</span><span class="ex-sub">a business must pass all 3 checks to show up here</span></summary>
  <div class="ex-body">
    <div class="ex-item"><span class="ex-num">1</span><div><b>It's one of your trades</b><p>${explainNiches}</p></div></div>
    <div class="ex-item"><span class="ex-num">2</span><div><b>It has no real website</b><p>A Facebook, Instagram, or Yelp page doesn't count &mdash; we're after businesses with no website of their own (so you can offer to build them one).</p></div></div>
    <div class="ex-item"><span class="ex-num">3</span><div><b>It's still active</b><p>${activeExplain}</p></div></div>
    <p class="ex-foot">Miss any one of these and the business is skipped. Everything we've ever scanned is <b>remembered</b> so we never re-check it &mdash; but only the ones that pass all three land in <b>Leads</b>.</p>
  </div>
</details>

<div class="panel searchpanel">
  <div class="fgroup">
    <div class="glabel">Where</div>
    <div class="frow where">
      <div class="f"><label for="city">City <span class="hint">comma-separate for several</span></label><input id="city" placeholder="Knoxville, Maryville, Oak Ridge" value="Knoxville"></div>
      <div class="f"><label for="state">State</label><input id="state" placeholder="TN" value="TN"></div>
    </div>
  </div>

  <div class="fgroup">
    <div class="glabel">What</div>
    <div class="f"><label for="niche">Trade</label><input id="niche" placeholder="landscaping" value="landscaping"></div>
    <div class="chips">${nicheButtons}</div>
    <label class="opt"><input type="checkbox" id="allNiches" oninput="updateEstimate()"> Search <b>all trades</b> at once</label>
  </div>

  <div class="fgroup">
    <div class="glabel">How deep</div>
    <div class="frow deep">
      <div class="f"><label for="source">Sources</label><select id="source">
        <option value="all">All (Google + Facebook + Instagram)</option>
        <option value="facebook">Facebook only</option>
        <option value="instagram">Instagram only</option>
        <option value="google">Google only</option>
      </select></div>
      <div class="f"><label for="limit">Depth <span class="hint">deeper finds more, takes longer</span></label><select id="limit" onchange="updateEstimate()">
        <option value="20">Quick</option>
        <option value="60">Standard</option>
        <option value="150">Thorough</option>
      </select></div>
    </div>
  </div>

  <div class="gorow">
    <div id="estimate" class="estimate"></div>
    <div class="gobtns">
      <button class="rescan" id="rescanBtn" onclick="runSearch(true)" title="Re-scan live with fresh data (spends credits)">Re-scan</button>
      <button class="go" id="goBtn" onclick="runSearch(false)">Search</button>
    </div>
  </div>
</div>
<script>
  var NICHE_KEYS = ${JSON.stringify(NICHES.map((n) => n.key))};
  var RATE_PER_1K = ${RATE_PER_1K};
  var TOKENS_PER_USD = ${TOKENS_PER_USD};
</script>

<div id="status"></div>
<div id="statsWrap"></div>
<div id="results"></div>

<script>
function setNiche(n){document.getElementById('niche').value=n;updateEstimate()}
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function st(html){document.getElementById('status').innerHTML=html}
// Rough run-time model (measured: a 3-source Quick scan ~2.5 min). Per source there's
// a startup cost plus per-place work; the dating pass adds a flat ~35s.
function estSeconds(sources,depth){return Math.round(sources*(18+depth*1.1)+35);}
function fmtMin(sec){return Math.max(1,Math.round(sec/60))+' min';}
// Typical yield per city — a soft guide, NOT a promise (real count depends on the area).
function leadRange(depth){return depth<=20?[5,15]:depth<=60?[12,25]:[20,40];}
function mmss(s){var m=Math.floor(s/60),x=s%60;return m+':'+(x<10?'0':'')+x;}
var PROG_STAGES=['Scanning Google Maps\u2026','Checking Facebook pages\u2026','Checking Instagram profiles\u2026','Dropping businesses that already have a website\u2026','Checking who is still active\u2026','Putting your leads together\u2026'];
var progTimer=null;
function startProgress(expSec){
  var t0=Date.now();
  clearInterval(progTimer);
  var per=Math.max(4,expSec/PROG_STAGES.length);
  function tick(){
    var el=Math.round((Date.now()-t0)/1000);
    var stage=PROG_STAGES[Math.min(PROG_STAGES.length-1,Math.floor(el/per))];
    st('<span class="spinner"></span> '+stage+' <span style="opacity:.7">\u2014 '+mmss(el)+' elapsed, usually about '+fmtMin(expSec)+'</span>');
  }
  tick(); progTimer=setInterval(tick,1000);
}
function stopProgress(){clearInterval(progTimer);progTimer=null;}

// "Knoxville, Maryville" → ["Knoxville","Maryville"]
function parseCities(){return document.getElementById('city').value.split(',').map(s=>s.trim()).filter(Boolean)}
function chosenSources(){const s=document.getElementById('source').value;return s==='all'?['google','facebook','instagram']:[s]}
function chosenNiches(){return document.getElementById('allNiches').checked?NICHE_KEYS.slice():[document.getElementById('niche').value.trim()].filter(Boolean)}

// Live "this will scan ≈ N places (≈ $X)" estimate. Multiplies cities × niches × sources × depth.
function updateEstimate(){
  const cities=parseCities().length||1, niches=chosenNiches().length||1, sources=chosenSources().length, depth=parseInt(document.getElementById('limit').value)||0;
  const cells=cities*niches;
  const places=cells*sources*depth;
  const tokens=Math.round((places/1000)*RATE_PER_1K*TOKENS_PER_USD);
  const totalSec=cells*estSeconds(sources,depth);
  const el=document.getElementById('estimate');
  const big=totalSec>700; // near the server's run limit
  el.className='estimate'+(big?' big':'');
  if(cells>1){
    el.innerHTML=(big?'⚠️ ':'')+'Batch of <b>'+cells+'</b> searches · about <b>'+fmtMin(totalSec)+'</b> · ~<b>'+tokens.toLocaleString()+' tokens</b>'+(big?' <span style="opacity:.85">— may be too big to finish in one run</span>':'');
    return;
  }
  const lr=leadRange(depth);
  el.innerHTML='Usually <b>~'+lr[0]+'\u2013'+lr[1]+' leads</b> · about <b>'+fmtMin(totalSec)+'</b> · ~<b>'+tokens.toLocaleString()+' tokens</b> <span style="opacity:.65">\u2014 varies by city</span>';
}

async function runSearch(force){
  const cities=parseCities();
  if(!cities.length){st('❌ Enter at least one city.');return}
  const niches=chosenNiches();
  if(!niches.length){st('❌ Enter a niche (or tick All trades).');return}
  const sources=chosenSources();
  const depth=parseInt(document.getElementById('limit').value);
  const multi=cities.length>1||niches.length>1;
  const places=cities.length*niches.length*sources.length*depth;

  // A single search must finish inside the server's run limit. Warn before one whose
  // estimate is long enough to risk timing out.
  const expSec=(cities.length*niches.length)*estSeconds(sources.length,depth);
  if(expSec>700&&!confirm('This search could take about '+Math.round(expSec/60)+' minutes, which may be too big to finish in one run. Try fewer trades/cities or a lower depth. Run it anyway?')) return;

  const btn=document.getElementById('goBtn'),rb=document.getElementById('rescanBtn');btn.disabled=true;rb.disabled=true;
  document.getElementById('results').innerHTML='';document.getElementById('statsWrap').innerHTML='';

  startProgress(expSec);
  let r;
  if(multi){
    r=await post('/api/search-batch',{niches,cities,state:document.getElementById('state').value,sources,limit:depth,forceRefresh:!!force});
  }else{
    r=await post('/api/search',{niche:niches[0],city:cities[0],state:document.getElementById('state').value,sources,limit:depth,forceRefresh:!!force});
  }
  stopProgress();
  btn.disabled=false;rb.disabled=false;
  if(!r.ok){st('❌ '+r.error);return}
  render(r.stats,r.prospects,multi?'batch':(r.cached?'cached':'fresh'));
  loadMemory();
}
async function loadMemory(){
  try{const m=await (await fetch('/api/memory')).json();
    if(m.ok&&m.total){var mem=document.getElementById('sbMem'),sub=document.getElementById('sbMemSub');
      if(mem)mem.textContent=Number(m.total).toLocaleString();
      if(sub)sub.textContent=Number(m.noSite).toLocaleString()+' no site · '+Number(m.withSite).toLocaleString()+' had one';}
  }catch(e){}
}
loadMemory();
function render(s,prospects,mode){
  document.getElementById('statsWrap').innerHTML=
    '<div class="stats" style="grid-template-columns:repeat(3,1fr)">'+
    stat(s.qualified,'No-website leads','good')+stat(s.scanned||'—','Scanned')+stat(s.hasWebsite!=null?s.hasWebsite:'—','Already had a site')+
    '</div>';
  if(!prospects.length){st(mode==='fresh'||mode==='batch'?'No qualified (no-website) leads found. Try a higher Depth, more cities, or All trades.':'No saved leads here yet — hit Search to find some.');return}
  var msg = mode==='cached' ? '💾 Saved results — <b>$0 credits used</b>. Hit 🔄 to re-scan for fresh data.'
          : mode==='restored' ? '↩️ Restored your last search (no credits used).'
          : mode==='batch' ? 'Batch scan done across <b>'+(s.cells||'?')+'</b> niche×city combos. Found <b>'+prospects.length+'</b> qualified leads.'
          : 'Found <b>'+prospects.length+'</b> qualified leads. Save the ones you want to track.';
  // Show WHY leads were dropped (transparency), with the real cutoff label.
  var since=s.sinceLabel?(' since '+s.sinceLabel):'';
  var parts=[];
  if(s.staleSeen)parts.push('<b>'+s.staleSeen+'</b> too old');
  if(s.unknownSeen)parts.push('<b>'+s.unknownSeen+'</b> undated');
  var hid = (s.inactive||parts.length) ? ' &nbsp;<span class="muted">· hid '+(s.inactive||0)+' inactive'+since+(parts.length?' ('+parts.join(', ')+')':'')+'</span>' : '';
  var merged = s.crossSourceMerged ? ' &nbsp;<span class="muted">· merged '+s.crossSourceMerged+' cross-source duplicate'+(s.crossSourceMerged===1?'':'s')+'</span>' : '';
  st(msg+' &nbsp;<span class="muted">('+prospects.length+' shown)</span>'+hid+merged);
  document.getElementById('results').innerHTML='<h3 style="margin:6px 0 12px">Qualified prospects <span class="muted" style="font-weight:400;font-size:13px">— no website</span></h3>'+prospects.map(card).join('');
}
function stat(n,l,cls){return '<div class="stat '+(cls||'')+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
function card(p){
  const email=p.email?'<span class="email">✉️ '+p.email+'</span>':'<span class="noemail">no email found</span>';
  const src=p.source==='facebook'?'Facebook':p.source==='instagram'?'Instagram':'Google';
  const saveBtn=p.saved
    ? '<button class="save saved-on" id="s-'+p.id+'" disabled>✅ Saved to CRM</button>'
    : '<button class="save" onclick="saveLead('+p.id+')" id="s-'+p.id+'">💾 Save</button>';
  // Freshness badge: green when we have a dated signal, amber when we don't — shows the
  // user WHY a lead qualified (e.g. "🟢 Active · Mar 2025 · FB post").
  const fresh = p.lastActive
    ? '<div><span class="fresh-badge fresh-active">🟢 Active · '+esc(p.lastActive)+(p.activeSignal?' · '+esc(p.activeSignal):'')+'</span></div>'
    : '<div><span class="fresh-badge fresh-unknown">🟡 no dated activity</span></div>';
  // License/registration signal (best-effort, from the business's own profile text) + a
  // one-click link to verify it on an official search. Never hides a lead — just informs.
  var lic=p.license||{};
  var licBadge = lic.status==='mentioned'
    ? '<span class="lic-badge lic-yes" title="What the business advertises — confirm with Verify">🪪 '+esc(lic.evidence||'licensed/registered')+'</span>'
    : '<span class="lic-badge lic-no" title="Nothing found in their profile text — check the official search">🪪 no license info</span>';
  var lic_line = '<div style="margin-top:6px">'+licBadge+(p.licenseUrl?' <a class="lic-verify" href="'+p.licenseUrl+'" target="_blank" rel="noopener">verify ↗</a>':'')+'</div>';
  return '<div class="lead" id="lead-'+p.id+'">'+
    '<div><h3>'+esc(p.name)+'<span class="badge">no website</span></h3>'+
    '<div class="meta">'+esc(p.category||'')+' · '+esc(p.city||'')+', '+esc(p.state||'')+' · '+esc(p.phone||'no phone')+'</div>'+
    '<div class="meta"><span class="src">'+src+'</span> &nbsp; '+email+'</div>'+fresh+lic_line+'</div>'+
    '<div style="display:flex;gap:8px;align-items:center">'+
      saveBtn+
      '<button class="hide" onclick="hideLead('+p.id+')" title="Mark off — won&#39;t show in future searches">✕</button>'+
    '</div>'+
    '</div>';
}
// On load, bring back the last search (no re-scraping) so navigating away keeps results.
async function restoreLast(){
  const r=await (await fetch('/api/last-search')).json();
  if(!r.ok||r.empty||!r.prospects||!r.prospects.length)return;
  const q=r.query||{};
  if(q.city)document.getElementById('city').value=q.city;
  if(q.state)document.getElementById('state').value=q.state;
  if(q.niche)document.getElementById('niche').value=q.niche;
  if(q.sources){const v=q.sources.length>1?'all':q.sources[0];document.getElementById('source').value=v;}
  if(q.limit)document.getElementById('limit').value=String(q.limit);
  render(r.stats,r.prospects,'restored');
}
restoreLast();
// Keep the cost estimate live as the user changes city/niche/source/depth.
['city','niche','source'].forEach(function(id){var el=document.getElementById(id);if(el){el.addEventListener('input',updateEstimate);el.addEventListener('change',updateEstimate);}});
updateEstimate();
async function saveLead(id){
  const b=document.getElementById('s-'+id);b.disabled=true;
  const r=await post('/api/crm/save/'+id,{});
  if(r.ok){b.textContent='✅ Saved to CRM';b.classList.add('saved-on')}else{b.disabled=false;b.textContent='⚠️ retry'}
}
async function hideLead(id){
  await post('/api/dismiss/'+id,{});
  const el=document.getElementById('lead-'+id);
  if(el){el.style.transition='opacity .3s';el.style.opacity='0';setTimeout(()=>el.remove(),300)}
}
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

// ── CRM ROWS (the tracked + follow-up tabs of /leads) ──
const CRM_STAGES = ["New", "Contacted", "Interested", "Won", "Lost"];

// Human "how long ago" from either a SQLite UTC datetime ("2026-06-09 14:03:00") or a
// Postgres timestamptz ("2026-06-09T14:03:00+00:00") — the two providers differ.
function daysAgo(dt) {
  if (!dt) return "";
  const s = String(dt);
  const iso = /[TZ+]|\d{2}:\d{2}:\d{2}\.\d+/.test(s.slice(10)) ? s.replace(" ", "T") : s.replace(" ", "T") + "Z";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function renderCrmRow(l, followup = false) {
  const opts = CRM_STAGES.map(
    (s) => `<option value="${s}"${l.crm_stage === s ? " selected" : ""}>${s}</option>`
  ).join("");
  const src = l.source === "facebook" ? "Facebook" : l.source === "instagram" ? "Instagram" : "Google";
  // In the follow-up tab, show how long since they were contacted (older = nudge to chase).
  const when = daysAgo(l.contacted_on);
  const aged = when && when !== "today" && when !== "yesterday";
  const followCell = followup
    ? `<td><span class="ago ${aged ? "stale" : ""}">⏰ ${esc(when || "—")}</span></td>`
    : "";
  return `<tr id="crm-${l.id}">
    <td><b>${esc(l.name)}</b><div class="sub">${esc(l.category || "")} · ${esc(l.city || "")}, ${esc(l.state || "")}</div><div class="sub" style="margin-top:5px">${licenseBadgeHtml(l)}</div></td>
    <td>${esc(l.phone || "—")}<div class="sub">${l.email ? esc(l.email) : '<span class="warn">no email</span>'}</div></td>
    <td><span class="src">${src}</span></td>
    ${followCell}
    <td><select class="stage" onchange="setStage(${l.id},this.value)">${opts}</select></td>
    <td><input class="notes" value="${esc(l.notes || "")}" placeholder="notes…" onchange="setNotes(${l.id},this.value)"></td>
    <td class="actions">
      <button class="rm" onclick="removeCrm(${l.id})">Remove</button>
    </td>
  </tr>`;
}

// Friendly "due in 3d / overdue 2d / due today" from a YYYY-MM-DD string.
function dueInfo(due) {
  if (!due) return { text: "no date", cls: "" };
  const d = new Date(due + "T00:00:00").getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today.getTime()) / 86400000);
  if (days < 0) return { text: `overdue ${-days}d`, cls: "od" };
  if (days === 0) return { text: "due today", cls: "soon" };
  if (days === 1) return { text: "due tomorrow", cls: "soon" };
  return { text: `due in ${days}d`, cls: "" };
}

function renderFollowupItem(f) {
  const di = dueInfo(f.due);
  const done = !!f.done;
  return `<div class="fu-item${done ? " fu-done" : ""}" id="fu-${f.id}">
    <div class="fu-main">
      <div class="fu-title">${esc(f.title)} ${f.due ? `<span class="fu-due ${di.cls}">📅 ${di.text}</span>` : ""}</div>
      ${f.note ? `<div class="fu-note">${esc(f.note)}</div>` : ""}
    </div>
    <div class="fu-actions">
      <button class="fu-btn" onclick="fuDone(${f.id},${done ? 0 : 1})">${done ? "↩︎ Undo" : "✓ Done"}</button>
      <button class="fu-btn fu-del" onclick="fuDel(${f.id})">Remove</button>
    </div>
  </div>`;
}

// ── LEADS PAGE (tracked · found · follow-up) ──
// One page for the whole lead lifecycle. `tracked` and `followup` are the old CRM
// tabs; `found` is every lead the machine has ever surfaced (the old Brain "Your
// leads" tab) — now actionable, with Save and dismiss on each row.

// Scrapers write a few variants ("google", "google_maps"), so match on the prefix —
// this is the same label the tracked tab shows for the same lead.
function srcLabel(s) {
  const v = String(s || "");
  if (v.startsWith("facebook")) return "Facebook";
  if (v.startsWith("instagram")) return "Instagram";
  if (v.startsWith("google")) return "Google";
  return v || "—";
}

// The found tab renders at most this many rows (newest first); the filter box
// searches what's rendered, so the note tells the user when there's more behind it.
const FOUND_LIMIT = 500;

// A row on the `found` tab. Deliberately light: no lead_json, so no license badge —
// that detail lives on the tracked tab, where the CRM query still loads it.
function renderFoundRow(l) {
  const saved = !!l.saved;
  const stage = esc(l.crm_stage || "New");
  const stageCell = saved ? `<span class="tag site">${stage}</span>` : `<span class="tag">not saved</span>`;
  const saveBtn = saved
    ? `<button class="save saved-on" id="fs-${l.id}" disabled>✅ Saved</button>`
    : `<button class="save" id="fs-${l.id}" onclick="saveFound(${l.id})">💾 Save</button>`;
  return `<tr id="found-${l.id}" data-stage="${stage}">
    <td><b>${esc(l.name || "—")}</b><div class="sub">${esc(l.category || "")}</div></td>
    <td>${esc([l.city, l.state].filter(Boolean).join(", ") || "—")}</td>
    <td>${esc(l.phone || "—")}<div class="sub">${l.email ? esc(l.email) : '<span class="warn">no email</span>'}</div></td>
    <td><span class="src">${esc(srcLabel(l.source))}</span></td>
    <td class="stagecell">${stageCell}</td>
    <td class="actions">
      ${saveBtn}
      <button class="hide" onclick="dismissFound(${l.id})" title="Mark off — won&#39;t show in future searches">✕</button>
    </td>
  </tr>`;
}

async function renderLeadsPage(req, view = "tracked") {
  const tab = view === "found" ? "found" : view === "followup" ? "followup" : "tracked";
  const wantCrm = tab !== "found";
  // Everything the page needs, in parallel. listAllLeads is the slim query (no
  // lead_json/site_data), so fetching it for the tab count is cheap; the fat
  // listCrm query is skipped entirely on the found tab.
  const [crmLeads, counts, found, followups] = await Promise.all([
    wantCrm ? store.listCrm(req.userId) : null,
    store.crmCounts(req.userId),
    store.listAllLeads(req.userId),
    tab === "followup" ? store.listFollowups(req.userId) : [],
  ]);

  const stageCount = (s) => counts.find((c) => c.crm_stage === s)?.n || 0;
  const contactedCount = stageCount("Contacted");
  const trackedCount = crmLeads ? crmLeads.length : counts.reduce((a, c) => a + (Number(c.n) || 0), 0);
  const foundCount = found.length;
  const byStage = CRM_STAGES.map((s) => `${s}: ${stageCount(s)}`).join(" · ");
  const openFollowups = followups.filter((f) => !f.done).length;

  const followup = tab === "followup";
  const crmRows = wantCrm ? (followup ? crmLeads.filter((l) => l.crm_stage === "Contacted") : crmLeads) : [];
  const foundRows = tab === "found" ? found.slice(0, FOUND_LIMIT) : [];
  const capped = foundCount > FOUND_LIMIT;

  const stats =
    tab === "found"
      ? `Every business the machine has surfaced for you. <b>Save</b> the ones worth chasing — they move to <b>Tracked</b>. &nbsp;·&nbsp; ${
          capped
            ? `<b>showing newest ${FOUND_LIMIT}</b> of ${foundCount} — use the filter to reach the rest`
            : `<b>${foundRows.length}</b> shown`
        }`
      : followup
      ? `<b>${openFollowups}</b> personal follow-up${openFollowups === 1 ? "" : "s"} &nbsp;·&nbsp; <b>${contactedCount}</b> contacted lead${contactedCount === 1 ? "" : "s"}`
      : `<b>${trackedCount}</b> saved leads &nbsp;·&nbsp; ${esc(byStage)}`;

  const foundBody = foundRows.length
    ? `<input class="search" id="q" placeholder="🔍 Filter by name, category, city, phone…" oninput="filterRows()" autofocus>
<table id="tbl"><thead><tr><th>Business</th><th>Location</th><th>Contact</th><th>Source</th><th>Stage</th><th>Actions</th></tr></thead><tbody id="tb">${foundRows
        .map(renderFoundRow)
        .join("")}</tbody></table><div id="noMatch">No businesses match your filter.</div>`
    : '<div class="empty">Nothing found yet.<br>Go to <a href="/">Search</a> and run a scan — everything it surfaces lands here.</div>';

  const crmBody = crmRows.length
    ? `<table><thead><tr><th>Business</th><th>Contact</th><th>Source</th>${
        followup ? "<th>Contacted</th>" : ""
      }<th>Stage</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${crmRows
        .map((l) => renderCrmRow(l, followup))
        .join("")}</tbody></table>`
    : followup
    ? '<div class="empty" style="margin-top:20px">No contacted leads yet.<br>Set a lead\'s stage to <b>Contacted</b> in <b>Tracked</b> and it\'ll show here.</div>'
    : '<div class="empty">No saved leads yet.<br>Open the <a href="/leads?view=found">Found</a> tab and click <b>💾 Save</b> on the ones you want to track.</div>';

  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector — Leads</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1200px;margin:auto}
  header{display:flex;align-items:center;gap:16px;margin-bottom:8px}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .nav{margin-left:auto;display:flex;gap:16px;align-items:center;flex-wrap:wrap;row-gap:10px}.nav a{color:var(--gold);text-decoration:none;font-weight:600;font-size:14px}
  .stats{color:var(--muted);font-size:13px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:12px 14px;border-bottom:1px solid var(--border)}
  td{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .sub{color:var(--muted);font-size:12px;margin-top:3px}.warn{color:#e0a93b}
  .src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  select.stage,input.notes{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:7px 9px;color:var(--text);font-size:13px}
  input.notes{width:100%;min-width:160px}
  .actions{display:flex;gap:8px;align-items:center;white-space:nowrap}
  .actions a{color:var(--gold);text-decoration:none;font-size:13px}
  .rm{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
  .rm:hover{color:#e05b5b;border-color:#e05b5b}
  .save{border-radius:7px;padding:6px 11px;font-weight:600;cursor:pointer;font-size:12px;white-space:nowrap;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:var(--text)}
  .save:disabled{cursor:default}
  .hide{border-radius:7px;padding:6px 10px;cursor:pointer;font-size:12px;background:transparent;border:1px solid rgba(255,255,255,.14);color:var(--muted)}
  .hide:hover{color:#e05b5b;border-color:#e05b5b}
  .search{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 14px;color:var(--text);font-size:15px;margin-bottom:14px}
  .search::placeholder{color:var(--muted)}
  .tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(255,255,255,.06);color:var(--muted)}
  .tag.site{background:rgba(20,255,185,.16);color:var(--gold)}
  #noMatch{display:none;color:var(--muted);text-align:center;margin-top:30px;font-size:14px}
  .empty{color:var(--muted);text-align:center;margin-top:50px;font-size:15px}
  .tabs{display:flex;gap:8px;margin:6px 0 16px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14px;color:var(--muted);background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:9px 16px}
  .tab:hover{color:var(--text)}
  .tab.active{color:#000;background:var(--gold);border-color:var(--gold)}
  .tab .pill{background:rgba(0,0,0,.18);border-radius:20px;padding:1px 8px;font-size:12px}
  .tab:not(.active) .pill{background:rgba(20,255,185,.16);color:var(--gold)}
  .ago{font-size:13px;color:var(--muted);white-space:nowrap}
  .ago.stale{color:#e0a93b;font-weight:700}
  .fubox{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
  .fubox h3{font-size:15px;margin-bottom:10px}
  .fu-add{display:grid;grid-template-columns:1.4fr 1.6fr auto auto;gap:10px}
  .fu-add input{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px}
  .fu-add button{background:var(--gold);color:#000;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer;white-space:nowrap}
  .fu-list{display:flex;flex-direction:column;gap:8px;margin-bottom:22px}
  .fu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .fu-item.fu-done{opacity:.5}.fu-item.fu-done .fu-title{text-decoration:line-through}
  .fu-title{font-weight:700;font-size:14px}
  .fu-note{color:var(--muted);font-size:13px;margin-top:3px}
  .fu-due{font-size:12px;font-weight:700;color:var(--muted);margin-left:6px}
  .fu-due.soon{color:#e0a93b}.fu-due.od{color:#e05b5b}
  .fu-actions{display:flex;gap:8px;white-space:nowrap}
  .fu-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:var(--text);border-radius:7px;padding:7px 12px;cursor:pointer;font-size:13px;font-weight:600}
  .fu-del{color:var(--muted)}.fu-del:hover{color:#e05b5b;border-color:#e05b5b}
  .sechead{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:8px 0 10px;font-weight:700}
${SHARED_CSS}</style></head><body>
${sidebar("leads", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Leads</h1><div class="pagesub">Everything the machine found — and the ones you're working</div></div><div class="spacer"></div></div>
<div class="tabs">
  <a class="tab ${tab === "tracked" ? "active" : ""}" href="/leads">Tracked <span class="pill">${trackedCount}</span></a>
  <a class="tab ${tab === "found" ? "active" : ""}" href="/leads?view=found">Found <span class="pill">${foundCount}</span></a>
  <a class="tab ${followup ? "active" : ""}" href="/leads?view=followup">⏰ Follow-up <span class="pill">${contactedCount}</span></a>
</div>
<div class="stats">${stats}</div>
${
  followup
    ? `<div class="fubox">
        <h3>➕ Add your own follow-up</h3>
        <div class="fu-add">
          <input id="fuTitle" placeholder="Who / business (e.g. Joe's Roofing)">
          <input id="fuNote" placeholder="Note (optional) — e.g. called, wants a quote">
          <input id="fuDue" type="date" title="Follow up on">
          <button onclick="addFu()">Add</button>
        </div>
      </div>
      <div class="sechead">Your follow-ups${openFollowups ? ` — ${openFollowups} open` : ""}</div>
      <div class="fu-list" id="fuList">${
        followups.length
          ? followups.map(renderFollowupItem).join("")
          : '<div class="empty" style="margin:6px 0;text-align:left">No personal follow-ups yet — add one above.</div>'
      }</div>
      <div class="sechead">Contacted leads${contactedCount ? ` — ${contactedCount}` : ""}</div>`
    : ""
}
${tab === "found" ? foundBody : crmBody}
<script>
const FOLLOWUP=${followup};
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function dropRow(id){const r=document.getElementById('crm-'+id);if(r){r.style.transition='opacity .3s';r.style.opacity='0';setTimeout(()=>r.remove(),300)}}
async function setStage(id,stage){await post('/api/crm/update/'+id,{stage});if(FOLLOWUP&&stage!=='Contacted')dropRow(id)}
async function setNotes(id,notes){await post('/api/crm/update/'+id,{notes})}
async function removeCrm(id){await post('/api/crm/remove/'+id,{});const r=document.getElementById('crm-'+id);if(r)r.remove()}
async function addFu(){
  const t=document.getElementById('fuTitle'),n=document.getElementById('fuNote'),d=document.getElementById('fuDue');
  if(!t.value.trim()){t.focus();return}
  const r=await post('/api/followup/add',{title:t.value,note:n.value,due:d.value});
  if(r.ok)location.reload();
}
async function fuDone(id,done){await post('/api/followup/update/'+id,{done:!!done});location.reload()}
async function fuDel(id){await post('/api/followup/remove/'+id,{});const r=document.getElementById('fu-'+id);if(r)r.remove()}
// ── found tab ──
async function saveFound(id){
  var b=document.getElementById('fs-'+id);if(b)b.disabled=true;
  var r=await post('/api/crm/save/'+id,{});
  if(!r.ok){if(b){b.disabled=false;b.textContent='⚠️ retry'}return}
  if(b){b.textContent='✅ Saved';b.classList.add('saved-on');b.onclick=null}
  var row=document.getElementById('found-'+id);
  if(row){var c=row.querySelector('.stagecell');if(c)c.innerHTML='<span class="tag site">'+(row.getAttribute('data-stage')||'New')+'</span>'}
}
async function dismissFound(id){
  await post('/api/dismiss/'+id,{});
  var r=document.getElementById('found-'+id);
  if(r){r.style.transition='opacity .3s';r.style.opacity='0';setTimeout(function(){r.remove()},300)}
}
function filterRows(){
  var box=document.getElementById('q');if(!box)return;
  var q=box.value.toLowerCase().trim(),shown=0;
  document.querySelectorAll('#tb tr').forEach(function(r){
    var hit=!q||r.textContent.toLowerCase().indexOf(q)>-1;
    r.style.display=hit?'':'none';if(hit)shown++;
  });
  var nm=document.getElementById('noMatch');if(nm)nm.style.display=shown?'none':'block';
}
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}
