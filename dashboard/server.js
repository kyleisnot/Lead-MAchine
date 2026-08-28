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
import {
  discover, discoverMany, discoverGuaranteed, willSearchSpend, listingUrlFor,
  GUARANTEE_TARGET,
} from "../lib/pipeline.js";
import { NICHES } from "../lib/niches.js";
import { lastActiveLabel, activityStatus, activitySignal, cutoffLabel, freshnessConfig } from "../lib/freshness.js";
import { spendCapState, RATE_PER_1K } from "../lib/spend.js";
import { detectLicenseSignal, licenseSearchUrl } from "../lib/license.js";
import { isRealWebsiteUrl } from "../scrapers/filter.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar, FAVICON } from "./shell.js";
import { authRouter, requireUser } from "./auth.js";
import { accountRouter } from "./account.js";
// PLANS is the operator's price list (admin.js owns it). The Wins page reads the current
// tier's monthly price from it to work out what the month's closed revenue is worth
// against what the plan costs. admin.js does not import this file, so nothing circles.
import { adminRouter, PLANS } from "./admin.js";
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
    // The same trophy the sidebar draws for Wins, so the nav mark and the page header agree.
    wins: '<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0z"></path><path d="M7 6H4v1a4 4 0 0 0 3 3.9M17 6h3v1a4 4 0 0 1-3 3.9"></path>',
    // A written-on page: the per-row notes toggle on the Leads table.
    note: '<path d="M14.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5z"></path><path d="M14 3v6h6"></path><path d="M8.5 13h7M8.5 16.5h4.5"></path>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"></path><polyline points="21 3 21 9 15 9"></polyline>',
    // Opens the listing on the site the scan found it on, in a new tab.
    external: '<path d="M14 4h6v6"></path><path d="M20 4l-8 8"></path><path d="M18 13.5v5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h5"></path>',
    // A tall business tower with window ticks next to a small house: the mix of
    // local businesses a scan turns up, and the mark for the Companies table.
    companies:
      '<path d="M3 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16"></path>' +
      '<path d="M6 7h1M9 7h1M6 11h1M9 11h1M6 15h1M9 15h1"></path>' +
      '<path d="M15 21v-6.6l3-2.4 3 2.4V21"></path><path d="M18 21v-3"></path>' +
      '<path d="M2 21h20"></path>',
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
    title: "No-website companies",
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
// 3. accountRouter: a normal signed-in area (/account, /account/tokens, /account/help),
//    so it sits with the routes below, not with the operator routers.
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
// Tokens back to the USD the meter stores, so a flat price and a per-place scan land in
// the same usage_log column and every downstream total keeps adding up.
const tokensToUsd = (tokens) => (Number(tokens) || 0) / TOKENS_PER_USD;

// ── The two search modes ─────────────────────────────────────────────────────
// "Scan 50 businesses" is the everyday one: a fixed amount of looking, billed per place.
// "Guaranteed 5 companies" sells the result instead of the effort, at one flat price.
const STANDARD_DEPTH = 50;
const GUARANTEED_FIVE_TOKENS = Math.max(0, parseInt(process.env.GUARANTEED_FIVE_TOKENS || "60", 10) || 0);
// What a standard scan of N places costs the customer, in tokens. The search page shows
// the same number before the scan runs.
const standardTokens = (places) => usdToTokens((Math.max(0, places) / 1000) * RATE_PER_1K);

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
// What the allotment gate decides for one search, as a plain rule over three numbers.
// Split out of the route so the decision can be reasoned about (and checked) on its own.
//   need > 0 is a price known UP FRONT, the guaranteed mode's flat charge. A plan that
//   cannot cover it is stopped before the scan, rather than after the money is spent.
export function allotmentVerdict({ allotment = 0, used = 0, need = 0 }) {
  const plan = Number(allotment) || 0;
  // 0 = account not yet given a plan. (New convention: 0 no longer means "unlimited".)
  if (plan <= 0) return { blocked: true, status: 402, reason: "unassigned" };
  if (used >= plan) return { blocked: true, status: 429, reason: "used-up" };
  if (need > 0 && plan - used < need) {
    return { blocked: true, status: 429, reason: "short", remaining: plan - used, need };
  }
  return { blocked: false, reason: "" };
}

// Block a live (credit-spending) search once this user's monthly allotment can't cover it.
// Their allotment lives on their profile row; it refills on the 1st.
async function blockedByAllotment(req, res, { live, need = 0 }) {
  if (!live) return false;
  // An admin presenting a demo (staged or prospect) must never be stalled mid-meeting
  // by the TARGET account's plan — the gate applies to real customers only.
  if (req.isDemo) return false;
  const profile = await store.getProfile(req.userId);
  const raw = Number.parseInt(profile?.monthly_token_allotment, 10);
  const allotment = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const used = allotment ? await monthTokensUsed(req.userId) : 0;
  const v = allotmentVerdict({ allotment, used, need });
  if (!v.blocked) return false;
  const error =
    v.reason === "unassigned"
      ? "Your account isn't active yet. Reach out to have your monthly tokens set up."
      : v.reason === "short"
        ? `This search costs ${need.toLocaleString()} tokens and you have ${v.remaining.toLocaleString()} left this month. ` +
          `They refill on ${planResetLabel()}, or ask for a top-up to run it now.`
        : `You've used all ${allotment.toLocaleString()} tokens in your plan this month. ` +
          `They refill on ${planResetLabel()}, or ask for a top-up to keep searching now.`;
  res.status(v.status).json({ ok: false, error });
  return true;
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

// ── Auto-save: a search result IS a list of companies ────────────────────────
// Nothing a scan finds is worth making the user click to keep, so every completed search
// files its results into their companies before the response goes out, under the bucket
// each one landed in. store.moveToCrm adopts rather than clobbers and skips anything
// already saved, which is what makes replaying a search a no-op instead of a duplicate.
function bucketOfSlim(p) {
  if (p.hasWebsite) return "has_website";
  return p.activeStatus === "active" ? "qualified" : "inactive";
}
async function autoSaveResults(userId, slim) {
  const groups = { qualified: [], inactive: [], has_website: [] };
  for (const p of slim || []) groups[bucketOfSlim(p)].push(p);
  const buckets = {};
  let added = 0;
  let skipped = 0;
  for (const b of CRM_BUCKETS) {
    if (!groups[b].length) { buckets[b] = { added: 0, skipped: 0 }; continue; }
    const r = (await store.moveToCrm(userId, groups[b], b)) || {};
    buckets[b] = { added: r.added || 0, skipped: r.skipped || 0 };
    added += buckets[b].added;
    skipped += buckets[b].skipped;
  }
  // They are in the CRM now either way, so the page renders every row already saved.
  for (const p of slim || []) p.saved = true;
  return { buckets, added, skipped };
}

// A list of values from either an array field or a single one, trimmed and de-blanked.
function listOf(many, one) {
  const raw = Array.isArray(many) ? many : [one];
  return raw.map((s) => String(s ?? "").trim()).filter(Boolean);
}

// ── SEARCH API: run a live lookup (Google + Facebook) for a niche + city ──
// Two modes. "standard" scans a fixed 50 businesses per cell and is billed per place.
// "guaranteed" keeps scanning until five qualified companies are found and is billed one
// flat price, unless a cap stops it short, in which case it falls back to the standard
// per-place rate for what was actually scanned, so a thin market never costs the premium.
app.post("/api/search", async (req, res) => {
  const body = req.body || {};
  const guaranteed = body.mode === "guaranteed";
  const { state, forceRefresh } = body;
  const resolvedSources = body.sources?.length ? body.sources : ["google", "facebook"];
  const cities = listOf(body.cities, body.city);
  const niches = listOf(body.niches, body.niche);
  if (!niches.length || !cities.length) {
    return res.status(400).json({ ok: false, error: "Need a niche and a city." });
  }
  try {
    if (guaranteed) {
      // The flat price is known before a single business is scanned, so the plan gate
      // gets to see it up front rather than discovering the overspend afterwards.
      if (await blockedBySpendCap(res, { live: true })) return;
      if (await blockedByAllotment(req, res, { live: true, need: GUARANTEED_FIVE_TOKENS })) return;
      const r = await discoverGuaranteed({
        userId: req.userId,
        niches,
        cities,
        state,
        sources: resolvedSources,
        forceRefresh: !!forceRefresh,
      });
      const g = r.guarantee;
      // Met: the flat price. Short of five: the standard per-place rate for the scan that
      // actually ran. Served entirely from cache: nothing, like any other replay.
      const costUsd = r.cached ? 0 : g.met ? tokensToUsd(GUARANTEED_FIVE_TOKENS) : (g.scanned / 1000) * RATE_PER_1K;
      await store.logUsage(req.userId, "search", costUsd);
      const prospects = r.prospects.map(slimProspect).concat(r.alsoSeen || []);
      const saved = await autoSaveResults(req.userId, prospects);
      return res.json({
        ok: true,
        mode: "guaranteed",
        stats: r.stats,
        cached: !!r.cached,
        guarantee: g,
        charged: { tokens: usdToTokens(costUsd), basis: r.cached ? "cached" : g.met ? "guarantee" : "scan" },
        saved: saved.buckets,
        savedTotals: { added: saved.added, skipped: saved.skipped },
        prospects,
      });
    }

    const niche = niches[0];
    const city = cities[0];
    const limit = Number(body.limit) > 0 ? Number(body.limit) : STANDARD_DEPTH;
    // Any search that will actually hit Apify (a cold/uncached lookup OR a forced re-scan)
    // spends credits — guard ALL of those, not just forced re-scans. Cached searches are
    // free and stay allowed even when capped.
    const willSpend = await willSearchSpend({ userId: req.userId, niche, city, state, sources: resolvedSources, limit, forceRefresh: !!forceRefresh });
    if (await blockedBySpendCap(res, { live: willSpend })) return;
    if (await blockedByAllotment(req, res, { live: willSpend })) return;
    const { prospects: found, stats, cached, cachedAt, alsoSeen } = await discover({
      userId: req.userId,
      niche,
      city,
      state,
      sources: resolvedSources,
      limit,
      forceRefresh: !!forceRefresh,
    });
    // The qualifying leads plus the in-niche businesses the scan saw but skipped (the ones
    // that already have a website). They arrive pre-slimmed and carry hasWebsite, so the
    // page's own grouping drops each into the right section.
    const prospects = found.map(slimProspect).concat(alsoSeen || []);
    // A cached replay saves too: moveToCrm skips every row that is already there, so this
    // costs one dedup pass and keeps a re-run honest about what it added (nothing).
    const saved = await autoSaveResults(req.userId, prospects);
    res.json({
      ok: true,
      mode: "standard",
      stats,
      cached: !!cached,
      cachedAt: cachedAt || null,
      saved: saved.buckets,
      savedTotals: { added: saved.added, skipped: saved.skipped },
      prospects,
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
    const { prospects: found, stats, alsoSeen } = await discoverMany({
      userId: req.userId,
      niches: nicheList,
      cities: cityList,
      state,
      sources: sources?.length ? sources : ["google", "facebook"],
      limit: Number(limit) > 0 ? Number(limit) : STANDARD_DEPTH,
      forceRefresh: !!forceRefresh,
    });
    const prospects = found.map(slimProspect).concat(alsoSeen || []);
    const saved = await autoSaveResults(req.userId, prospects);
    res.json({
      ok: true,
      mode: "standard",
      stats,
      saved: saved.buckets,
      savedTotals: { added: saved.added, skipped: saved.skipped },
      prospects,
    });
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
// Stage, notes, or both. A stage change also settles this company's win (see
// syncWinToStage), so the client never has to make two calls and can never end up looking
// at a stage and a win that disagree. A notes-only save sends no stage and touches nothing.
app.post("/api/crm/update/:id", route(async (req, res) => {
  const stage = req.body?.stage;
  await store.updateCrm(req.userId, req.params.id, { stage, notes: req.body?.notes });
  if (stage === undefined || stage === null || String(stage) === "") return res.json({ ok: true });
  const { win, removed } = await syncWinToStage(req.userId, req.params.id, stage);
  res.json({ ok: true, stage: String(stage), win: winPayload(win), removed });
}));

// ── LEADS: one page, three bucket tabs, each with a working + follow-up list ──
// The old views (?view=tracked / found / followup) are gone; the whole lifecycle is on the
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
    // The Google/Facebook/Instagram page this business was found on, so the Source cell
    // can open the actual listing instead of just naming the platform.
    listingUrl: listingUrlFor({ source: l.source, external_id: l.external_id, ...lj }),
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
    query: { niche: ls.niche, city: ls.city, state: ls.state, sources: ls.sources, limit: ls.limit, mode: ls.mode || "standard" },
    stats: ls.stats,
    prospects: rows.map(slimProspect).concat(alsoSeen),
  });
}));
// Note: a restore deliberately does NOT save anything. The rows it hands back were already
// filed when the search itself ran, and re-filing them on every page load would let a
// company the user has since removed from their companies quietly come back.

// ── WINS: the user's closed-deal scoreboard ──
// A win is not a separate thing you type up. Marking a company Won on the Companies page
// IS logging the win, moving it off Won takes that win back off the board, and the amount
// is filled in from the row. Hand-typed wins still exist for deals done outside the tool:
// those carry no lead and nothing here ever touches them. The API is user-scoped through
// ../data/store.js exactly like every other data call in this file.
app.get("/wins", route(async (req, res) => res.send(await renderWinsPage(req))));

// "$1,200" / " 1200 " / "1,200.50" → 1200 / 1200.5. A blank field, or anything that
// isn't a usable non-negative number, is null: a win with no dollar figure on it. That is
// the Skip case, and it still counts as a win: the deal closed, the revenue is unknown.
function moneyOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[^0-9.]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The win shape the page scripts read back: amount is a number or null, never a string.
function winPayload(w) {
  if (!w) return null;
  const amt = w.amount;
  return {
    id: w.id,
    clientName: w.clientName ?? "",
    amount: amt === null || amt === undefined || amt === "" ? null : Number(amt),
    note: w.note || "",
    leadId: w.leadId ?? null,
  };
}

// Keep one company's win in step with the stage it just moved to. Won gets a win; every
// other stage takes it away. The Won half deliberately leaves an existing win alone, so
// marking the same company Won twice can never log it twice and can never wipe an amount
// that was already recorded.
async function syncWinToStage(userId, leadId, stage) {
  if (String(stage) !== "Won") {
    const r = await store.removeWinForLead(userId, leadId);
    return { win: null, removed: Number(r?.removed) || 0 };
  }
  const existing = await store.winForLead(userId, leadId);
  if (existing) return { win: existing, removed: 0 };
  const lead = await store.getLead(userId, leadId);
  const win = await store.setWinForLead(userId, leadId, {
    clientName: (lead && lead.name) || "This company",
    amount: null,
    note: "",
  });
  return { win, removed: 0 };
}

// The amount (and note) on a company's win: what the prompt in the Companies row saves,
// and what the row's "add amount" affordance fills in later. An upsert, so saving twice
// edits the one win instead of logging a second. Guarded on the stage, because a win
// that doesn't mirror a Won company is exactly the contradiction this model removes.
app.post("/api/leads/:id/win", route(async (req, res) => {
  const lead = await store.getLead(req.userId, req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: "That company is not in your list." });
  if (String(lead.crm_stage || "") !== "Won") {
    return res.status(400).json({ ok: false, error: "Mark this company Won first." });
  }
  const win = await store.setWinForLead(req.userId, req.params.id, {
    clientName: lead.name || "This company",
    amount: moneyOrNull(req.body?.amount),
    note: String(req.body?.note ?? "").trim(),
  });
  res.json({ ok: true, win: winPayload(win) });
}));

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

