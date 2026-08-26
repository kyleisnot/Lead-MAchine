// server.js — the Prospector dashboard: find local businesses with no website (Search)
// and work them on one Leads page (three buckets, each with a working + follow-up list).
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
import { isRealWebsiteUrl } from "../scrapers/filter.js";
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

// ── Inline icons ──
// Same drawing style as shell.js's sidebar icons (lucide-like, 24x24, currentColor) but
// defined here so this file stays self-contained. Used server-side in templates and
// handed to the page scripts as ICONS (see iconScript below).
function icon(key, size = 15) {
  const s = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" aria-hidden="true">`;
  const paths = {
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5V12l3 1.8"></path>',
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    x: '<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>',
    warn: '<path d="M10.3 3.9 1.9 18.3A2 2 0 0 0 3.6 21h16.8a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4.5"></path><path d="M12 17.5h.01"></path>',
    // The leads/CRM table motif, reused from the sidebar so "move to leads" reads as one idea.
    crm: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18M9 4v16"></path>',
    search: '<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.2-4.2"></path>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3.5 6.5 8.5 6 8.5-6"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    undo: '<path d="M3 10h11a5 5 0 0 1 0 10h-4"></path><polyline points="7 6 3 10 7 14"></polyline>',
    dot: '<circle cx="12" cy="12" r="5"></circle>',
    badge: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><circle cx="8.5" cy="12" r="2.5"></circle><path d="M14 10.5h4M14 14h4"></path>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"></path><polyline points="21 3 21 9 15 9"></polyline>',
  };
  return s + (paths[key] || "") + "</svg>";
}
// The same icons, as a JS object the page scripts can splice into strings.
function iconScript(keys, size = 15) {
  const map = {};
  for (const k of keys) map[k] = icon(k, size);
  return `var ICONS=${JSON.stringify(map)};`;
}