// ── The setup checklist's "Hide this" ──
// The card is rendered by THIS page, so its dismiss lives here rather than in the account
// area. It is a stored preference, not a browser one, so hiding it on a laptop also hides
// it on a phone. Registered above the account router so this path is unambiguously ours.
app.post("/api/account/onboarding/dismiss", route(async (req, res) => {
  await store.dismissOnboarding(req.userId, true);
  res.json({ ok: true });
}));

// The account area: profile, tokens and help. Mounted with the other signed-in routes
// (after requireUser, before the admin/demo routers below) so every route inside it
// already knows who is asking.
app.use(accountRouter);

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

// ── Shared table CSS (Search's Companies panel + the Leads page) ──
// Both pages show the same object: a titled panel, an underline tab bar, a filter
// toolbar, and one full-width table underneath. The rules that make that look live here
// so the two pages can't drift; each page's own <style> adds only its column widths and
// the trimmings its cells need. Spliced in before each page's own rules, so a page can
// still override a shared declaration (e.g. table.cotable's min-width) by repeating it.
const TABLE_CSS = `
  .copanel{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 20px 20px}
  .cohead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cohead .co-ic{display:inline-flex;color:var(--muted);flex:none}
  .cohead .co-ic svg{width:19px;height:19px}
  .cohead .co-ttl{font-size:17px;font-weight:700;letter-spacing:-.2px;color:var(--text)}
  .cohead .co-n{font-size:13px;font-weight:500;color:var(--muted)}

  /* Bucket tabs: the selected one carries a dark underline sitting on the bar's hairline. */
  .btabs{display:flex;flex-wrap:wrap;gap:24px;border-bottom:1px solid var(--border);margin:15px 0 0}
  .btab{position:relative;display:inline-flex;align-items:center;gap:7px;font-family:inherit;background:none;border:0;padding:0 0 11px;font-size:14px;font-weight:600;color:var(--muted);cursor:pointer}
  .btab:hover{color:var(--text)}
  .btab.on{color:var(--text)}
  .btab.zero{color:var(--faint)}
  .btab.zero:hover{color:var(--muted)}
  .btab .bt-n{font-size:13px;font-weight:600;color:var(--faint)}
  .btab.on .bt-n{color:var(--muted)}
  .btab .bt-u{position:absolute;left:0;right:0;bottom:-1px;height:3px;border-radius:2px;background:transparent}
  .btab.on .bt-u{background:var(--text)}

  /* Toolbar: a rounded live filter on the left, the page's own control on the right. */
  .cotools{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:16px 0 0}
  .cofind{position:relative;flex:1 1 260px;min-width:190px;max-width:400px}
  .cofind .cf-i{position:absolute;left:13px;top:50%;transform:translateY(-50%);display:inline-flex;color:var(--faint);pointer-events:none}
  .cofind input{width:100%;border-radius:999px;padding:9px 14px 9px 37px;font-size:13.5px}

  /* The table. Narrow screens scroll the table itself, never the whole page. */
  .cotwrap{overflow-x:auto;margin-top:14px;border-top:1px solid var(--border)}
  table.cotable{width:100%;border-collapse:collapse;background:transparent;border:0;table-layout:fixed}
  table.cotable th{text-align:left;font-size:12px;font-weight:700;color:var(--muted);white-space:nowrap;padding:11px 14px 11px 0;border-bottom:1px solid var(--border);background:transparent;position:static}
  table.cotable td{height:52px;vertical-align:middle;padding:8px 14px;padding-left:0;border-bottom:1px solid var(--border);font-size:13.5px;color:var(--muted)}
  table.cotable tbody tr:nth-child(even){background:transparent}
  table.cotable tbody tr:hover{background:var(--surface2)}
  table.cotable tbody tr.norow:hover{background:transparent}
  table.cotable tr.gone{display:none}
  .cotable .c-name{line-height:1.35}
  .cotable .c-nm{font-size:14px;font-weight:700;color:var(--text)}
  .cotable .c-tags{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:5px}
  .cotable .c-tags .badge{margin-left:0;font-size:10.5px;padding:2px 7px}
  .cotable .c-tags .lic-badge{font-size:10.5px;padding:1px 7px;max-width:118px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .cotable .c-mut{color:var(--muted)}
  .cotable .c-ic{display:inline-flex;align-items:center;gap:5px;color:var(--muted)}
  .cotable .c-em{color:var(--accent)}
  /* A phone number is a call, not a link to read: it keeps body colour so a table of
     them doesn't turn into a wall of blue, and only underlines when you reach for it. */
  .cotable a.c-tel{color:var(--text);text-decoration:none}
  .cotable a.c-tel:hover{color:var(--accent-ink);text-decoration:underline}
  /* The listing the scan found this business on. Quiet by default, same size as the
     source name it replaces, with the arrow only hinting that it leaves the page. */
  a.c-src{color:var(--muted);text-decoration:none;border-bottom:1px solid transparent}
  a.c-src:hover{color:var(--accent-ink);border-bottom-color:var(--accent-ink)}
  a.c-src svg{flex:none;opacity:.75;margin-left:3px}
  .cotable a.c-src{display:inline-flex;align-items:center}
  .cotable .c-tags a.c-src{font-size:11px;font-weight:600}
  .cotable .c-act{text-align:right;white-space:nowrap;padding-right:0}
  .co-empty{padding:24px 0;color:var(--muted);font-size:14px}
  @media (max-width:760px){.copanel{padding:16px 14px}.btabs{gap:18px}}
`;

// ── Setup checklist (first run) ──────────────────────────────────────────────
// The five things a new account has to do before the tool is really theirs. Kept as a
// pure function of the account's own data so the card can never disagree with reality:
// there is no "seen it" flag per step, a step is done because the data says it is.
//   1-3 come off the profile the account page writes.
//   4   is any search in this month's usage log (the same count /api/usage reports).
//   5   is any logged win.
export function setupSteps({ profile = {}, searches = 0, wins = 0 } = {}) {
  const set = (v) => !!String(v ?? "").trim();
  return [
    {
      key: "agency", title: "Tell us about your agency",
      sub: "Your name and agency, so quotes and emails go out as you",
      href: "/account", cta: "Add your details", done: set(profile.agencyName),
    },
    {
      key: "market", title: "Set your market",
      sub: "The city and state you sell in, filled in for every search",
      href: "/account", cta: "Set your market", done: set(profile.defaultCity) && set(profile.defaultState),
    },
    {
      key: "trades", title: "Pick the trades you sell to",
      sub: "The trade a search starts on, so you are one click from a scan",
      href: "/account", cta: "Pick a trade", done: set(profile.defaultNiche),
    },
    {
      key: "search", title: "Run your first search",
      sub: "Find local businesses in your market with no website yet",
      href: "#searchpanel", cta: "Run a search", done: (Number(searches) || 0) > 0,
    },
    {
      key: "win", title: "Log your first win",
      sub: "Every closed deal you log adds up on your Wins page",
      href: "/wins", cta: "Log a win", done: (Number(wins) || 0) > 0,
    },
  ];
}

// The whole first-run region: an optional plan notice, then the checklist.
//
// The two are deliberately separate bands rather than one card. They answer different
// questions and have different lifetimes: "can I search at all yet?" is a fact about the
// account that only an operator can change, so it stays put and is not dismissable, while
// "what should I set up next?" is the user's own list and they can hide it. Stacking the
// notice ABOVE the checklist keeps the blocking fact first without hiding the setup work
// a brand-new account can still get on with while it waits for tokens.
function setupRegionHtml({ steps, unassigned, dismissed }) {
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  const plan = !unassigned ? "" : `
  <div class="setup-plan" id="prSetupPlan">
    <span class="setup-plan-i">${icon("clock", 17)}</span>
    <div>
      <b>Your account is not active yet</b>
      <p>Everything here is ready except the tokens that pay for a search, and only an
      operator can add those. <a href="/account/tokens">Ask to have your plan activated</a>
      and you can run your first search the moment it lands.</p>
    </div>
  </div>`;
  // Nothing left to say: no plan notice and a checklist that is either finished-and-seen
  // or hidden by the user.
  if (!plan && dismissed) return "";
  let card = "";
  if (!dismissed && allDone) {
    // The finish line, shown once. renderSearchPage() dismisses it as it hands this back,
    // so the next load is a clean page instead of a card with nothing left to ask for.
    card = `
  <div class="setup-card setup-allset" id="prSetupCard">
    <span class="setup-mark">${icon("check", 18)}</span>
    <div class="setup-allset-b">
      <h2 class="setup-h">You are all set</h2>
      <p id="prSetupProgress">${doneCount} of ${steps.length} done. Nothing left to set up, so this card is finished.</p>
      <div class="setup-bar"><div class="setup-bar-fill" id="prSetupBar" style="width:100%"></div></div>
    </div>
  </div>`;
  } else if (!dismissed) {
    const pct = Math.round((doneCount / steps.length) * 100);
    const rows = steps.map((s) => `
      <li class="setup-step${s.done ? " done" : ""}" data-step="${s.key}">
        <span class="setup-tick">${s.done ? icon("check", 12) : ""}</span>
        <span class="setup-lbl"><b>${esc(s.title)}</b><span class="setup-sub">${esc(s.sub)}</span></span>
        ${s.done
          ? `<span class="setup-flag">Done</span>`
          : `<a class="setup-go" href="${s.href}"${s.key === "search" ? ` onclick="openSearch();return false;"` : ""}>${esc(s.cta)}</a>`}
      </li>`).join("");
    card = `
  <div class="setup-card" id="prSetupCard">
    <div class="setup-head">
      <div>
        <h2 class="setup-h">Finish setting up your account</h2>
        <div class="setup-prog" id="prSetupProgress">${doneCount} of ${steps.length} done</div>
      </div>
      <button type="button" class="setup-hide" onclick="prDismissSetup()">Hide this</button>
    </div>
    <div class="setup-bar"><div class="setup-bar-fill" id="prSetupBar" style="width:${pct}%"></div></div>
    <ul class="setup-steps">${rows}
    </ul>
  </div>`;
  }
  return `<div class="setup" id="prSetup" role="region" aria-label="Getting started">${plan}${card}
</div>`;
}

// Styling for the region above. Same card language as .panel (surface, 1px border, 12px
// radius); the checklist carries an accent left edge so it reads as guidance rather than
// as a result, and the plan notice uses the warn pair because it is a block, not advice.
const SETUP_CSS = `
  .setup{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
  .setup-plan{display:flex;gap:13px;align-items:flex-start;background:var(--warn-weak);border:1px solid var(--warn);border-radius:12px;padding:15px 17px}
  .setup-plan-i{flex:none;display:inline-flex;color:var(--warn);margin-top:1px}
  .setup-plan b{display:block;font-size:14.5px;font-weight:700;color:var(--text);margin-bottom:4px}
  .setup-plan p{margin:0;font-size:13.5px;line-height:1.55;color:var(--muted)}
  .setup-plan a{font-weight:700;text-decoration:none}
  .setup-plan a:hover{text-decoration:underline}
  .setup-card{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:17px 19px}
  .setup-head{display:flex;align-items:flex-start;gap:12px}
  .setup-h{font-size:16px;font-weight:800;letter-spacing:.1px;color:var(--text);margin:0}
  .setup-prog{margin-top:4px;font-size:13px;color:var(--muted)}
  .setup-hide{margin-left:auto;flex:none;font-family:inherit;background:transparent;border:1px solid var(--border-strong);color:var(--muted);border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer}
  .setup-hide:hover{background:var(--surface2);color:var(--text)}
  .setup-bar{height:4px;border-radius:3px;background:var(--surface2);overflow:hidden;margin:13px 0 2px}
  .setup-bar-fill{height:100%;border-radius:3px;background:var(--accent);transition:width .2s}
  .setup-steps{list-style:none;margin:4px 0 0;padding:0}
  .setup-step{display:flex;align-items:center;gap:12px;padding:10px 8px;border-radius:9px}
  .setup-step:hover{background:var(--surface2)}
  .setup-tick{flex:none;width:20px;height:20px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--faint)}
  .setup-step.done .setup-tick{border-color:transparent;background:var(--accent-weak);color:var(--accent-ink)}
  .setup-lbl{min-width:0}
  .setup-lbl b{display:block;font-size:13.5px;font-weight:700;color:var(--text)}
  .setup-step.done .setup-lbl b{color:var(--muted);font-weight:600}
  .setup-sub{display:block;margin-top:2px;font-size:12.5px;line-height:1.45;color:var(--muted)}
  .setup-step.done .setup-sub{color:var(--faint)}
  .setup-go{margin-left:auto;flex:none;font-size:12.5px;font-weight:700;text-decoration:none;white-space:nowrap}
  .setup-go:hover{text-decoration:underline}
  .setup-flag{margin-left:auto;flex:none;font-size:12px;font-weight:600;color:var(--faint)}
  .setup-allset{display:flex;align-items:center;gap:14px}
  .setup-allset-b{flex:1;min-width:0}
  .setup-mark{flex:none;width:34px;height:34px;border-radius:9px;background:var(--accent-weak);color:var(--accent-ink);display:grid;place-items:center}
  .setup-allset p{margin:4px 0 0;font-size:13.5px;line-height:1.5;color:var(--muted)}
  .setup-allset .setup-bar{margin:11px 0 1px}
  @media (max-width:700px){.setup-step{flex-wrap:wrap}.setup-go,.setup-flag{margin-left:32px}}
`;

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

  // Everything the first-run region and the prefilled form need, in one round trip.
  const [profile, usage, wins] = await Promise.all([
    store.getProfile(req.userId),
    store.usageSummary(req.userId),
    store.winStats(req.userId),
  ]);
  const steps = setupSteps({ profile, searches: usage.searches, wins: wins.count });
  const allotRaw = Number.parseInt(profile?.monthly_token_allotment, 10);
  const unassigned = !(Number.isFinite(allotRaw) && allotRaw > 0); // 0 = no plan yet, can't search
  const dismissed = !!profile?.onboardingDismissed;
  const setupHtml = setupRegionHtml({ steps, unassigned, dismissed });
  // Showing the finished card IS the last thing it has to do, so record that and let the
  // next load come up clean. (Every step being done is itself permanent, so re-showing it
  // would just be a card the user can never make progress on.)
  if (!dismissed && steps.every((s) => s.done)) await store.dismissOnboarding(req.userId, true);

  // Form prefill. The account's own market and trade win over the built-in example values;
  // a remembered last search still beats both, because restoreLast() below overwrites the
  // fields (and re-runs the estimate) once it comes back.
  const pre = (v, fallback) => esc(String(v ?? "").trim() || fallback);
  const preCity = pre(profile?.defaultCity, "Knoxville");
  const preState = pre(profile?.defaultState, "TN");
  const preNiche = pre(profile?.defaultNiche, "landscaping");

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
  /* The receipt: what filing this list changed. It sits where the bulk-move button used
     to, and reads as a statement rather than a control, because it is one. */
  .receipt{display:inline-flex;align-items:center;gap:9px;font-size:13px;color:var(--muted);white-space:nowrap}
  .receipt b{color:var(--text)}
  .receipt .ok{display:inline-flex;color:var(--accent)}
  .receipt a{font-weight:700;text-decoration:none;white-space:nowrap}
  .statuserr{display:inline-flex;align-items:center;gap:7px;color:var(--danger)}
  .grp .lead{margin:10px 0 0}

  /* Collapsed search bar: once results are on screen the form folds into one line. */
  .srchbar[hidden]{display:none}
  .srchbar{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:16px}
  .srchbar .sb-i{display:inline-flex;color:var(--muted);flex:none}
  .srchbar .sb-q{font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .srchbar .sb-q .muted{font-weight:500}
  .srchbar .sb-go{display:inline-flex;align-items:center;gap:7px;font-family:inherit;margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;flex:none}
  .srchbar .sb-go:hover{border-color:var(--accent);color:var(--accent)}

  /* ── Companies: one full-width table, one bucket on screen at a time ── */
  /* The panel, tabs, toolbar and table styling are shared with the Leads page. */
${TABLE_CSS}
  .copanel .scanline{margin:8px 0 0}
  .cotools .receipt{margin-left:auto}
  table.cotable{min-width:940px}
  /* Fixed column widths, sized so nothing needs a scrollbar at a normal desktop width.
     The action column is budgeted for its widest state: "In your companies" plus dismiss. */
  table.cotable th:nth-child(1),table.cotable td:nth-child(1){width:22%}
  table.cotable th:nth-child(2),table.cotable td:nth-child(2){width:9%}
  table.cotable th:nth-child(3),table.cotable td:nth-child(3){width:10%}
  table.cotable th:nth-child(4),table.cotable td:nth-child(4){width:12%;white-space:nowrap}
  table.cotable th:nth-child(5),table.cotable td:nth-child(5){width:13%;overflow-wrap:anywhere}
  table.cotable th:nth-child(6),table.cotable td:nth-child(6){width:8%}
  table.cotable th:nth-child(7),table.cotable td:nth-child(7){width:9%}
  table.cotable th:nth-child(8),table.cotable td:nth-child(8){width:17%}
  .cotable .c-actv{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 8px}
  .cotable .fresh-badge{margin:0;font-size:11.5px;padding:2px 8px}
  .cotable .c-act .save{padding:6px 11px;font-size:12px}
  .cotable .c-act .hide{padding:6px 9px;font-size:12px;margin-left:6px}
  @media (max-width:760px){.cotools .receipt{margin-left:0;white-space:normal}}
  .save{display:inline-flex;align-items:center;gap:6px}
  .fresh-badge svg,.lic-badge svg,.save svg,.hide svg{flex:none}
  .lic-badge{display:inline-flex;align-items:center;gap:5px}
  .fresh-badge{display:inline-flex;align-items:center;gap:5px}
  .fresh-stale{background:var(--surface2);color:var(--muted)}
${SHARED_CSS}
${SETUP_CSS}</style></head><body>
${sidebar("search", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Search</h1><div class="pagesub">Find local businesses that don't have a website yet</div></div><div class="spacer"></div>
  <div class="statbox">
    <div class="cell"><span class="k"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:4px"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>Remembered</span><span class="v" id="sbMem">&hellip;</span><span class="s2" id="sbMemSub"></span></div>
    <div class="sep"></div>
    <div class="cell"><span class="k">Tokens used</span><span class="v" id="sbTok">&hellip;</span><span class="s2" id="sbSearches"></span><div class="tokbar" id="sbBarWrap"><div class="tokbar-fill" id="sbBar"></div></div></div>
  </div>
</div>

<!-- First run: an activation notice for an account with no plan yet, then the setup
     checklist. Both are rendered server-side from this account's own data (profile,
     usage log, wins), so what they claim is always what the database says. -->
${setupHtml}

<details class="explain">
  <summary><span class="ex-ttl">What counts as a top prospect?</span><span class="ex-sub">a business must pass all 3 checks below</span></summary>
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
      <div class="f"><label for="city">City <span class="hint">comma-separate for several</span></label><input id="city" placeholder="Knoxville, Maryville, Oak Ridge" value="${preCity}"></div>
      <div class="f"><label for="state">State</label><input id="state" placeholder="TN" value="${preState}"></div>
    </div>
  </div>

  <div class="fgroup">
    <div class="glabel">What</div>
    <div class="f"><label for="niche">Trade</label><input id="niche" placeholder="landscaping" value="${preNiche}"></div>
    <div class="chips">${nicheButtons}</div>
    <label class="opt"><input type="checkbox" id="allNiches" oninput="updateEstimate()"> Search <b>all trades</b> at once</label>
  </div>

  <div class="fgroup">
    <div class="glabel">How to search</div>
    <div class="frow deep">
      <div class="f"><label for="source">Sources</label><select id="source">
        <option value="all">All (Google + Facebook + Instagram)</option>
        <option value="facebook">Facebook only</option>
        <option value="instagram">Instagram only</option>
        <option value="google">Google only</option>
      </select></div>
      <div class="f"><label for="mode">Search <span class="hint">a set amount of looking, or a set result</span></label><select id="mode" onchange="updateEstimate()">
        <option value="standard">Scan ${STANDARD_DEPTH} businesses</option>
        <option value="guaranteed">Guaranteed ${GUARANTEE_TARGET} companies</option>
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
  var STANDARD_DEPTH = ${STANDARD_DEPTH};
  var GUARANTEE_TARGET = ${GUARANTEE_TARGET};
  var GUARANTEE_TOKENS = ${GUARANTEED_FIVE_TOKENS};
  ${iconScript(["check", "x", "warn", "clock", "mail", "dot", "badge", "refresh", "undo", "search", "companies", "external"], 14)}
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
var PROG_STAGES=['Scanning Google Maps\u2026','Checking Facebook pages\u2026','Checking Instagram profiles\u2026','Dropping businesses that already have a website\u2026','Checking who is still active\u2026','Putting your list together\u2026'];
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
function chosenMode(){var m=document.getElementById('mode');return m&&m.value==='guaranteed'?'guaranteed':'standard'}

// Live estimate. The two modes promise different things, so they read differently: the
// standard one prices the looking, the guaranteed one prices the result.
function updateEstimate(){
  const el=document.getElementById('estimate');
  if(chosenMode()==='guaranteed'){
    el.className='estimate';
    el.innerHTML='<b>'+GUARANTEE_TARGET+' no-website companies</b> or you pay standard rate · usually <b>2 to 8 min</b> · <b>'+GUARANTEE_TOKENS.toLocaleString()+' tokens</b>';
    return;
  }
  const cities=parseCities().length||1, niches=chosenNiches().length||1, sources=chosenSources().length, depth=STANDARD_DEPTH;
  const cells=cities*niches;
  const places=cells*sources*depth;
  const tokens=Math.round((places/1000)*RATE_PER_1K*TOKENS_PER_USD);
  const totalSec=cells*estSeconds(sources,depth);
  const big=totalSec>700; // near the server's run limit
  el.className='estimate'+(big?' big':'');
  el.innerHTML=(big?ICONS.warn+' ':'')+'Scans <b>'+STANDARD_DEPTH+' businesses</b> per city and trade combo'+
    (cells>1?' (<b>'+cells+'</b> of them, ~'+places.toLocaleString()+' businesses)':'')+
    ' · about <b>'+fmtMin(totalSec)+'</b> · ~<b>'+tokens.toLocaleString()+' tokens</b>'+
    (big?' <span style="opacity:.85">(may be too big to finish in one run)</span>':'');
}

async function runSearch(force){
  const cities=parseCities();
  if(!cities.length){stErr('Enter at least one city.');return}
  const niches=chosenNiches();
  if(!niches.length){stErr('Enter a niche, or tick All trades.');return}
  const sources=chosenSources();
  const mode=chosenMode();
  const state=document.getElementById('state').value;
  const multi=cities.length>1||niches.length>1;
  // A guaranteed run stops as soon as it has five, so its clock is the observed spread
  // rather than a depth calculation. A standard one is the same arithmetic as the estimate.
  const expSec=mode==='guaranteed'?300:(cities.length*niches.length)*estSeconds(sources.length,STANDARD_DEPTH);

  // A single search must finish inside the server's run limit. Warn before one whose
  // estimate is long enough to risk timing out.
  if(mode!=='guaranteed'&&expSec>700&&!confirm('This search could take about '+Math.round(expSec/60)+' minutes, which may be too big to finish in one run. Try fewer trades or cities. Run it anyway?')) return;

  const btn=document.getElementById('goBtn'),rb=document.getElementById('rescanBtn');btn.disabled=true;rb.disabled=true;
  document.getElementById('results').innerHTML='';document.getElementById('statsWrap').innerHTML='';

  startProgress(expSec);
  let r;
  if(mode==='guaranteed'){
    // Every city (and trade) entered is the expansion pool: the run works city 1 until it
    // runs out of room there, then moves on, so one request covers the whole list.
    r=await post('/api/search',{mode:'guaranteed',niches,cities,state,sources,forceRefresh:!!force});
  }else if(multi){
    r=await post('/api/search-batch',{niches,cities,state,sources,limit:STANDARD_DEPTH,forceRefresh:!!force});
  }else{
    r=await post('/api/search',{niche:niches[0],city:cities[0],state,sources,limit:STANDARD_DEPTH,forceRefresh:!!force});
  }
  stopProgress();
  btn.disabled=false;rb.disabled=false;
  if(!r.ok){stErr(r.error);return}
  render(r.stats,r.prospects,mode==='guaranteed'?'guaranteed':(multi?'batch':(r.cached?'cached':'fresh')),r);
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

// ── The setup checklist's "Hide this" ───────────────────────────────────────
// The card is server-rendered, so hiding it is a stored preference rather than a browser
// one: it goes away here immediately AND stays away on the user's other devices. The
// activation notice above it is not part of the deal, because an account with no tokens
// still has to be told why searching is locked.
async function prDismissSetup(){
  var card=document.getElementById('prSetupCard');
  if(card)card.remove();
  var box=document.getElementById('prSetup');
  if(box&&!box.querySelector('.setup-plan'))box.remove();
  try{await post('/api/account/onboarding/dismiss',{});}catch(e){}
}

// ── Result grouping ────────────────────────────────────────────────────────
// Every result lands in exactly one of three groups, in the order you work them:
//   qualified    no website, still active      call these today
//   inactive     no website, but gone quiet    backups for later
//   has_website  already online                grab-later rebuild pitches
// Every one of them is already in the user's companies by the time this runs: the server
// files a search's results before it answers, so these groups are a view of what was
// saved, not a staging area waiting on a click.
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
// summary and hands the whole viewport to the Companies table.
function searchSummary(){
  var cities=parseCities().join(', ')||'anywhere';
  var stv=(document.getElementById('state').value||'').trim();
  var all=document.getElementById('allNiches').checked;
  var trade=all?'All trades':((document.getElementById('niche').value||'').trim()||'any trade');
  var msel=document.getElementById('mode');
  var modeTxt=msel?msel.options[msel.selectedIndex].text:'';
  var src=document.getElementById('source');
  var srcTxt=src&&src.value!=='all'?srcName(src.value):'all sources';
  return esc(trade)+' in '+esc(cities)+(stv?', '+esc(stv):'')+
    ' <span class="muted">'+esc(modeTxt)+', '+esc(srcTxt)+'</span>';
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

// ── The Companies table ──
// One full-width table instead of three cramped columns. The three buckets are the
// different types of lead, and they sit behind tabs: only one list is on screen at a
// time, so every business gets the whole row rather than a third of it.
var TAB='qualified';   // which bucket's table is showing
var SAVED={};          // bucket -> {added,skipped}, the server's receipt for this search
function firstFilled(){
  for(var i=0;i<GROUP_KEYS.length;i++){var k=GROUP_KEYS[i];if((GROUPS[k]||[]).length)return k}
  return GROUP_KEYS[0];
}
// What a tab counts: how many businesses this scan put in that list.
function leftIn(key){return (GROUPS[key]||[]).length}
function totalFound(){var n=0;GROUP_KEYS.forEach(function(k){n+=(GROUPS[k]||[]).length});return n}

function tabsHtml(){
  return '<div class="btabs" role="tablist">'+GROUP_KEYS.map(function(k){
    var meta=BUCKETS[k]||{title:k};
    var n=leftIn(k);
    return '<button type="button" class="btab'+(k===TAB?' on':'')+(n?'':' zero')+'" id="bt-'+k+'" role="tab"'+
      ' aria-selected="'+(k===TAB?'true':'false')+'" title="'+esc(meta.sub||'')+'"'+
      ' onclick="pickTab(\\''+k+'\\')">'+esc(meta.title)+
      '<span class="bt-n">'+n+'</span><span class="bt-u"></span></button>';
  }).join('')+'</div>';
}
// Repaint the tab bar in place (selection and counts) without rebuilding the table.
function paintTabs(){
  GROUP_KEYS.forEach(function(k){
    var b=document.getElementById('bt-'+k);
    if(!b)return;
    var n=leftIn(k);
    b.classList.toggle('on',k===TAB);
    b.classList.toggle('zero',!n);
    b.setAttribute('aria-selected',k===TAB?'true':'false');
    var c=b.querySelector('.bt-n');
    if(c)c.textContent=n;
  });
}
function pickTab(key){TAB=key;paintTabs();paintBody();}

// The receipt: what filing this list actually changed. It replaces the bulk-move button,
// because there is nothing left to press: the saving already happened.
function receiptText(added,skipped){
  var a=added===1?'<b>1</b> new company added to your lists':'<b>'+added.toLocaleString()+'</b> new companies added to your lists';
  if(!added&&skipped)return skipped===1?'That one was already in your lists':'All <b>'+skipped.toLocaleString()+'</b> were already in your lists';
  if(!skipped)return a;
  return a+', '+(skipped===1?'<b>1</b> was':'<b>'+skipped.toLocaleString()+'</b> were')+' already there';
}
function toolsHtml(key){
  // A restore has no receipt to show: the saving happened when the search itself ran, so
  // the line states where these companies already are instead of claiming a change.
  var s=SAVED&&SAVED[key];
  var line=s?receiptText(Number(s.added)||0,Number(s.skipped)||0):'These are all in your companies';
  return '<div class="cotools">'+
    '<div class="cofind"><span class="cf-i">'+ICONS.search+'</span>'+
      '<input id="cofind" type="text" autocomplete="off" placeholder="Search these results" oninput="filterRows()"></div>'+
    '<div class="receipt" id="rc-'+key+'"><span class="ok">'+ICONS.check+'</span>'+
      '<span>'+line+'</span>'+
      '<a href="/leads">Open companies</a></div>'+
  '</div>';
}
function tableHtml(key,list){
  return '<div class="cotwrap"><table class="cotable">'+
    '<thead><tr><th>Company name</th><th>Trade</th><th>City, state</th><th>Phone</th>'+
    '<th>Email</th><th>Source</th><th>Activity</th><th class="c-act"></th></tr></thead>'+
    '<tbody id="corows">'+list.map(function(p){return row(p,key)}).join('')+
      '<tr id="conone" class="norow gone"><td colspan="8" class="co-empty">No businesses here match that search.</td></tr>'+
    '</tbody></table></div>';
}
// The table area for whichever tab is selected: an empty-state line if the scan put
// nothing here, otherwise the toolbar (filter plus receipt) and the table.
function paintBody(){
  var host=document.getElementById('cobody');
  if(!host)return;
  var key=TAB;
  var list=GROUPS[key]||[];
  if(!list.length){host.innerHTML='<div class="co-empty">Nothing in this list from the last scan.</div>';return}
  host.innerHTML=toolsHtml(key)+tableHtml(key,list);
}

// ── One row ──
function dash(){return '<span class="c-mut">--</span>'}
function cell(v){return v?'<span class="c-mut">'+esc(String(v))+'</span>':dash()}
// A phone number on a table is something you dial, so it is a tel: link. The href is the
// bare digits (a leading + survives, since it is what makes an international number work);
// what you read stays exactly as the scan found it.
function telHref(v){
  var s=String(v||'').trim();
  if(!s)return '';
  var plus=s.charAt(0)==='+';
  var d=s.replace(/[^0-9]/g,'');
  return d?(plus?'+':'')+d:'';
}
function phoneCell(v){
  var href=telHref(v);
  if(!href)return cell(v);
  return '<a class="c-tel" href="tel:'+esc(href)+'">'+esc(String(v))+'</a>';
}
// The source cell opens the listing the scan actually found: the Maps place, the Facebook
// page, the Instagram profile. With no URL on the row it stays the plain platform name.
function sourceCell(p){
  var name=srcName(p.source);
  var url=p.listingUrl||'';
  if(!/^https?:\\/\\//i.test(url))return cell(name);
  return '<a class="c-src" href="'+esc(url)+'" target="_blank" rel="noopener" title="Open this '+esc(name)+' listing">'+esc(name)+ICONS.external+'</a>';
}
// Why this business landed in the list it did, kept to one line.
function activityCell(p){
  if(p.activeStatus==='active'){
    return '<span class="c-actv"><span class="fresh-badge fresh-active">'+ICONS.dot+' Active</span>'+
      (p.lastActive?'<span class="c-mut">'+esc(p.lastActive)+'</span>':'')+'</span>';
  }
  if(p.lastActive)return '<span class="c-ic">'+ICONS.clock+' '+esc(p.lastActive)+'</span>';
  return '<span class="c-mut">No dated activity</span>';
}
// What the toolbar search box matches against.
function findKey(p){return [p.name,p.category,p.city,p.phone,p.email].filter(Boolean).join(' ').toLowerCase()}
function row(p,bucket){
  // Marking a business off works on its lead row, and a browsable "also seen" business
  // doesn't have one yet (it gets a "w3" style id instead of a numeric one). Those get no
  // dismiss button rather than a button that quietly does nothing.
  var hideBtn = isStored(p.id)
    ? '<button class="hide" onclick="hideLead(\\''+p.id+'\\')" title="Mark off so it never shows in a future search">'+ICONS.x+'</button>'
    : '';
  // Nothing to add: the server filed this row before the page ever saw it, so the state
  // it renders in is the finished one.
  var addBtn = '<button class="save saved-on" id="s-'+p.id+'" disabled>'+ICONS.check+' In your companies</button>';
  // License/registration signal, from the business's own profile text. Only worth a
  // badge when there is one; "nothing found" is the normal case and just adds noise.
  var lic=p.license||{};
  var licTxt = esc(lic.evidence||'licensed/registered');
  var licBadge = lic.status==='mentioned'
    ? '<span class="lic-badge lic-yes" title="Advertises: '+licTxt+'. Confirm it on the official search.">'+ICONS.badge+' '+licTxt+'</span>'
    : '';
  var tag = bucket==='has_website' ? '' : '<span class="badge">no website</span>';
  var tags = (tag||licBadge) ? '<span class="c-tags">'+tag+licBadge+'</span>' : '';
  var place=[p.city,p.state].filter(Boolean).join(', ');
  return '<tr id="lead-'+p.id+'" data-k="'+esc(findKey(p))+'">'+
    '<td class="c-name"><span class="c-nm">'+esc(p.name||'')+'</span>'+tags+'</td>'+
    '<td>'+cell(p.category)+'</td>'+
    '<td>'+cell(place)+'</td>'+
    '<td>'+phoneCell(p.phone)+'</td>'+
    '<td>'+(p.email?'<span class="c-em" title="'+esc(p.email)+'">'+esc(p.email)+'</span>':dash())+'</td>'+
    '<td>'+sourceCell(p)+'</td>'+
    '<td>'+activityCell(p)+'</td>'+
    '<td class="c-act">'+addBtn+hideBtn+'</td>'+
  '</tr>';
}
// Live filter over the visible table: plain case-insensitive substring, no debounce
// needed at these list sizes.
function filterRows(){
  var tb=document.getElementById('corows');
  if(!tb)return;
  var box=document.getElementById('cofind');
  var q=(box?box.value:'').trim().toLowerCase();
  var rows=tb.querySelectorAll('tr[data-k]'),shown=0;
  for(var i=0;i<rows.length;i++){
    var hit=!q||rows[i].getAttribute('data-k').indexOf(q)>-1;
    rows[i].classList.toggle('gone',!hit);
    if(hit)shown++;
  }
  var none=document.getElementById('conone');
  if(none)none.classList.toggle('gone',shown>0);
}
function render(s,prospects,mode,resp){
  document.getElementById('statsWrap').innerHTML=
    '<div class="stats" style="grid-template-columns:repeat(3,1fr)">'+
    stat(s.qualified,'No-website companies','good')+stat(s.scanned||0,'Scanned')+stat(s.hasWebsite!=null?s.hasWebsite:0,'Already had a site')+
    '</div>';
  // After a search the user just ran, glide down to the results so they don't have to
  // scroll to find them. Skip on 'restored' (that fires on page load, so jumping would jar).
  if(mode!=='restored'){var __sw=document.getElementById('statsWrap');if(__sw)setTimeout(function(){__sw.scrollIntoView({behavior:'smooth',block:'start'});},80);}
  SAVED=(resp&&resp.saved)||null;
  if(!prospects.length){st(mode==='fresh'||mode==='batch'||mode==='guaranteed'?'Nothing came back. Try more cities, another trade, or All trades.':'No results yet. Hit Search to find some.');return}
  GROUPS=groupProspects(prospects);
  var g=(resp&&resp.guarantee)||null;
  // When the guarantee was met the headline is the promise kept. When a cap stopped it
  // short, say so plainly and say what it cost, because the price changed with it.
  var gmsg = !g ? ''
    : g.met ? 'Found your <b>'+g.target+' no-website companies</b>.'
    : 'Found <b>'+g.found+' of '+g.target+'</b>. You were charged for the scan, not the guarantee.';
  var msg = mode==='guaranteed' ? gmsg
          : mode==='cached' ? 'Saved results, <b>no credits used</b>. Hit Re-scan for fresh data.'
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
  var head=scanned?'<div class="scanline">We scanned <b>'+scanned.toLocaleString()+' businesses</b> for you, and every one below is already saved to your companies.</div>':'';
  TAB=firstFilled();
  document.getElementById('results').innerHTML=
    '<section class="copanel">'+
      '<div class="cohead"><span class="co-ic">'+ICONS.companies+'</span>'+
        '<span class="co-ttl">Companies</span>'+
        '<span class="co-n">'+totalFound().toLocaleString()+' found</span></div>'+
      head+tabsHtml()+'<div id="cobody"></div>'+
    '</section>';
  paintBody();
  collapseSearch();
}
function stat(n,l,cls){return '<div class="stat '+(cls||'')+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
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
  const ms=document.getElementById('mode');
  if(ms)ms.value=q.mode==='guaranteed'?'guaranteed':'standard';
  updateEstimate();
  render(r.stats,r.prospects,'restored',r);
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

// The per-row "Follow up" control: presets, a custom date, and a clear. The table sits
// in a horizontal scroll box (.cotwrap), which would clip a popup laid out inside the
// row, so the panel is position:fixed and placed against its button by posFu() on open.
function followMenu(id) {
  const opt = (when, label) =>
    `<button type="button" class="fu-opt" onclick="setFollowUp(${id},'${when}')">${label}</button>`;
  return `<details class="fumenu" ontoggle="posFu(this)">
    <summary title="Set a follow-up and come back to this later">${icon("clock", 13)}<span>Follow up</span></summary>
    <div class="fumenu-pop">
      ${opt("3d", "In 3 days")}${opt("1w", "In 1 week")}${opt("2w", "In 2 weeks")}${opt("1m", "In 1 month")}
      <label class="fu-custom">Pick a date<input type="date" onchange="setFollowUp(${id},this.value)"></label>
      <button type="button" class="fu-opt fu-clear" onclick="setFollowUp(${id},'')">Clear, back to working</button>
    </div>
  </details>`;
}

// The compact license tag for the name cell, the same shape the Search table uses: a
// badge only when the business actually advertises one. The full signal (including the
// "nothing found" case) and the official-search link live in the row's notes panel.
function licenseTagHtml(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  const sig = detectLicenseSignal(lj);
  if (sig.status !== "mentioned") return "";
  const label = esc(sig.evidence || "licensed/registered");
  return `<span class="lic-badge lic-yes" title="Advertises: ${label}. Confirm it with Verify in the notes panel.">${icon("badge", 12)}${label}</span>`;
}

const dashCell = () => '<span class="c-mut">--</span>';
const mutedCell = (v) => (v ? `<span class="c-mut">${esc(String(v))}</span>` : dashCell());

// A phone number is something you dial, so it is a tel: link on every page that shows one.
// The href is the bare digits (a leading + survives, since that is what makes an
// international number dial); the number you read stays exactly as it was scraped.
function telHref(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const plus = s.startsWith("+");
  const digits = s.replace(/[^0-9]/g, "");
  return digits ? (plus ? "+" : "") + digits : "";
}
function phoneCell(v) {
  const href = telHref(v);
  if (!href) return mutedCell(v);
  return `<a class="c-tel" href="tel:${esc(href)}">${esc(String(v))}</a>`;
}

// The listing this company was found on, as a small link in its name's tag line: the Maps
// place, the Facebook page, the Instagram profile. Nothing at all when the source gave us
// no URL, rather than a link that goes nowhere.
function listingLinkHtml(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  const url = listingUrlFor({ source: l.source, external_id: l.external_id, ...lj });
  if (!url) return "";
  const name = srcLabel(l.source);
  return `<a class="c-src" href="${esc(url)}" target="_blank" rel="noopener" title="Open this ${esc(name)} listing">${esc(name)}${icon("external", 11)}</a>`;
}

const CRM_COLS = 7;

// One lead: the table row, plus the notes row that expands underneath it. Notes, the
// contact details and the license signal don't fit a 52px row, so they live in that
// expansion instead of being dropped. Both lists render identical rows so a row can
// move between them without the columns shifting; only the follow-up cell changes.
// The amount already recorded against a Won company, sitting under its stage picker: the
// figure itself when there is one, a quiet "add amount" when the win was logged without
// one (the Skip case, or an amount not known yet). Either way it reopens the same editor.
// Rendered on every row and shown only on the Won ones, so a stage change can reveal it
// without the page having to build anything.
function winChipHtml(id, win, stage) {
  const raw = win ? win.amount : null;
  const amt = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  const known = amt !== null && Number.isFinite(amt);
  return `<button type="button" class="winchip${known ? "" : " addamt"}" id="wc-${id}" title="${
    known ? "What this deal was worth. Click to change it." : "Add what this deal was worth"
  }" onclick="openWin(${id})"${stage === "Won" ? "" : " hidden"}>${known ? esc(fmtMoney(amt)) : "add amount"}</button>`;
}

// The win prompt, as a row that expands under the company's own row: the same shape the
// notes editor uses, so marking a company Won asks for the amount in place and the table
// never jumps. It rides along hidden on every row and opens when the stage turns Won.
function winRowHtml(l, win) {
  const raw = win ? win.amount : null;
  const amt = raw === null || raw === undefined || raw === "" ? "" : String(Number(raw));
  const note = win && win.note ? String(win.note) : "";
  return `<tr class="winrow" id="winrow-${l.id}" hidden><td class="wincell" colspan="${CRM_COLS}">
    <div class="winpanel">
      <div class="wintitle">${icon("wins", 15)}<span>Nice one. <b>${esc(l.name)}</b> is a win.</span></div>
      <div class="winfields">
        <label class="wf"><span class="wcap">Amount <span class="wopt">optional</span></span>
          <span class="winput"><span class="wcur">$</span><input id="wa-${l.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="2400" value="${esc(amt)}" onkeydown="winKey(event,${l.id})"></span></label>
        <label class="wf wf-note"><span class="wcap">Note <span class="wopt">optional</span></span>
          <input id="wn-${l.id}" type="text" autocomplete="off" placeholder="What closed it" value="${esc(note)}" onkeydown="winKey(event,${l.id})"></label>
        <div class="wact"><button type="button" class="winsave" onclick="saveWin(${l.id})">Save</button><button type="button" class="winskip" onclick="skipWin(${l.id})">Skip</button></div>
      </div>
      <div class="winhint" id="wh-${l.id}">Skip and it still counts as a win. Add the amount from this row whenever you know it.</div>
    </div>
  </td></tr>`;
}

function renderCrmRow(l, winByLead) {
  const win = (winByLead && winByLead.get(String(l.id))) || null;
  const opts = CRM_STAGES.map(
    (s) => `<option value="${s}"${l.crm_stage === s ? " selected" : ""}>${s}</option>`
  ).join("");
  const bucket = CRM_BUCKETS.includes(l.bucket) ? l.bucket : "qualified";
  const fu = followUpInfo(l.follow_up_at);
  const contacted = daysAgo(l.contacted_on);
  const fuCell = fu.label
    ? `<span class="fudate ${fu.cls}">${icon("clock", 13)}${esc(fu.label)}</span>`
    : '<span class="c-mut">not scheduled</span>';
  const moveOpts = CRM_BUCKETS.filter((b) => b !== bucket)
    .map((b) => `<option value="${b}">${esc(BUCKET_META[b].title)}</option>`)
    .join("");
  const place = [l.city, l.state].filter(Boolean).join(", ");
  const notes = l.notes || "";
  const stage = l.crm_stage || "";
  const tag = bucket === "has_website" ? "" : '<span class="badge">no website</span>';
  const lic = licenseTagHtml(l);
  const listing = listingLinkHtml(l);
  const tags = tag || lic || listing ? `<span class="c-tags">${tag}${lic}${listing}</span>` : "";
  // What the toolbar filter matches on. Stage and notes are in here too, so the page
  // script rewrites data-k whenever either of them changes.
  const base = [l.name, l.category, l.city, l.state, l.phone, l.email].filter(Boolean).join(" ").toLowerCase();
  const meta = [
    l.category ? esc(l.category) : "",
    `from ${esc(srcLabel(l.source))}`,
    l.email ? `<span class="c-em">${esc(l.email)}</span>` : '<span class="warn">no email</span>',
    contacted ? `contacted ${esc(contacted)}` : "",
  ]
    .filter(Boolean)
    .join(' <span class="ndot">·</span> ');
  return `<tr class="crmrow" id="crm-${l.id}" data-bucket="${bucket}" data-fu="${fu.ts || 0}" data-base="${esc(base)}" data-stage="${esc(stage)}" data-notes="${esc(notes)}" data-k="${esc(`${base} ${stage} ${notes}`.toLowerCase())}">
    <td class="c-name"><span class="c-nm">${esc(l.name)}</span>${tags}</td>
    <td>${mutedCell(place)}</td>
    <td>${phoneCell(l.phone)}</td>
    <td class="c-stage"><select class="stage" title="Where this company stands" onchange="setStage(${l.id},this.value)">${opts}</select>${winChipHtml(l.id, win, stage)}</td>
    <td class="fucell">${fuCell}</td>
    <td class="c-note"><button type="button" class="notebtn${notes ? " on" : ""}" id="nb-${l.id}" aria-expanded="false" aria-controls="note-${l.id}" title="${notes ? "Notes on this company" : "Add notes"}" onclick="toggleNote(${l.id})">${icon("note", 14)}</button></td>
    <td class="c-act"><div class="actwrap">${followMenu(l.id)}<select class="movebucket" title="Move this company to another list" onchange="moveBucket(${l.id},this.value,this)"><option value="">Move to</option>${moveOpts}</select><button class="rm" onclick="removeCrm(${l.id})">Remove</button></div></td>
  </tr>
  <tr class="noterow" id="note-${l.id}" hidden><td class="notecell" colspan="${CRM_COLS}">
    <div class="notepanel">
      <div class="nmeta">${meta} <span class="ndot">·</span> ${licenseBadgeHtml(l)}</div>
      <textarea class="notes" id="nt-${l.id}" rows="2" placeholder="What happened on this one" onchange="saveNote(${l.id})">${esc(notes)}</textarea>
      <div class="nact"><button type="button" class="nsave" onclick="saveNote(${l.id})">Save notes</button><span class="nok" id="nok-${l.id}"></span></div>
    </div>
  </td></tr>
  ${winRowHtml(l, win)}`;
}

// One list as a table, in the same wrapper and with the same header the Search page uses.
// Two tail rows ride along: the empty-state line, and the no-match line the filter shows.
function crmTable(bucket, list, rows, winByLead) {
  const empty =
    list === "working" ? "Nothing in the working list." : "No follow-ups scheduled in this list.";
  return `<div class="cotwrap"><table class="cotable">
    <thead><tr><th>Company name</th><th>City, state</th><th>Phone</th><th>Stage</th><th>Follow up</th><th>Notes</th><th class="c-act"></th></tr></thead>
    <tbody id="tb-${bucket}-${list}">${rows.map((l) => renderCrmRow(l, winByLead)).join("")}<tr class="emptyrow"${
      rows.length ? ' style="display:none"' : ""
    }><td colspan="${CRM_COLS}">${empty}</td></tr><tr class="norow gone"><td colspan="${CRM_COLS}" class="co-empty">No companies here match that search.</td></tr></tbody>
  </table></div>`;
}

function sumText(working, followups) {
  return `${working} working, ${followups} follow-up${followups === 1 ? "" : "s"}`;
}

// How many of a bucket's follow-ups have come due: anything dated today or earlier.
// This is the number the segmented toggle puts in a warn-coloured chip, and the reason a
// bucket opens on its follow-ups instead of its working list.
function dueCount(followups) {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  let n = 0;
  for (const l of followups) {
    const ts = parseStamp(l.follow_up_at);
    if (ts != null && ts <= endOfToday.getTime()) n++;
  }
  return n;
}

// Which list a bucket opens on. Working is the everyday case, but a follow-up that has
// come due is the whole reason to be on this page, so a bucket holding one opens there.
function defaultSeg(data) {
  return dueCount(data.followups || []) ? "followups" : "working";
}

// ── The segmented toggle ──
// One bucket holds two lists, and only one of them is on screen. This is the switch: a
// small pill-shaped pair sitting on the filter toolbar, deliberately quieter than the
// underlined bucket tabs above it so the hierarchy reads bucket first, list second.
// The follow-ups half carries a warn-coloured "N due" chip whenever anything has come due.
function segBar(key, workingN, followupsN, due, seg) {
  const one = (list, label, n, extra) =>
    `<button type="button" class="lseg${seg === list ? " on" : ""}" id="sg-${key}-${list}" role="tab" aria-selected="${
      seg === list ? "true" : "false"
    }" aria-controls="list-${key}-${list}" onclick="pickSeg('${key}','${list}')">${label}<span class="sg-n" id="sgn-${key}-${list}">(${n})</span>${extra}</button>`;
  const chip = `<span class="sg-due" id="sgd-${key}"${due ? "" : " hidden"}>${due} due</span>`;
  return `<div class="lsegs" id="seg-${key}" role="tablist" aria-label="Working list or follow-ups">${one(
    "working",
    "Working",
    workingN,
    ""
  )}${one("followups", "Follow-ups", followupsN, chip)}</div>`;
}

// One bucket's whole content: the toggle and filter toolbar, then whichever of the two
// lists is selected, full width. Both tables stay in the page (the hidden one included),
// so a row can move between lists or buckets without a reload and the counts still add up.
function bucketPane(key, data, active, winByLead) {
  const working = data.working || [];
  const followups = data.followups || [];
  const all = working.length + followups.length;
  const seg = defaultSeg(data);
  const pane = (list, body) =>
    `<div class="lwrap" id="list-${key}-${list}" role="tabpanel" aria-labelledby="sg-${key}-${list}"${
      seg === list ? "" : " hidden"
    }>${body}</div>`;
  return `<div class="lpane" id="pane-${key}" role="tabpanel" aria-labelledby="bt-${key}"${active ? "" : " hidden"}>
  <div id="body-${key}"${all ? "" : " hidden"}>
    <div class="cotools">
      ${segBar(key, working.length, followups.length, dueCount(followups), seg)}
      <div class="cofind"><span class="cf-i">${icon("search", 14)}</span><input id="find-${key}" type="text" autocomplete="off" placeholder="Search these companies" oninput="filterRows('${key}')"></div>
      <div class="cosum" id="sum-${key}">${sumText(working.length, followups.length)}</div>
    </div>
    ${pane("working", crmTable(key, "working", working, winByLead))}
    ${pane(
      "followups",
      `<div class="lnote">Soonest first, so anything due sits at the top.</div>${crmTable(key, "followups", followups, winByLead)}`
    )}
  </div>
  <div class="co-empty" id="none-${key}"${all ? " hidden" : ""}>Nothing in this list yet. Move companies over from a search.</div>
</div>`;
}

// The bucket tab bar, same idiom as the Search page's: live counts, a dark underline on
// the selected one, faint when a bucket is empty.
function bucketTabs(crm, active) {
  return `<div class="btabs" role="tablist">${CRM_BUCKETS.map((k) => {
    const meta = BUCKET_META[k];
    const n = crm[k].working.length + crm[k].followups.length;
    return `<button type="button" class="btab${k === active ? " on" : ""}${n ? "" : " zero"}" id="bt-${k}" role="tab" aria-selected="${
      k === active ? "true" : "false"
    }" aria-controls="pane-${k}" title="${esc(meta.sub)}" onclick="pickTab('${k}')">${esc(meta.title)}<span class="bt-n">${n}</span><span class="bt-u"></span></button>`;
  }).join("")}</div>`;
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
  const [crmRaw, reminders, wins] = await Promise.all([
    store.listCrm(req.userId),
    store.listFollowups(req.userId),
    // Same deploy-order safety net getProfile() carries: if the linked-win migration has
    // not reached this project yet, the Companies page renders without the amounts rather
    // than 500ing. The Wins page still fails loudly, which is where that belongs.
    store.listWins(req.userId).catch(() => []),
  ]);
  const crm = normalizeCrm(crmRaw);
  // A win belongs to the company it came from, so every Won row can show its own amount
  // (and reopen its own editor) without a second request. Hand-typed wins carry no lead
  // and simply aren't in here.
  const winByLead = new Map(
    (wins || []).filter((w) => w.leadId !== null && w.leadId !== undefined).map((w) => [String(w.leadId), w])
  );

  let total = 0;
  let scheduled = 0;
  let dueNow = 0;
  // Which list each bucket opens on. Working by default; a bucket with a follow-up that
  // has come due opens on its follow-ups instead, and the page script keeps this object
  // up to date as the user flips segments during the visit.
  const segs = {};
  for (const b of CRM_BUCKETS) {
    total += crm[b].working.length + crm[b].followups.length;
    scheduled += crm[b].followups.length;
    dueNow += dueCount(crm[b].followups);
    segs[b] = defaultSeg(crm[b]);
  }
  const openReminders = reminders.filter((f) => !f.done).length;
  // The header carries the total, so this line covers only what's scheduled.
  const stats = total
    ? `<b>${scheduled}</b> scheduled follow-up${scheduled === 1 ? "" : "s"}${
        dueNow ? ` &nbsp;·&nbsp; <b class="duenow">${dueNow} due now</b>` : ""
      }`
    : "Nothing here yet. Run a search and move the results over.";

  // Open on the first bucket that actually has something in it.
  const activeTab =
    CRM_BUCKETS.find((b) => crm[b].working.length + crm[b].followups.length) || CRM_BUCKETS[0];
  const tabs = bucketTabs(crm, activeTab);
  const panes = CRM_BUCKETS.map((b) => bucketPane(b, crm[b], b === activeTab, winByLead)).join("");

  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector · Companies</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1200px;margin:auto}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .duenow{color:var(--warn)}
  .empty{color:var(--muted);font-size:15px}
  .warn{color:var(--warn)}
  .lic-badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .lic-verify{font-size:12px;text-decoration:none;margin-left:6px}

  /* ── Leads: the same panel, tabs, toolbar and table the Search page uses ── */
${TABLE_CSS}
  .leadline{font-size:14px;color:var(--muted);margin:8px 0 0}
  .leadline b{color:var(--text)}
  /* The toolbar's right-hand side is a read-out here, not a button. */
  .cosum{margin-left:auto;font-size:13px;color:var(--muted);white-space:nowrap}
  /* ── The segmented toggle: which of the bucket's two lists is on screen ──
     Pill-shaped and a size down from the underlined bucket tabs above it, so the two
     levels never read as the same control. The selected half is lifted out of the track
     rather than underlined, which is the other half of keeping them apart. */
  .lsegs{display:inline-flex;align-items:center;gap:2px;flex:none;background:var(--surface2);border:1px solid var(--border);border-radius:999px;padding:3px}
  .lseg{display:inline-flex;align-items:center;gap:6px;font-family:inherit;background:transparent;border:0;border-radius:999px;padding:6px 13px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap}
  .lseg:hover{color:var(--text)}
  .lseg.on{background:var(--surface);color:var(--text);box-shadow:inset 0 0 0 1px var(--border-strong)}
  .lseg .sg-n{font-size:12px;font-weight:600;color:var(--faint)}
  .lseg.on .sg-n{color:var(--muted)}
  /* The due chip. Warn colours, so a follow-up that has come due pulls the eye even
     while the working list is the one showing. */
  .lseg .sg-due{background:var(--warn-weak);color:var(--warn);border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:700;letter-spacing:.1px}
  .lseg .sg-due[hidden]{display:none}
  /* The one-line note above the follow-ups table. */
  .lnote{margin:14px 0 0;font-size:12.5px;color:var(--faint)}
  .lnote+.cotwrap{margin-top:9px}
  /* Wider than the Search table: these rows carry three live controls, and the action
     column is budgeted for all three of them side by side. */
  table.cotable{min-width:1040px}
  table.cotable th:nth-child(1),table.cotable td:nth-child(1){width:22%}
  table.cotable th:nth-child(2),table.cotable td:nth-child(2){width:10%}
  table.cotable th:nth-child(3),table.cotable td:nth-child(3){width:11%}
  table.cotable th:nth-child(4),table.cotable td:nth-child(4){width:10%}
  table.cotable th:nth-child(5),table.cotable td:nth-child(5){width:12%;white-space:nowrap}
  table.cotable th:nth-child(6),table.cotable td:nth-child(6){width:5%}
  table.cotable th:nth-child(7),table.cotable td:nth-child(7){width:30%}
  .cotable tr.emptyrow td,.cotable tr.norow td{height:auto;padding:16px 0;color:var(--muted);font-size:13px;border-bottom:0}
  .cotable tbody tr.emptyrow:hover{background:transparent}
  .cotable tbody tr.justmoved{animation:pop 1.2s ease-out}
  @keyframes pop{0%{background:var(--accent-weak)}100%{background:transparent}}
  /* ── Row controls, sized to sit inside a 52px row ── */
  select.stage{width:100%;height:34px;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:4px 7px;color:var(--text);font-size:13px;font-family:inherit}
  select.movebucket{height:34px;max-width:112px;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:4px 7px;color:var(--muted);font-size:12.5px;font-family:inherit}
  .actwrap{display:flex;align-items:center;justify-content:flex-end;gap:7px}
  .rm{height:34px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:0 11px;cursor:pointer;font-size:12.5px;font-family:inherit}
  .rm:hover{color:var(--danger);border-color:var(--danger)}
  /* ── Notes: a button in the row, the editor in a full-width row underneath ── */
  .cotable td.c-note{padding-right:8px}
  .notebtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--faint);cursor:pointer;font-family:inherit}
  .notebtn:hover{color:var(--text);border-color:var(--border-strong)}
  .notebtn.on{background:var(--accent-weak);border-color:transparent;color:var(--accent-ink)}
  /* A filled button plus a dot: at a glance, this company already has notes on it. */
  .notebtn.on::after{content:"";position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--accent);border:1.5px solid var(--panel)}
  .crmrow.noteon .notebtn{color:var(--text);border-color:var(--border-strong)}
  .cotable td.notecell{height:auto;padding:0 0 14px}
  .cotable tbody tr.noterow:hover{background:transparent}
  .notepanel{display:flex;flex-direction:column;gap:9px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .nmeta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12.5px;color:var(--muted)}
  .nmeta .ndot{color:var(--faint)}
  textarea.notes{width:100%;min-height:58px;resize:vertical;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:9px 11px;color:var(--text);font-size:13.5px;font-family:inherit;line-height:1.45}
  .nact{display:flex;align-items:center;gap:10px}
  .nsave{font-family:inherit;background:var(--accent);color:var(--on-accent);border:none;border-radius:8px;padding:7px 15px;font-size:13px;font-weight:700;cursor:pointer}
  .nok{font-size:12.5px;font-weight:600;color:var(--accent-ink)}
  /* ── The win prompt ──
     Marking a company Won is how a win gets logged, so the amount is asked for right
     there in the row. Same expanding-row idiom as the notes editor above, for the same
     reason: the table must not jump under the pointer that just changed the stage. */
  .cotable td.wincell{height:auto;padding:0 0 14px}
  .cotable tbody tr.winrow:hover{background:transparent}
  .winpanel{display:flex;flex-direction:column;gap:10px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .wintitle{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--muted)}
  .wintitle svg{color:var(--accent);flex:none}
  .wintitle b{color:var(--text)}
  /* The table this sits in is 1040px wide and scrolls sideways, so the controls are
     capped and packed left: Save and Skip must never end up off the visible edge. */
  .winfields{display:flex;align-items:flex-end;flex-wrap:wrap;gap:10px;max-width:660px}
  .wf{display:flex;flex-direction:column;gap:5px}
  .wcap{font-size:12px;font-weight:600;color:var(--muted)}
  .wopt{font-weight:400;color:var(--faint)}
  .wf-note{flex:0 1 250px;min-width:150px}
  /* The amount reads as money before anything is typed in it, so the currency mark is
     part of the field rather than something the user has to type. */
  .winput{display:flex;align-items:center;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:0 11px}
  .winput:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
  .winput .wcur{font-size:13.5px;color:var(--faint)}
  .winput input{width:104px;background:transparent;border:0;padding:9px 4px;color:var(--text);font-size:13.5px;font-family:inherit;font-variant-numeric:tabular-nums}
  .winput input:focus{outline:none;box-shadow:none;border-color:transparent}
  .wf-note input{width:100%;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;padding:9px 11px;color:var(--text);font-size:13.5px;font-family:inherit}
  .wact{display:flex;align-items:center;gap:8px}
  .winsave{font-family:inherit;background:var(--accent);color:var(--on-accent);border:none;border-radius:8px;padding:9px 17px;font-size:13px;font-weight:700;cursor:pointer}
  .winsave:hover{filter:brightness(.96)}
  .winskip{font-family:inherit;background:transparent;border:1px solid var(--border-strong);color:var(--muted);border-radius:8px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer}
  .winskip:hover{color:var(--text)}
  .winhint{font-size:12px;color:var(--faint);line-height:1.5}
  .winhint.bad{color:var(--danger)}
  /* The amount a Won row carries, under its stage picker. Quiet and outlined while the
     figure is still missing, filled once there is one. */
  .winchip{display:inline-flex;align-items:center;max-width:100%;margin-top:6px;font-family:inherit;background:var(--accent-weak);border:1px solid transparent;color:var(--accent-ink);border-radius:7px;padding:2px 8px;font-size:11.5px;font-weight:700;cursor:pointer;font-variant-numeric:tabular-nums;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .winchip.addamt{background:transparent;border-color:var(--border-strong);color:var(--muted);font-weight:600}
  .winchip.addamt:hover{color:var(--text);border-color:var(--accent)}
  .winchip[hidden]{display:none}
  /* ── Follow-up control ── */
  .fudate{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;white-space:nowrap;color:var(--muted)}
  .fudate.soon{color:var(--warn)}.fudate.od{color:var(--danger)}
  .fumenu{position:relative;flex:none}
  .fumenu>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 11px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-weight:600;color:var(--muted);white-space:nowrap}
  .fumenu>summary::-webkit-details-marker{display:none}
  .fumenu>summary:hover{color:var(--text);border-color:var(--border-strong)}
  .fumenu[open]>summary{color:var(--text);border-color:var(--border-strong)}
  .fumenu-pop{position:fixed;z-index:60;width:210px;display:flex;flex-direction:column;gap:2px;background:var(--panel);border:1px solid var(--border-strong);border-radius:10px;padding:6px;box-shadow:0 12px 28px rgba(0,0,0,.22)}
  .fu-opt{font-family:inherit;text-align:left;background:transparent;border:none;border-radius:6px;padding:8px 10px;font-size:13px;color:var(--text);cursor:pointer}
  .fu-opt:hover{background:var(--surface2)}
  .fu-clear{color:var(--muted);border-top:1px solid var(--border);border-radius:0 0 6px 6px;margin-top:2px}
  .fu-custom{display:flex;flex-direction:column;gap:5px;padding:6px 10px 8px;font-size:12px;color:var(--muted)}
  .fu-custom input{font-size:13px;border-radius:6px;padding:6px 8px}
  /* ── Your reminders panel ── */
  .fubox{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 20px 20px;margin-top:16px}
  .fubox .cohead{margin-bottom:14px}
  .fu-add{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1.6fr) auto auto;gap:10px}
  .fu-add input{background:var(--surface);border:1px solid var(--border-strong);border-radius:9px;padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit}
  .fu-add button{background:var(--accent);color:var(--on-accent);border:none;border-radius:9px;padding:9px 18px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit}
  .fu-list{display:flex;flex-direction:column;gap:8px;margin-top:14px}
  .fubox .fu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:11px 14px}
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
${sidebar("leads", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Companies</h1><div class="pagesub">The businesses you're working, and when to call them back</div></div><div class="spacer"></div></div>

<section class="copanel" id="followups">
  <div class="cohead"><span class="co-ic">${icon("companies")}</span>
    <span class="co-ttl">Companies</span>
    <span class="co-n" id="leadTotal">${total.toLocaleString()} compan${total === 1 ? "y" : "ies"}</span></div>
  <div class="leadline">${stats}</div>
  ${tabs}
  ${panes}
</section>

<section class="fubox">
  <div class="cohead"><span class="co-ic">${icon("calendar")}</span>
    <span class="co-ttl">Your reminders</span>
    <span class="co-n">${openReminders} open</span></div>
  <div class="fu-add">
    <input id="fuTitle" placeholder="Who or which business (e.g. Joe's Roofing)">
    <input id="fuNote" placeholder="Note, optional (e.g. called, wants a quote)">
    <input id="fuDue" type="date" title="Follow up on">
    <button onclick="addFu()">Add reminder</button>
  </div>
  <div class="fu-list" id="fuList">${
    reminders.length
      ? reminders.map(renderFollowupItem).join("")
      : '<div class="empty" style="margin:6px 0;font-size:13px">No reminders of your own yet. Add one above.</div>'
  }</div>
</section>
<script>
${iconScript(["clock", "check", "warn"], 13)}
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
async function post(url,data){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
var BUCKET_KEYS=${JSON.stringify(CRM_BUCKETS)};
var BUCKETS=${JSON.stringify(BUCKET_META)};
var TAB=${JSON.stringify(activeTab)};
// Which list each bucket is showing. Seeded server-side (working, unless that bucket has
// a follow-up that has come due) and then kept per bucket for the rest of the visit, so
// leaving a bucket and coming back lands on the list you left it on.
var SEG=${JSON.stringify(segs)};

// ── bucket tabs ──
// Every bucket's tables stay in the page, hidden, so a row can be sent to another
// bucket's list without a reload and every count still adds up.
function pickTab(key){
  TAB=key;
  BUCKET_KEYS.forEach(function(b){
    var p=document.getElementById('pane-'+b);
    if(p)p.hidden=b!==key;
    var t=document.getElementById('bt-'+b);
    if(t){t.classList.toggle('on',b===key);t.setAttribute('aria-selected',b===key?'true':'false')}
  });
  closeMenus();
  filterRows(key);
}

// ── the segmented toggle ──
// Flip one bucket between its working list and its follow-ups. Both tables stay in the
// page either way, so this is only a matter of which one is hidden.
function pickSeg(key,list){
  SEG[key]=list;
  ['working','followups'].forEach(function(l){
    var w=document.getElementById('list-'+key+'-'+l);
    if(w)w.hidden=l!==list;
    var b=document.getElementById('sg-'+key+'-'+l);
    if(b){b.classList.toggle('on',l===list);b.setAttribute('aria-selected',l===list?'true':'false')}
  });
  closeMenus();
  filterRows(key);
}

// ── stage / notes / remove ──
// The stage IS the win: the server logs one the moment a company turns Won and takes it
// away again the moment it leaves, both inside this one call, so the row can never show a
// stage and a win that disagree. All this has to do is open the prompt for the amount.
async function setStage(id,stage){
  var r=await post('/api/crm/update/'+id,{stage:stage});
  var row=document.getElementById('crm-'+id);
  if(row){row.setAttribute('data-stage',stage);refreshKey(row)}
  if(!r||!r.ok)return;
  paintWin(id,r.win,stage);
  if(stage==='Won'&&r.win)openWin(id);else closeWin(id);
}

// ── the win on a row ──
function fmtMoney(n){var v=Number(n)||0,c=v%1?2:0;return '$'+v.toLocaleString('en-US',{minimumFractionDigits:c,maximumFractionDigits:c})}
function winRowOf(row){return document.getElementById('winrow-'+leadId(row))}
// The chip under the stage picker, plus the editor's fields, from one win object.
function paintWin(id,win,stage){
  var amt=win&&win.amount!==null&&win.amount!==undefined&&win.amount!==''?Number(win.amount):null;
  if(amt!==null&&!isFinite(amt))amt=null;
  var chip=document.getElementById('wc-'+id);
  if(chip){
    chip.hidden=stage!=='Won';
    chip.textContent=amt===null?'add amount':fmtMoney(amt);
    chip.classList.toggle('addamt',amt===null);
    chip.title=amt===null?'Add what this deal was worth':'What this deal was worth. Click to change it.';
  }
  var a=document.getElementById('wa-'+id);
  if(a)a.value=amt===null?'':String(amt);
  var n=document.getElementById('wn-'+id);
  if(n)n.value=win&&win.note?win.note:'';
  var h=document.getElementById('wh-'+id);
  if(h){h.classList.remove('bad');h.textContent='Skip and it still counts as a win. Add the amount from this row whenever you know it.'}
}
// Open the prompt and put the caret in the amount, so the one thing being asked for can
// be typed without a second click.
function openWin(id){
  var row=document.getElementById('crm-'+id);
  if(!row)return;
  row.classList.add('winopen');
  syncSubRows(row);
  var a=document.getElementById('wa-'+id);
  if(a){a.focus();try{a.setSelectionRange(a.value.length,a.value.length)}catch(e){}}
}
function closeWin(id){
  var row=document.getElementById('crm-'+id);
  if(!row)return;
  row.classList.remove('winopen');
  syncSubRows(row);
}
async function saveWin(id){
  var a=document.getElementById('wa-'+id),n=document.getElementById('wn-'+id),h=document.getElementById('wh-'+id);
  var r=await post('/api/leads/'+id+'/win',{amount:a?a.value:'',note:n?n.value:''});
  if(!r||!r.ok){if(h){h.classList.add('bad');h.textContent=(r&&r.error)||'Could not save that.'}return}
  paintWin(id,r.win,'Won');
  closeWin(id);
}
// Skip closes the prompt and nothing else: the win was already recorded when the stage
// turned Won, so the count stays right even when the revenue is unknown.
function skipWin(id){closeWin(id)}
function winKey(e,id){
  if(e.key==='Enter'){e.preventDefault();saveWin(id)}
  else if(e.key==='Escape'){e.preventDefault();closeWin(id)}
}
async function setNotes(id,notes){await post('/api/crm/update/'+id,{notes:notes})}
// The filter matches on data-k, which carries the stage and the notes, so it is rebuilt
// whenever either of those changes.
function refreshKey(row){
  row.setAttribute('data-k',[row.getAttribute('data-base')||'',row.getAttribute('data-stage')||'',row.getAttribute('data-notes')||''].join(' ').toLowerCase());
}
function leadId(row){return String(row.id||'').slice(4)}
function noteRow(row){return document.getElementById('note-'+leadId(row))}
// Notes live in a row that expands under the company's own row. Opening one is a single
// click from anywhere in either list, and the textarea takes focus straight away with the
// caret after whatever is already there, so a note can be typed without a second click.
function toggleNote(id){
  var row=document.getElementById('crm-'+id);
  if(!row)return;
  var on=!row.classList.contains('noteon');
  row.classList.toggle('noteon',on);
  var b=document.getElementById('nb-'+id);
  if(b)b.setAttribute('aria-expanded',on?'true':'false');
  syncSubRows(row);
  if(on){
    var t=document.getElementById('nt-'+id);
    if(t){t.focus();try{t.setSelectionRange(t.value.length,t.value.length)}catch(e){}}
  }
}
// The two rows that expand under a company (its notes, its win prompt) show only while
// that company is both expanded on that panel and past the filter.
function syncSubRows(row){
  var nr=noteRow(row);
  if(nr)nr.hidden=!(row.classList.contains('noteon')&&!row.classList.contains('gone'));
  var wr=winRowOf(row);
  if(wr)wr.hidden=!(row.classList.contains('winopen')&&!row.classList.contains('gone'));
}
async function saveNote(id){
  var t=document.getElementById('nt-'+id);
  if(!t)return;
  var v=t.value;
  await setNotes(id,v);
  var row=document.getElementById('crm-'+id);
  if(row){row.setAttribute('data-notes',v);refreshKey(row)}
  var b=document.getElementById('nb-'+id);
  if(b){b.classList.toggle('on',!!v.trim());b.title=v.trim()?'Notes on this company':'Add notes'}
  var ok=document.getElementById('nok-'+id);
  if(ok){ok.textContent='Saved';clearTimeout(ok._t);ok._t=setTimeout(function(){ok.textContent=''},1600)}
}
async function removeCrm(id){
  await post('/api/crm/remove/'+id,{});
  var row=document.getElementById('crm-'+id);
  if(row){var nr=noteRow(row);if(nr)nr.remove();var wr=winRowOf(row);if(wr)wr.remove();row.remove()}
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
    : '<span class="c-mut">not scheduled</span>';
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
  paintTag(row,bucket);
  moveRowTo(row,bucket,Number(row.getAttribute('data-fu'))>0?'followups':'working');
  rebuildMoveMenu(row,bucket,id);
  pickTab(bucket);
}
function rebuildMoveMenu(row,bucket,id){
  var sel=row.querySelector('.movebucket');
  if(!sel)return;
  var html='<option value="">Move to</option>';
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
  place(tb,row);
  if(list==='followups')sortFollowups(tb);
  paintCounts();
  row.classList.remove('justmoved');
  void row.offsetWidth;
  row.classList.add('justmoved');
}
// A lead row always travels with the rows that expand under it (its notes, its win
// prompt), and the two tail rows (empty state, no-match line) stay at the bottom.
function place(tb,row){
  tb.appendChild(row);
  var nr=noteRow(row);
  if(nr)tb.appendChild(nr);
  var wr=winRowOf(row);
  if(wr)tb.appendChild(wr);
  keepTail(tb);
}
function keepTail(tb){
  ['emptyrow','norow'].forEach(function(c){
    var r=tb.querySelector('tr.'+c);
    if(r)tb.appendChild(r);
  });
}
function dataRows(tb){
  return Array.prototype.filter.call(tb.children,function(r){return r.classList.contains('crmrow')});
}
function sortFollowups(tb){
  dataRows(tb).sort(function(a,b){return (Number(a.getAttribute('data-fu'))||0)-(Number(b.getAttribute('data-fu'))||0)})
    .forEach(function(r){tb.appendChild(r);var nr=noteRow(r);if(nr)tb.appendChild(nr);var wr=winRowOf(r);if(wr)tb.appendChild(wr)});
  keepTail(tb);
}
function sumText(w,f){return w+' working, '+f+' follow-up'+(f===1?'':'s')}
// How many of a bucket's follow-ups have come due, read straight off the rows' data-fu
// stamps so it stays right after a row is scheduled, cleared or moved. Mirrors the
// server's dueCount().
function dueOf(b){
  var tb=document.getElementById('tb-'+b+'-followups');
  if(!tb)return 0;
  var end=new Date();end.setHours(23,59,59,999);end=end.getTime();
  return dataRows(tb).filter(function(r){var t=Number(r.getAttribute('data-fu'))||0;return t>0&&t<=end}).length;
}
// Repaint every bucket's counts and empty states, then re-apply each one's filter.
function paintCounts(){
  var grand=0;
  BUCKET_KEYS.forEach(function(b){
    var n={working:0,followups:0};
    ['working','followups'].forEach(function(list){
      var tb=document.getElementById('tb-'+b+'-'+list);
      if(!tb)return;
      n[list]=dataRows(tb).length;
      var c=document.getElementById('sgn-'+b+'-'+list);
      if(c)c.textContent='('+n[list]+')';
    });
    var due=dueOf(b);
    var chip=document.getElementById('sgd-'+b);
    if(chip){chip.textContent=due+' due';chip.hidden=!due}
    var all=n.working+n.followups;
    grand+=all;
    var t=document.getElementById('bt-'+b);
    if(t){
      var bn=t.querySelector('.bt-n');
      if(bn)bn.textContent=all;
      t.classList.toggle('zero',!all);
    }
    var s=document.getElementById('sum-'+b);
    if(s)s.textContent=sumText(n.working,n.followups);
    var body=document.getElementById('body-'+b);
    if(body)body.hidden=!all;
    var none=document.getElementById('none-'+b);
    if(none)none.hidden=!!all;
    filterRows(b);
  });
  var tot=document.getElementById('leadTotal');
  if(tot)tot.textContent=grand.toLocaleString()+' compan'+(grand===1?'y':'ies');
}
// The "no website" tag is true of every bucket except "has a website", so it has to
// follow a row that is moved between them.
function paintTag(row,bucket){
  var cell=row.querySelector('.c-name');
  if(!cell)return;
  var tags=cell.querySelector('.c-tags');
  var badge=tags?tags.querySelector('.badge'):null;
  if(bucket==='has_website'){
    if(badge)badge.remove();
    if(tags&&!tags.children.length)tags.remove();
    return;
  }
  if(badge)return;
  if(!tags){tags=document.createElement('span');tags.className='c-tags';cell.appendChild(tags)}
  var b=document.createElement('span');
  b.className='badge';
  b.textContent='no website';
  tags.insertBefore(b,tags.firstChild);
}
// The tables sit in a horizontal scroll box, so the follow-up panel is fixed-positioned
// and placed against its button rather than flowing inside the row, where it would be
// clipped. It flips above the button when there isn't room below.
function posFu(d){
  if(!d.open)return;
  closeMenus(d);
  var pop=d.querySelector('.fumenu-pop'),s=d.querySelector('summary');
  if(!pop||!s)return;
  var r=s.getBoundingClientRect(),w=pop.offsetWidth||210,h=pop.offsetHeight||250;
  var left=Math.min(r.right-w,window.innerWidth-w-10);
  if(left<10)left=10;
  var top=r.bottom+6;
  if(top+h>window.innerHeight-8)top=Math.max(8,r.top-h-6);
  pop.style.left=left+'px';
  pop.style.top=top+'px';
}
function closeMenus(keep){
  document.querySelectorAll('details.fumenu[open]').forEach(function(d){if(d!==keep)d.open=false});
}
document.addEventListener('click',function(e){
  document.querySelectorAll('details.fumenu[open]').forEach(function(d){if(!d.contains(e.target))d.open=false});
});
// A fixed panel would drift away from its button, so scrolling closes it.
window.addEventListener('scroll',function(){closeMenus()},true);

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
// Live filter over one bucket, across both of its lists: a plain case-insensitive
// substring against the row's data-k (name, city, phone, stage, notes).
function filterRows(key){
  key=key||TAB;
  var box=document.getElementById('find-'+key);
  var q=box?box.value.trim().toLowerCase():'';
  ['working','followups'].forEach(function(list){
    var tb=document.getElementById('tb-'+key+'-'+list);
    if(!tb)return;
    var rows=dataRows(tb),shown=0;
    rows.forEach(function(r){
      var hit=!q||(r.getAttribute('data-k')||'').indexOf(q)>-1;
      r.classList.toggle('gone',!hit);
      syncSubRows(r);
      if(hit)shown++;
    });
    var blank=tb.querySelector('tr.emptyrow');
    if(blank)blank.style.display=rows.length?'none':'';
    var nom=tb.querySelector('tr.norow');
    if(nom)nom.classList.toggle('gone',!(q&&rows.length&&!shown));
  });
}
paintCounts();
// /crm?view=followup and /leads?view=followup both land here. Open the first bucket that
// actually has follow-ups and flip it to its follow-ups segment. The panel itself carries
// the #followups id, so the browser's own jump already puts the toggle and the table on
// screen and nothing else needs scrolling.
if(location.hash==='#followups'){
  var fuTab='';
  for(var fi=0;fi<BUCKET_KEYS.length;fi++){
    var fuTb=document.getElementById('tb-'+BUCKET_KEYS[fi]+'-followups');
    if(fuTb&&dataRows(fuTb).length){fuTab=BUCKET_KEYS[fi];break}
  }
  if(fuTab){
    pickTab(fuTab);
    pickSeg(fuTab,'followups');
  }
}
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

// ── WINS PAGE (the closed-deal trophy case) ──
// "$2,400": commas, and no cents unless the amount actually has them, in which case it
// gets both of them ("$750.50", never "$750.5").
function fmtMoney(n) {
  const v = Number(n) || 0;
  const cents = v % 1 ? 2 : 0;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: cents, maximumFractionDigits: cents });
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
// One row of the wins list. A win that came off a Won company links back to it and says
// so; a hand-typed one says that instead, so the two are never confusable.
function winRow(w) {
  const linked = w.leadId !== null && w.leadId !== undefined;
  // The list row keeps the store's column names alongside the camelCase ones, so read
  // either: the company's live name when the win is linked, the name typed on the win
  // itself when it is not.
  const typed = w.clientName ?? w.client_name;
  const name = String(w.name || typed || "").trim() || "This company";
  const place = [w.city, w.state].filter(Boolean).join(", ");
  const amt =
    w.amount === null || w.amount === undefined || w.amount === ""
      ? '<span class="c-mut">no amount</span>'
      : esc(fmtMoney(w.amount));
  const nameCell = linked
    ? `<a class="c-nm winlink" href="/leads" title="Open this company on the Companies page">${esc(name)}</a>`
    : `<span class="c-nm">${esc(name)}</span>`;
  const tag = linked
    ? `<span class="badge">from your companies</span>${place ? `<span class="c-mut">${esc(place)}</span>` : ""}`
    : '<span class="tag">added by hand</span>';
  return `<tr id="win-${w.id}">
    <td class="c-name">${nameCell}<span class="c-tags">${tag}</span></td>
    <td class="w-amt">${amt}</td>
    <td>${w.note ? esc(w.note) : '<span class="c-mut">no note</span>'}</td>
    <td class="w-date">${winDate(w.createdAt ?? w.created_at)}</td>
    <td class="c-act"><button class="rm" onclick="removeWin(${w.id})">Remove</button></td>
  </tr>`;
}

// One hero figure: a label, the number, and the line underneath that says what it counts.
function heroStat(label, value, sub) {
  return `<div class="wstat"><div class="wk">${esc(label)}</div><div class="wv">${esc(
    value
  )}</div><div class="ws">${sub}</div></div>`;
}

// "12.5x", "69x", "102x". One decimal until the number gets big enough that the decimal is
// noise, and never rounded up to a multiple the month did not actually earn. Only ever
// called with a real price and real revenue behind it, so no divide by zero to answer for.
function multipleLabel(revenue, price) {
  const r = Number(revenue) / Number(price);
  if (!Number.isFinite(r) || r <= 0) return "";
  return `${r >= 100 ? Math.round(r) : Math.round(r * 10) / 10}x`;
}

// ── The return line ──
// The most important thing on this page: what the month closed, against what the plan
// costs per month. There is no payments table in this app, so this is the ONLY billing
// claim that can be made honestly. It never totals what has been spent, never talks
// about a year, and says nothing at all about a ratio unless the current plan actually
// carries a monthly price and something has actually closed this month. A tier the
// operator does not sell (a legacy or hand-edited one) has no known price, so the plan
// is left out of the sentence entirely rather than guessed at.
function returnLine(monthTotal, tier) {
  const plan = PLANS[String(tier || "").toLowerCase()] || null;
  const price = plan ? Number(plan.price) || 0 : 0;
  const revenue = Number(monthTotal) || 0;
  const nudge = 'Mark a company Won on the <a href="/leads">Companies page</a> and the deal shows up here.';
  let main;
  let sub;
  if (revenue > 0 && price > 0) {
    main = `You closed <b>${esc(fmtMoney(revenue))}</b> this month. Your plan is <b>${esc(
      fmtMoney(price)
    )}</b> a month.`;
    sub = `That is <b>${esc(multipleLabel(revenue, price))}</b> what the plan costs.`;
  } else if (revenue > 0 && plan) {
    main = `You closed <b>${esc(fmtMoney(revenue))}</b> this month. Your ${esc(plan.label)} plan does not cost anything.`;
    sub = "There is no monthly price on this plan, so there is nothing to earn back.";
  } else if (revenue > 0) {
    main = `You closed <b>${esc(fmtMoney(revenue))}</b> this month.`;
    sub = "";
  } else if (price > 0) {
    main = `Your plan is <b>${esc(fmtMoney(price))}</b> a month. Nothing has closed yet this month.`;
    sub = nudge;
  } else {
    main = "Nothing has closed yet this month.";
    sub = nudge;
  }
  return `<section class="retline">
  <div class="ret-k">Your return this month</div>
  <div class="ret-main">${main}</div>
  ${sub ? `<div class="ret-sub">${sub}</div>` : ""}
</section>`;
}

async function renderWinsPage(req) {
  const [stats, rate, wins, profile] = await Promise.all([
    store.winStats(req.userId),
    store.winRate(req.userId),
    store.listWins(req.userId),
    store.getProfile(req.userId),
  ]);
  const count = Number(stats?.count) || 0;
  const total = Number(stats?.total) || 0;
  const monthCount = Number(stats?.monthCount) || 0;
  const monthTotal = Number(stats?.monthTotal) || 0;
  const valuedCount = Number(stats?.valuedCount) || 0;
  const avgValued = Number(stats?.avgValued) || 0;
  const won = Number(rate?.won) || 0;
  const decided = Number(rate?.decided) || 0;
  const ratePct = Number(rate?.ratePct) || 0;
  const inPlay = Number(rate?.inPlay) || 0;
  const rows = (wins || []).map(winRow).join("");

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const heroes = [
    heroStat("Closed this month", fmtMoney(monthTotal), plural(monthCount, "deal", "deals")),
    heroStat("Closed all time", fmtMoney(total), plural(count, "win", "wins")),
    heroStat(
      "Average deal size",
      valuedCount ? fmtMoney(avgValued) : "--",
      valuedCount
        ? `across ${plural(valuedCount, "win", "wins")} with an amount on it`
        : "no amounts recorded yet"
    ),
    heroStat(
      "Win rate",
      decided ? `${ratePct}%` : "--",
      decided
        ? `${won} of ${plural(decided, "decided deal", "decided deals")}<br>${plural(
            inPlay,
            "company",
            "companies"
          )} still in play`
        : `nothing decided yet<br>${plural(inPlay, "company", "companies")} still in play`
    ),
  ].join("");

  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}<title>Prospector · Wins</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
${TABLE_CSS}
  /* ── The hero row: the four numbers that answer "is this working" ── */
  .wstats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
  .wstat{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:15px 17px}
  .wk{font-size:12px;font-weight:600;color:var(--muted)}
  .wv{font-size:26px;font-weight:800;color:var(--text);margin-top:8px;line-height:1.15;font-variant-numeric:tabular-nums}
  .ws{font-size:12.5px;color:var(--faint);margin-top:6px;line-height:1.5}
  /* ── The return line: this month's closed revenue against what the plan costs ── */
  .retline{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:18px 20px;margin-bottom:18px}
  .ret-k{font-size:12px;font-weight:600;color:var(--muted)}
  .ret-main{font-size:19px;font-weight:700;color:var(--text);line-height:1.45;margin-top:8px;letter-spacing:-.1px}
  .ret-main b{color:var(--accent-ink)}
  .ret-sub{font-size:14px;color:var(--muted);margin-top:8px;line-height:1.5}
  .ret-sub b{color:var(--text);font-weight:700}
  /* ── The list, in the Companies page's table ── */
  table.cotable{min-width:720px}
  table.cotable th:nth-child(1),table.cotable td:nth-child(1){width:30%}
  table.cotable th:nth-child(2),table.cotable td:nth-child(2){width:14%}
  table.cotable th:nth-child(3),table.cotable td:nth-child(3){width:30%}
  table.cotable th:nth-child(4),table.cotable td:nth-child(4){width:14%}
  table.cotable th:nth-child(5),table.cotable td:nth-child(5){width:12%}
  .cotable td.w-amt{font-variant-numeric:tabular-nums;font-weight:700;color:var(--text);white-space:nowrap}
  .cotable td.w-date{color:var(--muted);white-space:nowrap}
  .cotable a.winlink{color:var(--text);text-decoration:none;border-bottom:1px solid transparent}
  .cotable a.winlink:hover{color:var(--accent-ink);border-bottom-color:var(--accent-ink)}
  .cotable .c-tags .badge,.cotable .c-tags .tag{font-size:10.5px;padding:2px 7px;border-radius:6px;font-weight:600}
  .cotable .c-tags .c-mut{font-size:11.5px}
  .rm{font-family:inherit;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12.5px}
  .rm:hover{color:var(--danger);border-color:var(--danger)}
  .winnote{margin-top:14px;font-size:12.5px;color:var(--faint);line-height:1.55}
  /* ── The escape hatch: a deal that never went through the tool ── */
  .addwin{margin-top:18px}
  .addwin .ex-body{padding-top:4px}
  .wrow{display:grid;grid-template-columns:1.4fr .7fr 1.6fr auto;gap:12px;align-items:end;margin-top:4px}
  .wrow .f{min-width:0}
  .wrow label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
  .wrow input{width:100%;border-radius:8px;padding:9px 12px;font-size:13.5px;font-family:inherit}
  .wrow .go{white-space:nowrap;border-radius:8px;padding:10px 20px;font-size:13.5px;font-weight:700;font-family:inherit;cursor:pointer}
  #winMsg{margin-top:10px;font-size:13px;color:var(--danger);min-height:16px}
  @media(max-width:900px){.wstats{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:640px){.wstats{grid-template-columns:1fr}.wrow{grid-template-columns:1fr}.wrow .go{width:100%}}
${SHARED_CSS}</style></head><body>
${sidebar("wins", { isAdmin: req.isAdmin, demo: req.isDemo })}<div class="pagehead"><div class="titlewrap"><h1>Wins</h1><div class="pagesub">Every deal you have closed, and what it came to</div></div><div class="spacer"></div></div>

<div class="wstats">${heroes}</div>

${returnLine(monthTotal, profile?.tier)}

<section class="copanel">
  <div class="cohead"><span class="co-ic">${icon("wins")}</span>
    <span class="co-ttl">Closed deals</span>
    <span class="co-n">${count.toLocaleString()} win${count === 1 ? "" : "s"}</span></div>
  ${
    count
      ? `<div class="cotwrap"><table class="cotable">
    <thead><tr><th>Company</th><th>Amount</th><th>Note</th><th>Date</th><th class="c-act"></th></tr></thead>
    <tbody id="winRows">${rows}</tbody>
  </table></div>
  <div class="winnote">Removing a win here does not change the company's stage. If it is still marked Won on the <a href="/leads">Companies page</a>, its row will offer to log the deal again.</div>`
      : `<div class="co-empty">Wins land here on their own: mark a company Won on the <a href="/leads">Companies page</a> and the deal shows up in this list. Anything you closed outside Prospector goes in by hand below.</div>`
  }
</section>

<details class="explain addwin">
  <summary><span class="ex-ttl">Add a deal from outside Prospector</span><span class="ex-sub">For work that never came through a search</span></summary>
  <div class="ex-body">
    <div class="wrow">
      <div class="f"><label for="wClient">Client or trade</label><input id="wClient" placeholder="Acme Roofing" autocomplete="off"></div>
      <div class="f"><label for="wAmount">Amount <span class="muted" style="font-weight:400">optional</span></label><input id="wAmount" type="number" min="0" step="any" placeholder="2400"></div>
      <div class="f"><label for="wNote">Note <span class="muted" style="font-weight:400">optional</span></label><input id="wNote" placeholder="What closed it" autocomplete="off"></div>
      <button class="go" onclick="addWin()">Add win</button>
    </div>
    <div id="winMsg"></div>
  </div>
</details>

<script>
async function post(url,data){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
// Every number on this page is the server's arithmetic over the whole list (the month,
// the average of the valued wins, the win rate against the stages). Recomputing that in
// the browser is how a scoreboard starts disagreeing with itself, so an add or a remove
// simply asks the server for the page again.
async function addWin(){
  var c=document.getElementById('wClient'),a=document.getElementById('wAmount'),n=document.getElementById('wNote'),msg=document.getElementById('winMsg');
  msg.textContent='';
  if(!c.value.trim()){msg.textContent='Add a client name.';c.focus();return}
  var r=await post('/api/wins',{clientName:c.value.trim(),amount:a.value.trim(),note:n.value.trim()});
  if(!r||!r.ok){msg.textContent=(r&&r.error)||'Could not add that win.';return}
  location.reload();
}
async function removeWin(id){
  var r=await post('/api/wins/remove/'+id,{});
  if(!r||!r.ok)return;
  location.reload();
}
</script>${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}