// ── Buckets ──
// Every CRM lead lives in exactly one of these, set when it is moved over from a search.
// The list itself is the store's (../data/store.js owns what a valid bucket is); the
// copy below is this file's.
const CRM_BUCKETS = store.CRM_BUCKETS;
const BUCKET_META = {
  qualified: {
    title: "No-website leads",
    sub: "no website and still active, the ones worth calling first",
  },
  inactive: {
    title: "Not active",
    sub: "no website, but nothing posted lately, backups to work later",
  },
  has_website: {
    title: "Has a website",
    sub: "already online, worth a rebuild pitch when you have room",
  },
};
const isBucket = (b) => CRM_BUCKETS.includes(String(b || ""));

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
  const raw = Number.parseInt(profile?.monthly_token_allotment, 10);
  const allotment = Number.isFinite(raw) && raw > 0 ? raw : 0;
  // 0 = account not yet given a plan. (New convention: 0 no longer means "unlimited".)
  if (allotment === 0) {
    res.status(402).json({
      ok: false,
      error: "Your account isn't active yet. Reach out to have your monthly tokens set up.",
    });
    return true;
  }
  const used = await monthTokensUsed(req.userId);
  if (used >= allotment) {
    res.status(429).json({
      ok: false,
      error: `You've used all ${allotment.toLocaleString()} tokens in your plan this month. ` +
             `They refill on ${planResetLabel()}, or ask for a top-up to keep searching now.`,
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

// Note: the global business directory (every business any scan touches, with and without
// a website) is fed from inside discover() in ../lib/pipeline.js, which is the only place
// that sees the FULL scanned set. discover() hands this handler the qualifying prospects
// only, so recording it here would miss most of what we scanned.

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
    const { prospects, stats, cached, cachedAt, alsoSeen } = await discover({
      userId: req.userId,
      niche,
      city,
      state,
      sources: resolvedSources,
      limit: limit || 30,
      forceRefresh: !!forceRefresh,
    });
    // The qualifying leads plus the in-niche businesses the scan saw but skipped (the ones
    // that already have a website). They arrive pre-slimmed and carry hasWebsite, so the
    // page's own grouping drops each into the right section.
    res.json({
      ok: true,
      stats,
      cached: !!cached,
      cachedAt: cachedAt || null,
      prospects: prospects.map(slimProspect).concat(alsoSeen || []),
    });
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
    const { prospects, stats, alsoSeen } = await discoverMany({
      userId: req.userId,
      niches: nicheList,
      cities: cityList,
      state,
      sources: sources?.length ? sources : ["google", "facebook"],
      limit: limit || 30,
      forceRefresh: !!forceRefresh,
    });
    res.json({ ok: true, stats, prospects: prospects.map(slimProspect).concat(alsoSeen || []) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CRM API ──
// Move search results into the CRM under one bucket. Takes the whole prospect objects the
// search page is already holding, so a group can be moved in one request.
app.post("/api/crm/move", route(async (req, res) => {
  const { prospects, bucket } = req.body || {};
  if (!isBucket(bucket)) {
    return res.status(400).json({ ok: false, error: "Pick one of: qualified, inactive, has_website." });
  }
  const list = (Array.isArray(prospects) ? prospects : []).filter((p) => p && typeof p === "object");
  if (!list.length) return res.status(400).json({ ok: false, error: "Nothing to move." });
  const { added = 0, skipped = 0 } = (await store.moveToCrm(req.userId, list, bucket)) || {};
  res.json({ ok: true, added, skipped });
}));

// Follow-up shorthands the UI sends. "1 month" is a real calendar month, not 30 days.
const FOLLOWUP_SHORTHAND = {
  "3d": (d) => d.setDate(d.getDate() + 3),
  "1w": (d) => d.setDate(d.getDate() + 7),
  "2w": (d) => d.setDate(d.getDate() + 14),
  "1m": (d) => d.setMonth(d.getMonth() + 1),
};
// "3d" | "1w" | "2w" | "1m" | an ISO date → an ISO timestamp. "" / null → null (clear it).
// Returns undefined for anything we can't read, so the caller can answer 400.
function followUpIso(when) {
  if (when === null || when === undefined) return null;
  const raw = String(when).trim();
  if (!raw) return null;
  const shift = FOLLOWUP_SHORTHAND[raw.toLowerCase()];
  if (shift) {
    const d = new Date();
    shift(d);
    return d.toISOString();
  }
  // A bare date from the picker is anchored at midday UTC, so it reads as the same
  // calendar day whether it's rendered on a UTC server or in the user's own timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00.000Z`;
  const t = Date.parse(raw);
  return isNaN(t) ? undefined : new Date(t).toISOString();
}

// Set (or clear) a lead's follow-up date. Setting one is the "I did something here, come
// back to me later" gesture: the lead leaves the working list until that date.
app.post("/api/leads/:id/followup", route(async (req, res) => {
  const followUpAt = followUpIso(req.body?.when);
  if (followUpAt === undefined) {
    return res.status(400).json({ ok: false, error: "Use 3d, 1w, 2w, 1m, or a date." });
  }
  await store.setFollowUp(req.userId, req.params.id, followUpAt);
  res.json({ ok: true, followUpAt });
}));

// Move a lead to a different bucket (e.g. a "not active" one turned out to be alive).
app.post("/api/leads/:id/bucket", route(async (req, res) => {
  const { bucket } = req.body || {};
  if (!isBucket(bucket)) {
    return res.status(400).json({ ok: false, error: "Pick one of: qualified, inactive, has_website." });
  }
  await store.setLeadBucket(req.userId, req.params.id, bucket);
  res.json({ ok: true, bucket });
}));

// Save one already-stored lead. Superseded in the UI by /api/crm/move (which also sets the
// bucket); kept so any older caller still works. A lead saved this way takes the default
// bucket and lands in the no-website working list.
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

// Your yes/no on whether our "last active" tag was right (trains/validates the dating).
app.post("/api/activity-feedback/:id", route(async (req, res) => {
  const { verdict, seen } = req.body || {};
  await store.setActivityFeedback(req.userId, req.params.id, verdict, seen || "");
  res.json({ ok: true, counts: await store.activityFeedbackCounts(req.userId) });
}));
app.post("/api/crm/update/:id", route(async (req, res) => {
  await store.updateCrm(req.userId, req.params.id, { stage: req.body.stage, notes: req.body.notes });
  res.json({ ok: true });
}));

// ── LEADS: one page, three bucket sections, each with a working + follow-up list ──
// The old tabs (?view=tracked / found / followup) are gone; the whole lifecycle is on the
// one page now. Those links still land somewhere sensible instead of rendering an empty tab.
app.get("/leads", route(async (req, res) => {
  if (req.query.view) {
    return res.redirect(302, req.query.view === "followup" ? "/leads#followups" : "/leads");
  }
  res.send(await renderLeadsPage(req));
}));

// Old URLs keep working: /crm and /brain both landed on the leads page.
app.get("/crm", (req, res) => res.redirect(302, req.query.view === "followup" ? "/leads#followups" : "/leads"));
app.get("/brain", (req, res) => res.redirect(302, "/leads"));

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
  const raw = Number.parseInt(profile?.monthly_token_allotment, 10);
  const allotment = Number.isFinite(raw) && raw > 0 ? raw : 0; // 0 = no plan yet (blocked)
  const tokens = usdToTokens(u.aiUsd || 0);
  res.json({
    ok: true,
    tokens,
    allotment,
    planRemaining: Math.max(0, allotment - tokens),
    unassigned: allotment === 0,
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
    external_id: l.external_id || "", // travels with the prospect so /api/crm/move can dedup on it
    name: l.name,
    category: l.category,
    city: l.city,
    state: l.state,
    phone: l.phone,
    email: l.email || "",
    source: l.source,
    website: l.website || "",
    // Same rule the search filter uses: a Facebook/Yelp/free-builder page is NOT a website.
    hasWebsite: isRealWebsiteUrl(l.website || ""),
    reviews: l.reviews ?? null,
    rating: l.rating ?? null,
    lastActive: lastActiveLabel(lj), // "Mar 2025" or "" when unknown
    activeStatus: activityStatus(lj), // "active" | "stale" | "unknown"
    activeSignal: activitySignal(lj), // "FB post" | "IG post" | "Google review"
    verdict: l.activity_verdict || "", // your yes/no on the activity tag, if given
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
  // Also-seen businesses have no lead rows to reload from, so they were stored with the
  // search itself. A search remembered before they existed just has none.
  const alsoSeen = Array.isArray(ls.alsoSeen) ? ls.alsoSeen : [];
  res.json({
    ok: true,
    query: { niche: ls.niche, city: ls.city, state: ls.state, sources: ls.sources, limit: ls.limit },
    stats: ls.stats,
    prospects: rows.map(slimProspect).concat(alsoSeen),
  });
}));

// ── WINS: the user's closed-deal trophy case ──
// One page: a headline stat, a "log a win" form, and the list of wins. The API is
// user-scoped through ../data/store.js exactly like every other data call here.
app.get("/wins", route(async (req, res) => res.send(await renderWinsPage(req))));

app.post("/api/wins", route(async (req, res) => {
  const { clientName, amount, note } = req.body || {};
  if (!clientName || !String(clientName).trim()) {
    return res.status(400).json({ ok: false, error: "Add a client name." });
  }
  // amount is optional: an empty/blank field is a win with no dollar figure (null),
  // anything else is parsed to a number (a non-numeric value falls back to null).
  const raw = amount === "" || amount === null || amount === undefined ? null : Number(amount);
  const cleanAmount = Number.isFinite(raw) ? raw : null;
  const id = await store.addWin(req.userId, { clientName, amount: cleanAmount, note });
  res.json({ ok: true, id });
}));

app.post("/api/wins/remove/:id", route(async (req, res) => {
  await store.removeWin(req.userId, req.params.id);
  res.json({ ok: true });
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
    console.log(`\nProspector ready at http://localhost:${PORT}\n`);
  });
}

// Default export so a serverless host (api/index.js) can use the app as its handler.
export default app;

// ── HTML rendering (kept simple: server-rendered + a little fetch JS) ──
function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// License/registration badge (server-rendered) for the CRM table. Best-effort signal
// from the lead's own profile text + a one-click official-verify link. Styled with the
// shared .lic-* classes (colours live in SHARED_CSS, layout in each page's own <style>).
function licenseBadgeHtml(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  const sig = detectLicenseSignal(lj);
  const url = licenseSearchUrl(lj);
  const on = sig.status === "mentioned";
  const label = on ? esc(sig.evidence || "licensed/registered") : "no license info";
  const title = on
    ? "What the business advertises. Confirm it with Verify."
    : "Nothing found in their profile. Check the official search.";
  return `<span class="lic-badge ${on ? "lic-yes" : "lic-no"}" title="${title}">${icon("badge", 13)}${label}</span> <a class="lic-verify" href="${url}" target="_blank" rel="noopener">Verify</a>`;
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
    : `We look at each business's newest Facebook or Instagram post (or Google review). If the most recent one is older than <b>${esc(cutoffLabel())}</b>, we file them under <b>not active</b>: a business that's gone quiet probably isn't taking new customers.`;
  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector · Search</title>
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
  /* ── Result groups: qualified / not active / has a website ── */
  .scanline{font-size:14px;color:var(--muted);margin:2px 0 14px}
  .scanline b{color:var(--text)}
  .grp{background:var(--panel);border:1px solid var(--border);border-radius:12px;margin-bottom:14px;overflow:hidden}
  .grp>summary{list-style:none;cursor:pointer;padding:15px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .grp>summary::-webkit-details-marker{display:none}
  .grp>summary::after{content:"";flex:none;width:9px;height:9px;margin-left:6px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg) translateY(-2px);transition:transform .15s;order:1}
  .grp[open]>summary::after{transform:rotate(225deg) translateY(-2px)}
  .grp-ttl{font-weight:700;font-size:15px;color:var(--text)}
  .grp-n{font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;background:var(--surface2);color:var(--muted)}
  .grp-lead .grp-n{background:var(--accent-weak);color:var(--accent-ink)}
  .grp-sub{font-size:13px;color:var(--muted);flex:1 1 100%;margin:-4px 0 0;order:2}
  .grp-body{padding:0 14px 14px}
  .grp-act{margin-left:auto;display:flex;gap:8px;align-items:center}
  .moveall{display:inline-flex;align-items:center;gap:7px;font-family:inherit;background:var(--accent);color:var(--on-accent);border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap}
  .moveall:hover{filter:brightness(.96)}
  .moveall:disabled{opacity:.6;cursor:wait}
  .moveall.ghost{background:transparent;border:1px solid var(--border-strong);color:var(--text)}
  .moveall.ghost:hover{background:var(--surface2);filter:none}
  .grp-done{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:14px 18px;margin-bottom:14px;font-size:14px;color:var(--text)}
  .grp-done .ok{display:inline-flex;color:var(--accent)}
  .grp-done a{font-weight:700;margin-left:auto;text-decoration:none;white-space:nowrap}
  .statuserr{display:inline-flex;align-items:center;gap:7px;color:var(--danger)}
  .grp .lead{margin:10px 0 0}

  /* Collapsed search bar: once results are on screen the form folds into one line. */
  .srchbar{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:16px}
  .srchbar .sb-i{display:inline-flex;color:var(--muted);flex:none}
  .srchbar .sb-q{font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .srchbar .sb-q .muted{font-weight:500}
  .srchbar .sb-go{display:inline-flex;align-items:center;gap:7px;font-family:inherit;margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;flex:none}
  .srchbar .sb-go:hover{border-color:var(--accent);color:var(--accent)}

  /* Jump buttons: pick a list and the page glides to that column. */
  .colnav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
  .colnav .cn{display:inline-flex;align-items:center;gap:8px;font-family:inherit;background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:999px;padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer}
  .colnav .cn:hover:not(:disabled){border-color:var(--accent)}
  .colnav .cn.on{border-color:var(--accent);background:var(--accent-weak);color:var(--accent-ink)}
  .colnav .cn:disabled{opacity:.45;cursor:default}
  .colnav .cn-n{background:var(--bg);border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700}
  .colnav .cn.on .cn-n{background:var(--panel)}

  /* The three result columns. */
  .cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
  .col{background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;scroll-margin-top:16px;transition:border-color .25s}
  .col.flash{border-color:var(--accent)}
  .colhead{padding:14px 16px;border-bottom:1px solid var(--border)}
  .colhead .ch-top{display:flex;align-items:center;gap:10px}
  .colhead .col-ttl{font-size:14px;font-weight:700;color:var(--text)}
  .colhead .col-n{background:var(--surface);color:var(--muted);border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700}
  .col-lead .colhead .col-n{background:var(--accent-weak);color:var(--accent-ink)}
  .colhead .col-sub{margin:6px 0 11px;font-size:12px;color:var(--muted);line-height:1.45}
  .colhead .moveall{width:100%;justify-content:center}
  .col-body{padding:12px;display:flex;flex-direction:column;gap:10px;max-height:70vh;overflow-y:auto}
  .col-body .lead{margin:0;grid-template-columns:1fr;gap:10px}
  @media (max-width:1150px){.cols{grid-template-columns:1fr}.col-body{max-height:none}}
  .save{display:inline-flex;align-items:center;gap:6px}
  .fresh-badge svg,.lic-badge svg,.save svg,.hide svg{flex:none}
  .lic-badge{display:inline-flex;align-items:center;gap:5px}
  .fresh-badge{display:inline-flex;align-items:center;gap:5px}
  .fresh-stale{background:var(--surface2);color:var(--muted)}
${SHARED_CSS}</style></head><body>
${sidebar("search", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Search</h1><div class="pagesub">Find local businesses that don't have a website yet</div></div><div class="spacer"></div>
  <div class="statbox">
    <div class="cell"><span class="k"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:4px"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>Remembered</span><span class="v" id="sbMem">&hellip;</span><span class="s2" id="sbMemSub"></span></div>
    <div class="sep"></div>
    <div class="cell"><span class="k">Tokens used</span><span class="v" id="sbTok">&hellip;</span><span class="s2" id="sbSearches"></span><div class="tokbar" id="sbBarWrap"><div class="tokbar-fill" id="sbBar"></div></div></div>
  </div>
</div>

<!-- First-run welcome card. Rendered hidden; the page script fetches /api/usage and
     reveals the variant that matches this account (or keeps it hidden for a returning
     active user who already dismissed it). Human numbers (tokens/searches) are filled
     client-side from the fetch. -->
<div id="prWelcome" class="welcome" style="display:none" role="region" aria-label="Getting started">
  <div id="prWelcomePending" class="welcome-card welcome-pending" style="display:none">
    <div class="welcome-mark">${icon("clock", 17)}</div>
    <div class="welcome-body">
      <h2 class="welcome-h">You're all set up, activation pending</h2>
      <p>Your account is ready to go, but a plan hasn't been assigned yet, so searching is locked for now.</p>
      <p>You'll be able to run searches the moment your tokens are added. Reach out to your account contact to activate.</p>
    </div>
  </div>
  <div id="prWelcomeActive" class="welcome-card" style="display:none">
    <div class="welcome-mark">${icon("search", 17)}</div>
    <div class="welcome-body">
      <h2 class="welcome-h">Welcome to Prospector</h2>
      <ul class="welcome-points">
        <li><b>What it does.</b> Prospector finds local businesses that don't have a website yet, the ones you can offer to build one for.</li>
        <li><b>Your plan this month.</b> You have <span id="prAllot">&hellip;</span> tokens this month, about <span id="prSearches">&hellip;</span> searches.</li>
        <li><b>When you run low.</b> Your tokens refill on the 1st, or reach out for more.</li>
      </ul>
      <div class="welcome-foot">
        <button type="button" class="welcome-got" id="prWelcomeDismiss" onclick="prDismissWelcome()">Got it</button>
      </div>
    </div>
  </div>
</div>

<details class="explain">
  <summary><span class="ex-ttl">What counts as a lead?</span><span class="ex-sub">a business must pass all 3 checks to be a top prospect</span></summary>
  <div class="ex-body">
    <div class="ex-item"><span class="ex-num">1</span><div><b>It's one of your trades</b><p>${explainNiches}</p></div></div>
    <div class="ex-item"><span class="ex-num">2</span><div><b>It has no real website</b><p>A Facebook, Instagram, or Yelp page doesn't count. We're after businesses with no website of their own, so you can offer to build them one.</p></div></div>
    <div class="ex-item"><span class="ex-num">3</span><div><b>It's still active</b><p>${activeExplain}</p></div></div>
    <p class="ex-foot">Businesses that pass all three are your <b>qualified</b> results. The rest still show up, sorted into <b>not active</b> and <b>has a website</b>, so nothing we scanned goes to waste. Everything we've ever checked is <b>remembered</b>, so we never pay to re-check it.</p>
  </div>
</details>

<div class="srchbar" id="srchbar" hidden></div>
<div class="panel searchpanel" id="searchpanel">
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
  ${iconScript(["crm", "check", "x", "warn", "clock", "mail", "dot", "badge", "refresh", "undo", "search"], 14)}
  var BUCKETS = ${JSON.stringify(BUCKET_META)};
</script>

<div id="status"></div>
<div id="statsWrap"></div>
<div id="results"></div>

<script>
function setNiche(n){document.getElementById('niche').value=n;updateEstimate()}
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function st(html){document.getElementById('status').innerHTML=html}
function stErr(msg){st('<span class="statuserr">'+ICONS.warn+' '+esc(msg||'Something went wrong.')+'</span>')}
// Rough run-time model (measured: a 3-source Quick scan ~2.5 min). Per source there's
// a startup cost plus per-place work; the dating pass adds a flat ~35s.
function estSeconds(sources,depth){return Math.round(sources*(18+depth*1.1)+35);}
function fmtMin(sec){return Math.max(1,Math.round(sec/60))+' min';}
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
    st('<span class="spinner"></span> '+stage+' <span style="opacity:.7">('+mmss(el)+' elapsed, usually about '+fmtMin(expSec)+')</span>');
  }
  tick(); progTimer=setInterval(tick,1000);
}
function stopProgress(){clearInterval(progTimer);progTimer=null;}

// "Knoxville, Maryville" becomes ["Knoxville","Maryville"]
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
    el.innerHTML=(big?ICONS.warn+' ':'')+'Batch of <b>'+cells+'</b> searches · scans <b>~'+places.toLocaleString()+' businesses</b> · about <b>'+fmtMin(totalSec)+'</b> · ~<b>'+tokens.toLocaleString()+' tokens</b>'+(big?' <span style="opacity:.85">(may be too big to finish in one run)</span>':'');
    return;
  }
  el.innerHTML='Scans <b>~'+places.toLocaleString()+' businesses</b> · about <b>'+fmtMin(totalSec)+'</b> · ~<b>'+tokens.toLocaleString()+' tokens</b>, <span style="opacity:.65">more than you could check by hand</span>';
}

async function runSearch(force){
  const cities=parseCities();
  if(!cities.length){stErr('Enter at least one city.');return}
  const niches=chosenNiches();
  if(!niches.length){stErr('Enter a niche, or tick All trades.');return}
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
  if(!r.ok){stErr(r.error);return}
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

// ── First-run welcome card ──────────────────────────────────────────────────
// Pure state pick, kept as its own function so it can be unit-tested in isolation.
// Returns which variant (if any) to show, given the /api/usage payload and whether
// this browser has already dismissed the welcome:
//   'unassigned' = 0 tokens / no plan yet (can't search). Always shown, not dismissable.
//   'active'     = has a plan (allotment>0) and hasn't dismissed yet. The teaching card.
//   'hide'       = active user who already clicked "Got it" (or a bad/empty response).
function prPickWelcome(u,welcomed){
  if(!u||!u.ok) return 'hide';
  if(u.unassigned) return 'unassigned';
  if(Number(u.allotment)>0) return welcomed?'hide':'active';
  return 'hide';
}
function prDismissWelcome(){
  try{localStorage.setItem('pr-welcomed','1');}catch(e){}
  var w=document.getElementById('prWelcome');if(w)w.style.display='none';
}
(async function prWelcome(){
  var box=document.getElementById('prWelcome');if(!box)return;
  var welcomed=false;try{welcomed=localStorage.getItem('pr-welcomed')==='1';}catch(e){}
  var u=null;try{u=await (await fetch('/api/usage')).json();}catch(e){return;}
  var pick=prPickWelcome(u,welcomed);
  if(pick==='hide')return;
  if(pick==='unassigned'){
    var p=document.getElementById('prWelcomePending');if(p)p.style.display='flex';
  }else{
    var a=document.getElementById('prWelcomeActive');if(a)a.style.display='flex';
    var allot=Number(u.allotment)||0, n=Math.round(allot/25); // ~25 tokens per typical search
    var ta=document.getElementById('prAllot');if(ta)ta.textContent=allot.toLocaleString();
    var ns=document.getElementById('prSearches');if(ns)ns.textContent=n.toLocaleString();
  }
  box.style.display='block';
})();

// ── Result grouping ────────────────────────────────────────────────────────
// Every result lands in exactly one of three groups, in the order you work them:
//   qualified    no website, still active      call these today
//   inactive     no website, but gone quiet    backups for later
//   has_website  already online                grab-later rebuild pitches
// GROUPS is kept around after render so "Move all to CRM" can post the whole group.
var GROUP_KEYS=['qualified','inactive','has_website'];
var GROUPS={qualified:[],inactive:[],has_website:[]};
function bucketOf(p){
  if(p.hasWebsite)return 'has_website';
  return p.activeStatus==='active'?'qualified':'inactive';
}
function groupProspects(list){
  var g={qualified:[],inactive:[],has_website:[]};
  (list||[]).forEach(function(p){g[bucketOf(p)].push(p)});
  return g;
}
function srcName(s){
  s=String(s||'');
  if(s.indexOf('facebook')===0)return 'Facebook';
  if(s.indexOf('instagram')===0)return 'Instagram';
  if(s.indexOf('google')===0)return 'Google';
  return s||'source';
}
// ── The collapsed search bar ──
// Once results are on screen the form has done its job, so it folds into a one-line
// summary and hands the whole viewport to the three columns.
function searchSummary(){
  var cities=parseCities().join(', ')||'anywhere';
  var stv=(document.getElementById('state').value||'').trim();
  var all=document.getElementById('allNiches').checked;
  var trade=all?'All trades':((document.getElementById('niche').value||'').trim()||'any trade');
  var dsel=document.getElementById('limit');
  var depth=dsel?dsel.options[dsel.selectedIndex].text:'';
  var src=document.getElementById('source');
  var srcTxt=src&&src.value!=='all'?srcName(src.value):'all sources';
  return esc(trade)+' in '+esc(cities)+(stv?', '+esc(stv):'')+
    ' <span class="muted">'+esc(depth)+', '+esc(srcTxt)+'</span>';
}
function collapseSearch(){
  var p=document.getElementById('searchpanel'),b=document.getElementById('srchbar');
  if(!p||!b)return;
  b.innerHTML='<span class="sb-i">'+ICONS.search+'</span><span class="sb-q">'+searchSummary()+
    '</span><button class="sb-go" onclick="openSearch()">'+ICONS.refresh+' New search</button>';
  p.hidden=true;b.hidden=false;
}
function openSearch(){
  var p=document.getElementById('searchpanel'),b=document.getElementById('srchbar');
  if(!p||!b)return;
  p.hidden=false;b.hidden=true;
  p.scrollIntoView({behavior:'smooth',block:'start'});
}

// ── The three columns ──
// One column per bucket, side by side, so the whole scan is visible at a glance
// instead of buried in stacked accordions.
function colNav(){
  var btns=GROUP_KEYS.map(function(k){
    var n=(GROUPS[k]||[]).length;
    var meta=BUCKETS[k]||{title:k};
    return '<button class="cn'+(k===firstFilled()?' on':'')+'" id="cn-'+k+'" '+
      (n?'onclick="jumpCol(\\''+k+'\\')"':'disabled')+'>'+
      esc(meta.title)+' <span class="cn-n">'+n+'</span></button>';
  });
  return '<div class="colnav">'+btns.join('')+'</div>';
}
function firstFilled(){
  for(var i=0;i<GROUP_KEYS.length;i++){var k=GROUP_KEYS[i];if((GROUPS[k]||[]).length)return k}
  return GROUP_KEYS[0];
}
function jumpCol(key){
  var el=document.getElementById('grp-'+key);
  if(!el)return;
  GROUP_KEYS.forEach(function(k){
    var b=document.getElementById('cn-'+k);
    if(b)b.classList.toggle('on',k===key);
  });
  el.scrollIntoView({behavior:'smooth',block:'start'});
  el.classList.add('flash');
  setTimeout(function(){el.classList.remove('flash')},900);
}
function colSection(key){
  var list=GROUPS[key]||[];
  if(!list.length)return '';
  var meta=BUCKETS[key]||{title:key,sub:''};
  var first=key==='qualified';
  return '<section class="col'+(first?' col-lead':'')+'" id="grp-'+key+'">'+
    '<header class="colhead">'+
      '<div class="ch-top"><span class="col-ttl">'+esc(meta.title)+'</span>'+
      '<span class="col-n">'+list.length+'</span></div>'+
      '<div class="col-sub">'+esc(meta.sub)+'</div>'+
      '<button class="moveall'+(first?'':' ghost')+'" id="mv-'+key+'" onclick="moveGroup(event,\\''+key+'\\')">'+
        ICONS.crm+' Move all to CRM</button>'+
    '</header>'+
    '<div class="col-body">'+list.map(function(p){return card(p,key)}).join('')+'</div>'+
  '</section>';
}
// Once a group has been moved, it shrinks to a single line so the eye moves on.
function collapseGroup(key,added,skipped){
  var el=document.getElementById('grp-'+key);
  if(!el)return;
  var meta=BUCKETS[key]||{title:key};
  var extra=skipped?', <span class="muted"><b>'+skipped+'</b> already in your CRM</span>':'';
  var done=document.createElement('div');
  done.className='grp-done';
  done.id='grp-'+key;
  done.innerHTML='<span class="ok">'+ICONS.check+'</span><span>'+esc(meta.title)+': <b>'+added+'</b> moved to your leads'+extra+'</span><a href="/leads">Open leads</a>';
  el.replaceWith(done);
}
async function moveGroup(e,key){
  if(e){e.preventDefault();e.stopPropagation()}
  var list=(GROUPS[key]||[]).filter(function(p){return !p.moved});
  if(!list.length)return;
  var b=document.getElementById('mv-'+key);
  if(b){b.disabled=true;b.innerHTML=ICONS.clock+' Moving…'}
  var r=await post('/api/crm/move',{prospects:list,bucket:key});
  if(!r||!r.ok){if(b){b.disabled=false;b.innerHTML=ICONS.warn+' Try again'}return}
  list.forEach(function(p){p.moved=true});
  collapseGroup(key,r.added||0,r.skipped||0);
}
function findProspect(id){
  for(var i=0;i<GROUP_KEYS.length;i++){
    var l=GROUPS[GROUP_KEYS[i]]||[];
    for(var j=0;j<l.length;j++)if(String(l[j].id)===String(id))return l[j];
  }
  return null;
}
async function addLead(id,bucket){
  var p=findProspect(id);
  if(!p)return;
  var b=document.getElementById('s-'+id);
  if(b)b.disabled=true;
  var r=await post('/api/crm/move',{prospects:[p],bucket:bucket});
  if(!r||!r.ok){if(b){b.disabled=false;b.innerHTML=ICONS.warn+' Try again'}return}
  p.moved=true;
  if(b){b.innerHTML=ICONS.check+' In your leads';b.classList.add('saved-on');b.onclick=null}
}

function render(s,prospects,mode){
  document.getElementById('statsWrap').innerHTML=
    '<div class="stats" style="grid-template-columns:repeat(3,1fr)">'+
    stat(s.qualified,'No-website leads','good')+stat(s.scanned||0,'Scanned')+stat(s.hasWebsite!=null?s.hasWebsite:0,'Already had a site')+
    '</div>';
  // After a search the user just ran, glide down to the results so they don't have to
  // scroll to find them. Skip on 'restored' (that fires on page load, so jumping would jar).
  if(mode!=='restored'){var __sw=document.getElementById('statsWrap');if(__sw)setTimeout(function(){__sw.scrollIntoView({behavior:'smooth',block:'start'});},80);}
  if(!prospects.length){st(mode==='fresh'||mode==='batch'?'Nothing came back. Try a higher Depth, more cities, or All trades.':'No results yet. Hit Search to find some.');return}
  GROUPS=groupProspects(prospects);
  var msg = mode==='cached' ? 'Saved results, <b>no credits used</b>. Hit Re-scan for fresh data.'
          : mode==='restored' ? 'Restored your last search. No credits used.'
          : mode==='batch' ? 'Batch scan done across <b>'+(s.cells||'?')+'</b> trade and city combos.'
          : 'Scan finished.';
  // Show WHY leads were dropped (transparency), with the real cutoff label.
  var since=s.sinceLabel?(' since '+s.sinceLabel):'';
  var parts=[];
  if(s.staleSeen)parts.push('<b>'+s.staleSeen+'</b> too old');
  if(s.unknownSeen)parts.push('<b>'+s.unknownSeen+'</b> undated');
  var hid = s.inactive ? ' &nbsp;<span class="muted">· hid '+s.inactive+' inactive'+since+(parts.length?' ('+parts.join(', ')+')':'')+'</span>' : '';
  var merged = s.crossSourceMerged ? ' &nbsp;<span class="muted">· merged '+s.crossSourceMerged+' cross-source duplicate'+(s.crossSourceMerged===1?'':'s')+'</span>' : '';
  st(msg+' &nbsp;<span class="muted">('+prospects.length+' shown)</span>'+hid+merged);
  // The value story first: how much ground the scan covered for them.
  var scanned=Number(s.scanned||0);
  var head=scanned?'<div class="scanline">We scanned <b>'+scanned.toLocaleString()+' businesses</b> for you and sorted them into three lists.</div>':'';
  document.getElementById('results').innerHTML=head+colNav()+'<div class="cols">'+GROUP_KEYS.map(colSection).join('')+'</div>';
  collapseSearch();
}
function stat(n,l,cls){return '<div class="stat '+(cls||'')+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
function card(p,bucket){
  var email=p.email?'<span class="email">'+ICONS.mail+' '+esc(p.email)+'</span>':'<span class="noemail">no email found</span>';
  var saveBtn=p.saved||p.moved
    ? '<button class="save saved-on" id="s-'+p.id+'" disabled>'+ICONS.check+' In your leads</button>'
    : '<button class="save" id="s-'+p.id+'" onclick="addLead(\\''+p.id+'\\',\\''+bucket+'\\')">'+ICONS.crm+' Add</button>';
  // Activity badge: why this business landed in the list it did.
  var fresh = p.activeStatus==='active'
    ? '<span class="fresh-badge fresh-active">'+ICONS.dot+' Active · '+esc(p.lastActive)+(p.activeSignal?' · '+esc(p.activeSignal):'')+'</span>'
    : p.lastActive
    ? '<span class="fresh-badge fresh-stale">'+ICONS.clock+' Last seen '+esc(p.lastActive)+'</span>'
    : '<span class="fresh-badge fresh-unknown">'+ICONS.clock+' no dated activity</span>';
  // License/registration signal (best-effort, from the business's own profile text) plus a
  // one-click link to verify it on an official search. Never hides a lead, just informs.
  var lic=p.license||{};
  var licBadge = lic.status==='mentioned'
    ? '<span class="lic-badge lic-yes" title="What the business advertises. Confirm it with Verify.">'+ICONS.badge+' '+esc(lic.evidence||'licensed/registered')+'</span>'
    : '<span class="lic-badge lic-no" title="Nothing found in their profile text. Check the official search.">'+ICONS.badge+' no license info</span>';
  var lic_line = '<div style="margin-top:6px">'+licBadge+(p.licenseUrl?' <a class="lic-verify" href="'+p.licenseUrl+'" target="_blank" rel="noopener">Verify</a>':'')+'</div>';
  var tag = bucket==='has_website' ? 'has a website' : 'no website';
  // Marking a business off works on its lead row, and a browsable "also seen" business
  // doesn't have one yet (it gets a "w3" style id instead of a numeric one). Those get no
  // dismiss button rather than a button that quietly does nothing.
  var hideBtn = isStored(p.id)
    ? '<button class="hide" onclick="hideLead(\\''+p.id+'\\')" title="Mark off so it never shows in a future search">'+ICONS.x+'</button>'
    : '';
  return '<div class="lead" id="lead-'+p.id+'">'+
    '<div><h3>'+esc(p.name)+'<span class="badge">'+tag+'</span></h3>'+
    '<div class="meta">'+esc(p.category||'')+' · '+esc(p.city||'')+', '+esc(p.state||'')+' · '+esc(p.phone||'no phone')+'</div>'+
    '<div class="meta"><span class="src">'+esc(srcName(p.source))+'</span> &nbsp; '+email+'</div>'+
    '<div style="margin-top:6px">'+fresh+'</div>'+lic_line+'</div>'+
    '<div style="display:flex;gap:8px;align-items:center">'+
      saveBtn+hideBtn+
    '</div>'+
    '</div>';
}
// A numeric id means the business is already a lead row in the database; anything else is a
// scan result the user can browse but hasn't taken yet.
function isStored(id){return /^\\d+$/.test(String(id))}
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
async function hideLead(id){
  await post('/api/dismiss/'+id,{});
  const el=document.getElementById('lead-'+id);
  if(el){el.style.transition='opacity .3s';el.style.opacity='0';setTimeout(()=>el.remove(),300)}
}
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

// ── LEADS PAGE ──────────────────────────────────────────────────────────────
// One page for the whole working lifecycle. Every saved lead sits in exactly one bucket
// (no-website / not active / has a website), and inside its bucket it is either in the
// WORKING list (nothing scheduled) or the FOLLOW-UPS list (a date is set, soonest first).
// Setting a follow-up is the "I did something here, remind me later" gesture, and it is
// the only thing that moves a row between those two lists.
const CRM_STAGES = ["New", "Contacted", "Interested", "Won", "Lost"];

// Human "how long ago" from either a SQLite UTC datetime ("2026-06-09 14:03:00") or a
// Postgres timestamptz ("2026-06-09T14:03:00+00:00") — the two providers differ.
function daysAgo(dt) {
  const then = parseStamp(dt);
  if (then == null) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// Epoch ms from any stamp the two providers produce: an ISO timestamp, a SQLite UTC
// datetime, or a plain "YYYY-MM-DD". Returns null when it can't be read.
function parseStamp(dt) {
  if (!dt) return null;
  const s = String(dt).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const local = new Date(`${s}T00:00:00`).getTime();
    return isNaN(local) ? null : local;
  }
  const iso = /[TZ+]|\d{2}:\d{2}:\d{2}\.\d+/.test(s.slice(10)) ? s.replace(" ", "T") : s.replace(" ", "T") + "Z";
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

// Scrapers write a few variants ("google", "google_maps"), so match on the prefix.
function srcLabel(s) {
  const v = String(s || "");
  if (v.startsWith("facebook")) return "Facebook";
  if (v.startsWith("instagram")) return "Instagram";
  if (v.startsWith("google")) return "Google";
  return v || "unknown";
}

// "Sep 4 · in 3d" for a scheduled follow-up, with a class that flags overdue/soon.
// Mirrored by fuLabel() in the page script so a row updated in place reads identically.
function followUpInfo(dt) {
  const ts = parseStamp(dt);
  if (ts == null) return { label: "", cls: "", ts: 0 };
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / 86400000);
  const date = new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days < 0) return { label: `${date} · overdue`, cls: "od", ts };
  if (days === 0) return { label: `${date} · today`, cls: "soon", ts };
  if (days === 1) return { label: `${date} · tomorrow`, cls: "soon", ts };
  return { label: `${date} · in ${days}d`, cls: "", ts };
}

// The per-row "Follow up" control: presets, a custom date, and a clear.
function followMenu(id) {
  const opt = (when, label) =>
    `<button type="button" class="fu-opt" onclick="setFollowUp(${id},'${when}')">${label}</button>`;
  return `<details class="fumenu">
    <summary title="Set a follow-up and come back to this later">${icon("clock", 14)}<span>Follow up</span></summary>
    <div class="fumenu-pop">
      ${opt("3d", "In 3 days")}${opt("1w", "In 1 week")}${opt("2w", "In 2 weeks")}${opt("1m", "In 1 month")}
      <label class="fu-custom">Pick a date<input type="date" onchange="setFollowUp(${id},this.value)"></label>
      <button type="button" class="fu-opt fu-clear" onclick="setFollowUp(${id},'')">Clear, back to working</button>
    </div>
  </details>`;
}

// One CRM row. Identical in both lists so a row can move between them without the
// columns shifting; only the follow-up cell changes.
function renderCrmRow(l) {
  const opts = CRM_STAGES.map(
    (s) => `<option value="${s}"${l.crm_stage === s ? " selected" : ""}>${s}</option>`
  ).join("");
  const bucket = CRM_BUCKETS.includes(l.bucket) ? l.bucket : "qualified";
  const fu = followUpInfo(l.follow_up_at);
  const contacted = daysAgo(l.contacted_on);
  const fuCell = fu.label
    ? `<span class="fudate ${fu.cls}">${icon("clock", 13)}${esc(fu.label)}</span>`
    : `<span class="muted">${contacted ? `contacted ${esc(contacted)}` : "not scheduled"}</span>`;
  const moveOpts = CRM_BUCKETS.filter((b) => b !== bucket)
    .map((b) => `<option value="${b}">${esc(BUCKET_META[b].title)}</option>`)
    .join("");
  return `<tr id="crm-${l.id}" data-bucket="${bucket}" data-fu="${fu.ts || 0}">
    <td><b>${esc(l.name)}</b><div class="sub">${esc(l.category || "")} · ${esc(l.city || "")}, ${esc(l.state || "")}</div><div class="sub" style="margin-top:5px">${licenseBadgeHtml(l)}</div></td>
    <td>${esc(l.phone || "no phone")}<div class="sub">${l.email ? esc(l.email) : '<span class="warn">no email</span>'}</div></td>
    <td><span class="src">${esc(srcLabel(l.source))}</span></td>
    <td class="fucell">${fuCell}</td>
    <td><select class="stage" onchange="setStage(${l.id},this.value)">${opts}</select></td>
    <td><input class="notes" value="${esc(l.notes || "")}" placeholder="notes…" onchange="setNotes(${l.id},this.value)"></td>
    <td class="actions">
      ${followMenu(l.id)}
      <select class="movebucket" title="Move this lead to another list" onchange="moveBucket(${l.id},this.value,this)"><option value="">Move to…</option>${moveOpts}</select>
      <button class="rm" onclick="removeCrm(${l.id})">Remove</button>
    </td>
  </tr>`;
}

const CRM_COLS = 7;
function crmTable(bucket, list, rows) {
  const empty = list === "working" ? "Nothing in this list right now." : "No follow-ups scheduled here.";
  return `<div class="tblwrap"><table>
    <thead><tr><th>Business</th><th>Contact</th><th>Source</th><th>Follow-up</th><th>Stage</th><th>Notes</th><th>Actions</th></tr></thead>
    <tbody id="tb-${bucket}-${list}">${rows.map(renderCrmRow).join("")}<tr class="emptyrow"${
      rows.length ? ' style="display:none"' : ""
    }><td colspan="${CRM_COLS}">${empty}</td></tr></tbody>
  </table></div>`;
}

// One bucket: its working list, then its follow-ups. The first bucket is the main
// workflow and opens expanded; the other two start collapsed.
function bucketSection(key, data, open) {
  const meta = BUCKET_META[key];
  const working = data.working || [];
  const followups = data.followups || [];
  const anchor = key === "qualified" ? ' id="followups"' : "";
  return `<details class="bucket" id="sec-${key}"${open ? " open" : ""}>
  <summary>
    <span class="bk-ttl">${esc(meta.title)}</span>
    <span class="bk-n" id="cnt-${key}-all">${working.length + followups.length}</span>
    <span class="bk-sub">${esc(meta.sub)}</span>
  </summary>
  <div class="bk-body">
    <div class="listhead">Working <span class="cnt" id="cnt-${key}-working">${working.length}</span></div>
    ${crmTable(key, "working", working)}
    <div class="listhead"${anchor}>Follow-ups <span class="cnt" id="cnt-${key}-followups">${followups.length}</span> <span class="listsub">soonest first</span></div>
    ${crmTable(key, "followups", followups)}
  </div>
</details>`;
}

// Your own reminders (people you called off your own bat), separate from the lead rows.
function renderFollowupItem(f) {
  const info = followUpInfo(f.due);
  const done = !!f.done;
  return `<div class="fu-item${done ? " fu-done" : ""}" id="fu-${f.id}">
    <div class="fu-main">
      <div class="fu-title">${esc(f.title)} ${
        f.due ? `<span class="fu-due ${info.cls}">${icon("calendar", 13)}${esc(info.label)}</span>` : ""
      }</div>
      ${f.note ? `<div class="fu-note">${esc(f.note)}</div>` : ""}
    </div>
    <div class="fu-actions">
      <button class="fu-btn" onclick="fuDone(${f.id},${done ? 0 : 1})">${
        done ? `${icon("undo", 13)} Undo` : `${icon("check", 13)} Done`
      }</button>
      <button class="fu-btn fu-del" onclick="fuDel(${f.id})">Remove</button>
    </div>
  </div>`;
}

// store.listCrm() hands back { qualified:{working,followups}, inactive:{…}, has_website:{…} }
// with followups already sorted soonest-first. This just guarantees every bucket and list
// exists so the page can render a bucket the store had nothing for.
function normalizeCrm(raw) {
  const out = {};
  for (const b of CRM_BUCKETS) {
    const g = (raw && raw[b]) || {};
    out[b] = {
      working: Array.isArray(g.working) ? g.working : [],
      followups: Array.isArray(g.followups) ? g.followups : [],
    };
  }
  return out;
}

async function renderLeadsPage(req) {
  const [crmRaw, reminders] = await Promise.all([store.listCrm(req.userId), store.listFollowups(req.userId)]);
  const crm = normalizeCrm(crmRaw);

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  let total = 0;
  let scheduled = 0;
  let dueNow = 0;
  for (const b of CRM_BUCKETS) {
    total += crm[b].working.length + crm[b].followups.length;
    scheduled += crm[b].followups.length;
    for (const l of crm[b].followups) {
      const ts = parseStamp(l.follow_up_at);
      if (ts != null && ts <= endOfToday.getTime()) dueNow++;
    }
  }
  const openReminders = reminders.filter((f) => !f.done).length;
  const stats = total
    ? `<b>${total}</b> lead${total === 1 ? "" : "s"} in play &nbsp;·&nbsp; <b>${scheduled}</b> scheduled follow-up${
        scheduled === 1 ? "" : "s"
      }${dueNow ? ` &nbsp;·&nbsp; <b class="duenow">${dueNow} due now</b>` : ""}`
    : "Nothing here yet. Run a search and move the results over.";

  const sections = CRM_BUCKETS.map((b, i) => bucketSection(b, crm[b], i === 0)).join("");
  const empty = total
    ? ""
    : `<div class="empty">No leads yet.<br>Go to <a href="/">Search</a>, run a scan, then use <b>Move all to CRM</b> on the results.</div>`;

  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector · Leads</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1200px;margin:auto}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .stats{color:var(--muted);font-size:13px;margin-bottom:16px}
  .duenow{color:var(--warn)}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:11px 14px;border-bottom:1px solid var(--border)}
  td{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .sub{color:var(--muted);font-size:12px;margin-top:3px}.warn{color:#e0a93b}
  .src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  select.stage,input.notes,select.movebucket{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:7px 9px;color:var(--text);font-size:13px}
  input.notes{width:100%;min-width:150px}
  select.movebucket{font-size:12px;padding:6px 8px;max-width:130px}
  .actions{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
  .rm{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px;font-family:inherit}
  .rm:hover{color:#e05b5b;border-color:#e05b5b}
  .search{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:11px 14px;color:var(--text);font-size:15px;margin-bottom:16px}
  .search::placeholder{color:var(--muted)}
  #noMatch{display:none;color:var(--muted);text-align:center;margin:20px 0;font-size:14px}
  .empty{color:var(--muted);text-align:center;margin-top:40px;font-size:15px}
  .lic-badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .lic-verify{font-size:12px;text-decoration:none;margin-left:6px}
  /* ── Bucket sections ── */
  .bucket{background:var(--panel);border:1px solid var(--border);border-radius:12px;margin-bottom:14px;overflow:hidden}
  .bucket>summary{list-style:none;cursor:pointer;padding:15px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .bucket>summary::-webkit-details-marker{display:none}
  .bucket>summary::after{content:"";flex:none;width:9px;height:9px;margin-left:auto;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg) translateY(-2px);transition:transform .15s;order:1}
  .bucket[open]>summary::after{transform:rotate(225deg) translateY(-2px)}
  .bk-ttl{font-weight:700;font-size:15px;color:var(--text)}
  .bk-n{font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;background:var(--surface2);color:var(--muted)}
  #sec-qualified .bk-n{background:var(--accent-weak);color:var(--accent-ink)}
  .bk-sub{font-size:13px;color:var(--muted);flex:1 1 100%;margin-top:-4px;order:2}
  .bk-body{padding:0 14px 16px}
  .listhead{display:flex;align-items:center;gap:8px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:700;margin:10px 0 8px}
  .listhead .cnt{background:var(--surface2);color:var(--muted);border-radius:20px;padding:1px 8px;font-size:11px}
  .listhead .listsub{text-transform:none;letter-spacing:0;font-weight:400}
  .tblwrap{overflow-x:auto}
  .emptyrow td{color:var(--muted);font-size:13px;text-align:center;padding:16px}
  tbody tr.justmoved{animation:pop 1.2s ease-out}
  @keyframes pop{0%{background:var(--accent-weak)}100%{background:transparent}}
  /* ── Follow-up control ── */
  .fudate{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;white-space:nowrap;color:var(--muted)}
  .fudate.soon{color:var(--warn)}.fudate.od{color:var(--danger)}
  .fumenu{position:relative}
  .fumenu>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap}
  .fumenu>summary::-webkit-details-marker{display:none}
  .fumenu>summary:hover{color:var(--text)}
  .fumenu-pop{position:absolute;z-index:20;right:0;top:calc(100% + 5px);min-width:190px;display:flex;flex-direction:column;gap:2px;background:var(--panel);border:1px solid var(--border-strong);border-radius:10px;padding:6px;box-shadow:0 12px 28px rgba(0,0,0,.22)}
  .fu-opt{font-family:inherit;text-align:left;background:transparent;border:none;border-radius:6px;padding:8px 10px;font-size:13px;color:var(--text);cursor:pointer}
  .fu-opt:hover{background:var(--surface2)}
  .fu-clear{color:var(--muted);border-top:1px solid var(--border);border-radius:0 0 6px 6px;margin-top:2px}
  .fu-custom{display:flex;flex-direction:column;gap:5px;padding:6px 10px 8px;font-size:12px;color:var(--muted)}
  .fu-custom input{font-size:13px;border-radius:6px;padding:6px 8px}
  /* ── Your reminders panel ── */
  .fubox{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:16px}
  .fubox h3{font-size:14px;margin-bottom:12px;font-weight:700}
  .fu-add{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1.6fr) auto auto;gap:10px}
  .fu-add input{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:9px 12px;color:var(--text);font-size:14px}
  .fu-add button{background:var(--gold);color:#000;border:none;border-radius:8px;padding:9px 18px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit}
  .fu-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
  .fu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:11px 14px}
  .fu-item.fu-done{opacity:.5}.fu-item.fu-done .fu-title{text-decoration:line-through}
  .fu-title{font-weight:700;font-size:14px}
  .fu-note{color:var(--muted);font-size:13px;margin-top:3px}
  .fu-due{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:var(--muted);margin-left:6px}
  .fu-due.soon{color:var(--warn)}.fu-due.od{color:var(--danger)}
  .fu-actions{display:flex;gap:8px;white-space:nowrap}
  .fu-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:var(--text);border-radius:7px;padding:6px 11px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit}
  .fu-del{color:var(--muted)}.fu-del:hover{color:#e05b5b;border-color:#e05b5b}
  @media(max-width:820px){.fu-add{grid-template-columns:1fr}}
${SHARED_CSS}</style></head><body>
${sidebar("leads", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Leads</h1><div class="pagesub">The businesses you're working, and when to call them back</div></div><div class="spacer"></div></div>
<div class="stats">${stats}</div>

<div class="fubox">
  <h3>Your reminders</h3>
  <div class="fu-add">
    <input id="fuTitle" placeholder="Who or which business (e.g. Joe's Roofing)">
    <input id="fuNote" placeholder="Note, optional (e.g. called, wants a quote)">
    <input id="fuDue" type="date" title="Follow up on">
    <button onclick="addFu()">Add reminder</button>
  </div>
  <div class="fu-list" id="fuList">${
    reminders.length
      ? reminders.map(renderFollowupItem).join("")
      : '<div class="empty" style="margin:6px 0;text-align:left;font-size:13px">No reminders of your own yet. Add one above.</div>'
  }</div>
</div>

<input class="search" id="q" placeholder="Filter every list by name, category, city, or phone" oninput="filterRows()">
<div id="noMatch">No leads match your filter.</div>
${sections}
${empty}
<script>
${iconScript(["clock", "check", "warn"], 13)}
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
async function post(url,data){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
var BUCKET_KEYS=${JSON.stringify(CRM_BUCKETS)};
var BUCKETS=${JSON.stringify(BUCKET_META)};

// ── stage / notes / remove ──
async function setStage(id,stage){await post('/api/crm/update/'+id,{stage:stage})}
async function setNotes(id,notes){await post('/api/crm/update/'+id,{notes:notes})}
async function removeCrm(id){
  await post('/api/crm/remove/'+id,{});
  var r=document.getElementById('crm-'+id);
  if(r)r.remove();
  paintCounts();
}

// ── follow-ups on a lead ──
// Same wording the server renders, so a row updated in place reads identically.
function fuLabel(iso){
  if(!iso)return {label:'',cls:'',ts:0};
  var ts=Date.parse(iso);
  if(isNaN(ts))return {label:'',cls:'',ts:0};
  var day=new Date(ts);day.setHours(0,0,0,0);
  var today=new Date();today.setHours(0,0,0,0);
  var days=Math.round((day.getTime()-today.getTime())/86400000);
  var date=new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  if(days<0)return {label:date+' · overdue',cls:'od',ts:ts};
  if(days===0)return {label:date+' · today',cls:'soon',ts:ts};
  if(days===1)return {label:date+' · tomorrow',cls:'soon',ts:ts};
  return {label:date+' · in '+days+'d',cls:'',ts:ts};
}
async function setFollowUp(id,when){
  var r=await post('/api/leads/'+id+'/followup',{when:when});
  closeMenus();
  if(!r||!r.ok)return;
  var row=document.getElementById('crm-'+id);
  if(!row)return;
  var info=fuLabel(r.followUpAt);
  row.setAttribute('data-fu',info.ts||0);
  var cell=row.querySelector('.fucell');
  if(cell)cell.innerHTML=info.label
    ? '<span class="fudate '+info.cls+'">'+ICONS.clock+esc(info.label)+'</span>'
    : '<span class="muted">not scheduled</span>';
  moveRowTo(row,row.getAttribute('data-bucket')||'qualified',r.followUpAt?'followups':'working');
}
async function moveBucket(id,bucket,sel){
  if(sel)sel.selectedIndex=0;
  if(!bucket)return;
  var r=await post('/api/leads/'+id+'/bucket',{bucket:bucket});
  if(!r||!r.ok)return;
  var row=document.getElementById('crm-'+id);
  if(!row)return;
  row.setAttribute('data-bucket',bucket);
  var sec=document.getElementById('sec-'+bucket);
  if(sec)sec.open=true;
  moveRowTo(row,bucket,Number(row.getAttribute('data-fu'))>0?'followups':'working');
  rebuildMoveMenu(row,bucket,id);
}
function rebuildMoveMenu(row,bucket,id){
  var sel=row.querySelector('.movebucket');
  if(!sel)return;
  var html='<option value="">Move to…</option>';
  for(var i=0;i<BUCKET_KEYS.length;i++){
    var b=BUCKET_KEYS[i];
    if(b!==bucket)html+='<option value="'+b+'">'+esc(BUCKETS[b].title)+'</option>';
  }
  sel.innerHTML=html;
}
// Move a row between lists without reloading, then re-sort and re-count.
function moveRowTo(row,bucket,list){
  var tb=document.getElementById('tb-'+bucket+'-'+list);
  if(!tb)return;
  tb.appendChild(row);
  if(list==='followups')sortFollowups(tb);
  paintCounts();
  row.classList.remove('justmoved');
  void row.offsetWidth;
  row.classList.add('justmoved');
}
function dataRows(tb){
  return Array.prototype.filter.call(tb.children,function(r){return !r.classList.contains('emptyrow')});
}
function sortFollowups(tb){
  var rows=dataRows(tb).sort(function(a,b){return (Number(a.getAttribute('data-fu'))||0)-(Number(b.getAttribute('data-fu'))||0)});
  var blank=tb.querySelector('.emptyrow');
  rows.forEach(function(r){tb.appendChild(r)});
  if(blank)tb.appendChild(blank);
}
function paintCounts(){
  BUCKET_KEYS.forEach(function(b){
    var all=0;
    ['working','followups'].forEach(function(list){
      var tb=document.getElementById('tb-'+b+'-'+list);
      if(!tb)return;
      var n=dataRows(tb).length;
      all+=n;
      var c=document.getElementById('cnt-'+b+'-'+list);
      if(c)c.textContent=n;
      var blank=tb.querySelector('.emptyrow');
      if(blank)blank.style.display=n?'none':'';
    });
    var t=document.getElementById('cnt-'+b+'-all');
    if(t)t.textContent=all;
  });
}
function closeMenus(){
  document.querySelectorAll('details.fumenu[open]').forEach(function(d){d.open=false});
}
document.addEventListener('click',function(e){
  document.querySelectorAll('details.fumenu[open]').forEach(function(d){if(!d.contains(e.target))d.open=false});
});

// ── your own reminders ──
async function addFu(){
  var t=document.getElementById('fuTitle'),n=document.getElementById('fuNote'),d=document.getElementById('fuDue');
  if(!t.value.trim()){t.focus();return}
  var r=await post('/api/followup/add',{title:t.value,note:n.value,due:d.value});
  if(r.ok)location.reload();
}
async function fuDone(id,done){await post('/api/followup/update/'+id,{done:!!done});location.reload()}
async function fuDel(id){await post('/api/followup/remove/'+id,{});var r=document.getElementById('fu-'+id);if(r)r.remove()}

// ── filter ──
function filterRows(){
  var box=document.getElementById('q');
  if(!box)return;
  var q=box.value.toLowerCase().trim(),shown=0;
  document.querySelectorAll('tbody tr').forEach(function(r){
    if(r.classList.contains('emptyrow'))return;
    var hit=!q||r.textContent.toLowerCase().indexOf(q)>-1;
    r.style.display=hit?'':'none';
    if(hit)shown++;
  });
  var nm=document.getElementById('noMatch');
  if(nm)nm.style.display=(q&&!shown)?'block':'none';
  if(q)document.querySelectorAll('details.bucket').forEach(function(d){d.open=true});
}
paintCounts();
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

// ── WINS PAGE (the closed-deal trophy case) ──
// "$2,400" — commas, no cents unless the amount actually has them.
function fmtMoney(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: v % 1 ? 2 : 0 });
}

// A win's date, from either a SQLite UTC datetime ("2026-08-26 14:03:00") or a
// Postgres timestamptz — mirrors daysAgo()'s two-provider parsing.
function winDate(dt) {
  if (!dt) return "";
  const s = String(dt);
  const iso = /[TZ+]|\d{2}:\d{2}:\d{2}\.\d+/.test(s.slice(10)) ? s.replace(" ", "T") : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function winRow(w) {
  const amt = w.amount === null || w.amount === undefined || w.amount === ""
    ? '<span class="muted">no amount</span>'
    : esc(fmtMoney(w.amount));
  return `<tr id="win-${w.id}" data-amount="${Number(w.amount) || 0}">
    <td><b>${esc(w.client_name)}</b></td>
    <td class="amt">${amt}</td>
    <td>${w.note ? esc(w.note) : '<span class="muted">no note</span>'}</td>
    <td class="d">${winDate(w.created_at)}</td>
    <td class="actions"><button class="rm" onclick="removeWin(${w.id})">Remove</button></td>
  </tr>`;
}

async function renderWinsPage(req) {
  const [stats, wins] = await Promise.all([
    store.winStats(req.userId),
    store.listWins(req.userId),
  ]);
  const count = stats.count || 0;
  const total = stats.total || 0;
  const rows = wins.map(winRow).join("");
  const statLine = `${count} win${count === 1 ? "" : "s"} · ${fmtMoney(total)} closed`;

  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector · Wins</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wins-stat{font-size:20px;font-weight:800;color:var(--text);margin-bottom:20px;font-variant-numeric:tabular-nums}
  .winform{padding:20px 22px;margin-bottom:22px}
  .winform h3{font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px}
  .wrow{display:grid;grid-template-columns:1.5fr .8fr 1.7fr auto;gap:12px;align-items:end}
  .wrow .f{min-width:0}
  .wrow label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
  .wrow input{width:100%}
  .wrow .go{white-space:nowrap}
  #winMsg{margin-top:10px;font-size:13px;color:var(--danger);min-height:16px}
  table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:12px 14px}
  td{padding:12px 14px;font-size:14px;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  td.amt{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
  td.d{color:var(--muted);white-space:nowrap}
  td.actions{text-align:right;white-space:nowrap}
  .rm{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
  .rm:hover{color:var(--danger);border-color:var(--danger)}
  .empty{color:var(--muted);text-align:center;margin-top:44px;font-size:15px}
  @media(max-width:640px){.wrow{grid-template-columns:1fr 1fr}.wrow .go{grid-column:1/-1;width:100%}}
${SHARED_CSS}</style></head><body>
${sidebar("wins", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Wins</h1><div class="pagesub">The deals you've closed</div></div><div class="spacer"></div></div>
<div class="wins-stat" id="winStat">${esc(statLine)}</div>

<div class="panel winform">
  <h3>Log a win</h3>
  <div class="wrow">
    <div class="f"><label for="wClient">Client / trade</label><input id="wClient" placeholder="Acme Roofing" autocomplete="off"></div>
    <div class="f"><label for="wAmount">Amount <span class="muted" style="font-weight:400">optional</span></label><input id="wAmount" type="number" min="0" step="any" placeholder="2400"></div>
    <div class="f"><label for="wNote">Note <span class="muted" style="font-weight:400">optional</span></label><input id="wNote" placeholder="quoted, signed…" autocomplete="off"></div>
    <button class="go" onclick="addWin()">Add win</button>
  </div>
  <div id="winMsg"></div>
</div>

<div id="winsWrap">
  <table id="winsTable"${count ? "" : ' style="display:none"'}>
    <thead><tr><th>Client / trade</th><th>Amount</th><th>Note</th><th>Date</th><th></th></tr></thead>
    <tbody id="winRows">${rows}</tbody>
  </table>
  <div id="winsEmpty" class="empty"${count ? ' style="display:none"' : ""}>No wins logged yet. Add your first closed deal.</div>
</div>

<script>
var winCount=${count}, winTotal=${total};
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
async function post(url,data){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function fmtMoney(n){var v=Number(n)||0;return '$'+v.toLocaleString('en-US',{maximumFractionDigits:v%1?2:0})}
function paintStat(){document.getElementById('winStat').textContent=winCount+' win'+(winCount===1?'':'s')+' · '+fmtMoney(winTotal)+' closed'}
function paintChrome(){document.getElementById('winsTable').style.display=winCount?'':'none';document.getElementById('winsEmpty').style.display=winCount?'none':''}
async function addWin(){
  var c=document.getElementById('wClient'),a=document.getElementById('wAmount'),n=document.getElementById('wNote'),msg=document.getElementById('winMsg');
  msg.textContent='';
  if(!c.value.trim()){msg.textContent='Add a client name.';c.focus();return}
  var body={clientName:c.value.trim(),amount:a.value.trim(),note:n.value.trim()};
  var r=await post('/api/wins',body);
  if(!r||!r.ok){msg.textContent=(r&&r.error)||'Could not add win.';return}
  var amt=body.amount===''?null:Number(body.amount);
  if(!isFinite(amt))amt=null;
  var tr=document.createElement('tr');
  tr.id='win-'+r.id;
  tr.setAttribute('data-amount',amt||0);
  tr.innerHTML='<td><b>'+esc(body.clientName)+'</b></td>'+
    '<td class="amt">'+(amt==null?'<span class="muted">no amount</span>':esc(fmtMoney(amt)))+'</td>'+
    '<td>'+(body.note?esc(body.note):'<span class="muted">no note</span>')+'</td>'+
    '<td class="d">just now</td>'+
    '<td class="actions"><button class="rm" onclick="removeWin('+r.id+')">Remove</button></td>';
  winCount++;winTotal+=(amt||0);
  paintChrome();
  var tb=document.getElementById('winRows');tb.insertBefore(tr,tb.firstChild);
  paintStat();
  c.value='';a.value='';n.value='';c.focus();
}
async function removeWin(id){
  var r=await post('/api/wins/remove/'+id,{});
  if(!r||!r.ok)return;
  var tr=document.getElementById('win-'+id);
  if(tr){var amt=Number(tr.getAttribute('data-amount'))||0;winCount=Math.max(0,winCount-1);winTotal=Math.max(0,winTotal-amt);tr.remove()}
  paintStat();paintChrome();
}
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}
