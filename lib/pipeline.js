// pipeline.js — the shared engine used by BOTH the CLI and the search UI.
//
//   discover()     → search source(s) for a niche+city, keep only no-website in-niche leads,
//                    store them as this user's prospects, return them + stats. Also returns
//                    `alsoSeen`: in-niche businesses that did NOT qualify (they already have a
//                    website) so the search page can still show them as grab-later prospects.
//   discoverMany() → the same across a grid of niches × cities.
//   discoverGuaranteed() → keep scanning in rounds until 5 qualified companies are found
//                    (or a hard cap stops it), walking the city list as the expansion pool.
//
// Everything is per user: `userId` is threaded through to the store on every call, so two
// accounts never see each other's leads, cache, or brain. CLI callers default to "local"
// (single-user SQLite mode).

import { scrapeGoogleMaps, enrichGoogleActivity } from "../scrapers/maps.js";
import { searchFacebook } from "../scrapers/facebookSearch.js";
import { searchInstagram } from "../scrapers/instagram.js";
import { enrichFacebookActivity, facebookUrlFor } from "../scrapers/facebook.js";
import { qualifyLeads, hasRealWebsite, keepUsOnly } from "../scrapers/filter.js";
import { NICHES, isTargetNiche } from "./niches.js";
import { freshnessConfig, activityStatus, lastActiveLabel, activitySignal, passesFreshness } from "./freshness.js";
import { detectLicenseSignal, licenseSearchUrl } from "./license.js";
import { RATE_PER_1K } from "./spend.js";
import * as store from "../data/store.js";

// Deep-checking dates each candidate with an extra scraper pass, which is the slowest
// part of a scan — and it scales with how MANY leads we found. On a 300s serverless
// limit that means the best-yielding searches are the ones most likely to time out, so
// the pass is capped. Leads past the cap simply show as undated rather than blocking.
const DEEP_CHECK_MAX = Math.max(0, parseInt(process.env.DEEP_CHECK_MAX ?? "8", 10) || 0);

// ── "Also seen": scanned businesses that did NOT qualify, but stay browsable ──
// A scan pays to look at every business in the niche, so the ones we drop are still worth
// showing: a business that already has a website is a rebuild pitch to grab later. These
// never become lead rows until the user actually moves one into the CRM, so they ride along
// on the search response instead of being stored. Capped so a deep scan can't balloon the
// response (or the cached copy of it) without bound.
const ALSO_SEEN_MAX = 150;

// ── The scrapers, as one swappable set ──────────────────────────────────────
// discover() calls whichever set it is handed rather than reaching for the modules
// directly, so a caller can drive the pipeline with its own source functions (a narrower
// actor, a fixture set, a source we add later) without the pipeline knowing or caring.
// Each takes { category, city, state, limit } and returns normalized leads.
export const REAL_SCRAPERS = {
  google: (opts) => scrapeGoogleMaps({ ...opts, detail: "basic" }),
  facebook: (opts) => searchFacebook(opts),
  instagram: (opts) => searchInstagram(opts),
};
// The order sources are scanned in, so a scan reads the same way whichever set is in use.
const SOURCE_ORDER = ["google", "facebook", "instagram"];

// ── The listing this business was found on ──────────────────────────────────
// Each source hands back its own pointer at the business: Google a placeId, Facebook a
// page URL, Instagram a profile URL. This turns any of them into the one link that opens
// the business exactly where the scan found it. Returns "" when the source gave us none,
// which is the caller's cue to render a plain source name instead of a link.
const isHttpUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v.trim());

export function listingUrlFor(lead) {
  if (!lead) return "";
  // An also-seen business travels as a slim object that already carries the resolved link.
  if (isHttpUrl(lead.listingUrl)) return lead.listingUrl.trim();
  const src = String(lead.source || "");
  // Facebook's search rows fall back to the page URL as their id, and so does Instagram's.
  const ext = lead.externalId ?? lead.external_id;
  if (src.startsWith("google")) {
    if (lead.placeId) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(lead.placeId)}`;
    return isHttpUrl(ext) ? String(ext).trim() : "";
  }
  if (src.startsWith("facebook")) {
    return isHttpUrl(lead.fbUrl) ? lead.fbUrl.trim() : isHttpUrl(ext) ? String(ext).trim() : "";
  }
  if (src.startsWith("instagram")) {
    return isHttpUrl(lead.igUrl) ? lead.igUrl.trim() : isHttpUrl(ext) ? String(ext).trim() : "";
  }
  return "";
}

// One also-seen business, in the same shape slimProspect() in dashboard/server.js produces
// for a stored lead. The one difference: there is no lead row, so `id` is a synthetic tag
// the search page hangs DOM ids off (see tagAlsoSeen).
function slimScanned(l, hasWebsite) {
  return {
    id: null,
    external_id: String(l.externalId || l.name || ""),
    name: l.name || "",
    category: l.category || "",
    city: l.city || "",
    state: l.state || "",
    phone: l.phone || "",
    email: l.email || "",
    source: l.source || "",
    listingUrl: listingUrlFor(l), // the Google/Facebook/Instagram page the scan found it on
    website: l.website || "",
    hasWebsite,
    lastActive: lastActiveLabel(l),
    activeStatus: activityStatus(l),
    activeSignal: activitySignal(l),
    license: detectLicenseSignal(l),
    licenseUrl: licenseSearchUrl(l),
    saved: false,
  };
}

// Collapse the exact same record appearing twice in one batch (or across batched cells).
function dedupeScanned(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p.external_id) continue;
    const key = `${p.source}|${p.external_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// Page-unique ids. A "w3" tag can never collide with a real (numeric) lead id, which is what
// lets the search page tell "browsable, not stored yet" apart from "this is a lead row".
function tagAlsoSeen(list) {
  return list.map((p, i) => ({ ...p, id: `w${i}` }));
}

// Map a niche key/label to its Google + Facebook search phrases.
export function searchPhrase(nicheKey) {
  const n = NICHES.find((x) => x.key === nicheKey?.toLowerCase());
  return n ? n.search : nicheKey;
}

/**
 * Find qualified (in-niche, no-website) prospects for a niche + city across the chosen sources.
 * @param {{ userId?, niche, city, state, sources?: string[], limit?: number }} opts
 *   userId: whose leads/cache/brain this search reads and writes (default "local" for the CLI)
 *   sources: any of ["google","facebook"] (default both)
 * @returns {Promise<{ prospects, stats }>}
 */
// Normalized cache key so the same search (any source order) maps to one entry.
// `limit` (search depth) is part of the key: a "Quick (20)" run and a "Firehose (250)"
// run of the same niche/city are DIFFERENT searches, so a shallow cached result must not
// satisfy a deeper request (that bug made the Depth selector silently do nothing).
function cacheKey(niche, city, state, sources, limit) {
  return [niche, city, state, [...sources].sort().join(","), limit]
    .map((x) => String(x ?? "").trim().toLowerCase())
    .join("|");
}

// Will this search actually hit Apify (i.e. spend credits), or be served from cache for free?
// Used by the dashboard to apply the spend cap to EVERY live lookup, not just forced re-scans.
export async function willSearchSpend({ userId = "local", niche, city, state, sources = ["google", "facebook"], limit = 30, forceRefresh = false }) {
  if (forceRefresh) return true;
  return !(await store.getSearchCache(userId, cacheKey(niche, city, state, sources, limit)));
}

export async function discover({
  userId = "local", niche, city, state, sources = ["google", "facebook"], limit = 30,
  forceRefresh = false, scrapers = REAL_SCRAPERS, meter = true,
}) {
  const key = cacheKey(niche, city, state, sources, limit);

  // Served a matching search before? Return it for free — no Apify call.
  if (!forceRefresh) {
    const cached = await store.getSearchCache(userId, key);
    if (cached) {
      const rows = await store.getLeadsByIds(userId, cached.ids || []); // also drops any since-dismissed
      const stats = { ...cached.stats, qualified: rows.length };
      // Cache entries written before also-seen existed simply have no list; the page renders
      // the sections it has and skips the empty ones.
      const alsoSeen = Array.isArray(cached.alsoSeen) ? cached.alsoSeen : [];
      await store.setState(userId, "last_search", { niche, city, state, sources, limit, ids: rows.map((r) => r.id), stats, alsoSeen, ts: Date.now() });
      // A cached search counts, but costs nothing. Rounds of a guaranteed run pass
      // meter:false: that search is priced once, by its caller, not per round.
      if (meter) await store.logUsage(userId, "search", 0);
      return { prospects: rows, stats, cached: true, cachedAt: cached.updatedAt, alsoSeen };
    }
  }

  const phrase = searchPhrase(niche);
  let scanned = [];

  for (const name of SOURCE_ORDER) {
    if (!sources.includes(name)) continue;
    const scrape = scrapers?.[name];
    if (!scrape) continue;
    const got = await scrape({ category: phrase, city, state, limit });
    if (Array.isArray(got)) scanned.push(...got);
  }

  // ── Facebook deep-check (optional): the FB search doesn't return post dates, so under the
  // freshness filter those leads would be hidden as "unknown". When FB_DEEP_CHECK is on, scrape
  // each FB candidate's page for its real last-post date — but ONLY the ones that could actually
  // qualify (in-niche, no website, undated), so we never pay to date leads we'd drop anyway.
  let fbDeepChecked = 0;
  const fc = freshnessConfig();
  if (fc.enabled && fc.fbDeepCheck) {
    const fbCandidates = scanned.filter(
      (l) => l.source === "facebook" && !l.lastActivity && isTargetNiche(l.category) && !hasRealWebsite(l) && facebookUrlFor(l)
    );
    if (fbCandidates.length) {
      const batch = DEEP_CHECK_MAX ? fbCandidates.slice(0, DEEP_CHECK_MAX) : fbCandidates;
      const skipped = fbCandidates.length - batch.length;
      console.log(`[freshness] deep-checking ${batch.length} Facebook page(s) for last-post date…` +
        (skipped ? ` (${skipped} beyond the ${DEEP_CHECK_MAX} cap stay undated)` : ""));
      try {
        await enrichFacebookActivity(batch);
        fbDeepChecked = batch.length;
      } catch (e) {
        console.log(`[freshness] FB deep-check skipped: ${e.message}`);
      }
    }
  }

  // ── Google deep-check (optional): Google has no posts, so date in-niche/no-website Google
  // leads by their NEWEST review. Only the ones that could qualify, to save credits.
  let googleDeepChecked = 0;
  if (fc.enabled && fc.googleDeepCheck) {
    const gCandidates = scanned.filter(
      (l) => l.source === "google_maps" && !l.lastActivity && l.placeId && isTargetNiche(l.category) && !hasRealWebsite(l)
    );
    if (gCandidates.length) {
      const batch = DEEP_CHECK_MAX ? gCandidates.slice(0, DEEP_CHECK_MAX) : gCandidates;
      const skipped = gCandidates.length - batch.length;
      console.log(`[freshness] dating ${batch.length} Google place(s) by newest review…` +
        (skipped ? ` (${skipped} beyond the ${DEEP_CHECK_MAX} cap stay undated)` : ""));
      try {
        await enrichGoogleActivity(batch);
        googleDeepChecked = batch.length;
      } catch (e) {
        console.log(`[freshness] Google review-dating skipped: ${e.message}`);
      }
    }
  }

  // US-only: drop foreign results (non-+1 phone country code) BEFORE they touch the
  // brain or the leads list. Scrapers occasionally return India/Malaysia/etc. businesses
  // mislabeled with a US city, so we gate on the phone country code instead.
  const usScanned = keepUsOnly(scanned);
  const foreignDropped = scanned.length - usScanned.length;
  if (foreignDropped) console.log(`[us-only] dropped ${foreignDropped} non-US business(es) by phone country code`);
  scanned = usScanned;

  const { qualified, offNiche, hasSite, activeSeen, staleSeen, unknownSeen, inactive } = qualifyLeads(scanned);

  // Remember EVERY business we evaluated (incl. ones with websites) so the DB knows them.
  await store.recordChecked(
    userId,
    scanned.map((l) => ({
      source: l.source,
      external_id: String(l.externalId || l.name),
      name: l.name,
      has_website: hasRealWebsite(l) ? 1 : 0,
      niche,
      city,
      state,
    }))
  );

  // Same set, but into the GLOBAL business directory (no user_id): every business any scan
  // has ever touched, with or without a website. This is the one place that sees the full
  // scanned list, which is why the call lives here rather than in the dashboard's route.
  // Fire-and-forget: the directory is a side benefit and must never fail a search.
  try {
    const directory = scanned.map((l) => ({
      source: l.source,
      external_id: String(l.externalId || l.name),
      name: l.name ?? "",
      niche,
      city,
      state,
      phone: l.phone ?? "",
      email: l.email ?? "",
      website: l.website ?? "",
      has_website: hasRealWebsite(l) ? 1 : 0,
    }));
    Promise.resolve(store.recordDirectory(directory)).catch((e) =>
      console.log(`[directory] skipped: ${e.message}`)
    );
  } catch (e) {
    console.log(`[directory] skipped: ${e.message}`);
  }

  // Drop businesses you've already "marked off" so they never come back.
  const hidden = await store.dismissedKeys(userId);
  const kept = qualified.filter((l) => !hidden.has(`${l.source}|${l.externalId}`));
  const dismissedCount = qualified.length - kept.length;

  // ── Also-seen: in-niche businesses the scan found but didn't qualify ──
  // `has a website` is always the bulk of these: the user paid to find them and wants to
  // grab them later, so they stay browsable instead of being thrown away.
  // `went quiet` is only non-empty in "filter" mode, where the freshness gate actually drops
  // leads. In the default "label" mode nothing is dropped, so inactive no-website businesses
  // come back as ordinary prospects and the page buckets them by activeStatus instead.
  // Anything already marked off stays marked off.
  const notHidden = (l) => !hidden.has(`${l.source}|${l.externalId}`);
  const inNiche = scanned.filter((l) => isTargetNiche(l.category) && notHidden(l));
  const wentQuiet = fc.mode === "filter" ? inNiche.filter((l) => !hasRealWebsite(l) && !passesFreshness(l)) : [];
  const alsoSeen = tagAlsoSeen(
    dedupeScanned([
      // Quiet ones lead: they are the backup workflow, so they keep their slots under the cap.
      ...wentQuiet.map((l) => slimScanned(l, false)),
      ...inNiche.filter((l) => hasRealWebsite(l)).map((l) => slimScanned(l, true)),
    ]).slice(0, ALSO_SEEN_MAX)
  );

  // Store each qualified prospect, then reload as DB rows (accurate saved state).
  for (const lead of kept) lead.id = await store.upsertLeadReturningId(userId, lead);
  const fresh = await store.getLeadsByIds(userId, kept.map((l) => l.id));

  // Collapse the SAME business found via multiple sources (Google + FB + IG) into one row, so
  // the user never sees (or works) the same business 2–3 times. Keeps the richest copy.
  const prospects = dedupeProspects(fresh);
  const crossSourceMerged = fresh.length - prospects.length;

  const stats = {
    scanned: scanned.length,
    qualified: prospects.length,
    hasWebsite: hasSite,
    offNiche,
    activeSeen,
    staleSeen,
    unknownSeen,
    inactive,
    crossSourceMerged,
    sinceLabel: fc.enabled ? fc.since || `last ${fc.withinDays}d` : null,
    fbDeepChecked,
    googleDeepChecked,
    dismissed: dismissedCount,
    bySource: {
      google: prospects.filter((l) => l.source === "google_maps").length,
      facebook: prospects.filter((l) => l.source === "facebook").length,
      instagram: prospects.filter((l) => l.source === "instagram").length,
    },
  };

  // Meter this user's search. A live scan really did hit Apify, so bill it at the same
  // per-1k-places rate the UI estimates with; the dashboard turns that USD into tokens.
  // meter:false leaves the bill to the caller (a guaranteed run pays one flat price for
  // all of its rounds, so metering each round would charge the same scan twice).
  if (meter) await store.logUsage(userId, "search", (scanned.length / 1000) * RATE_PER_1K);

  // Cache this search so repeats are free, and remember it for navigation restore. The
  // also-seen list rides along in both: it has no lead rows to reload from, so leaving the
  // page and coming back would otherwise lose it.
  const ids = prospects.map((l) => l.id);
  await store.saveSearchCache(userId, key, { ids, stats, alsoSeen });
  await store.setState(userId, "last_search", { niche, city, state, sources, limit, ids, stats, alsoSeen, ts: Date.now() });

  return { prospects, stats, cached: false, alsoSeen };
}

// Source preference when the same business turns up on several platforms. Prefer the copy that
// already has an email (best for outreach); break ties by richer profile (Google → FB → IG).
function sourceRank(s) {
  return s === "google_maps" ? 3 : s === "facebook" ? 2 : 1;
}
function prospectScore(r) {
  return (r.email ? 100 : 0) + sourceRank(r.source);
}
// Collapse DB-row prospects sharing a dedup_key down to the single best copy, preserving order.
function dedupeProspects(rows) {
  const bestByKey = new Map();
  const out = [];
  for (const r of rows) {
    const key = r.dedup_key;
    if (!key) { out.push(r); continue; } // no canonical key → always kept
    const cur = bestByKey.get(key);
    if (!cur) { bestByKey.set(key, r); out.push(r); continue; }
    if (prospectScore(r) > prospectScore(cur)) {
      const idx = out.indexOf(cur);
      if (idx >= 0) out[idx] = r;
      bestByKey.set(key, r);
    }
  }
  return out;
}

/**
 * Batch discovery: run discover() across every (city × niche) combination and merge.
 * Each underlying discover() still caches per niche+city, so re-runs of the same grid
 * are mostly free. Prospects are de-duplicated by DB id; stats are summed (with qualified
 * + bySource recomputed from the merged, de-duped set so the headline numbers are honest).
 *
 * @param {{ userId?, niches:string[], cities:string[], state?, sources?, limit?, forceRefresh?,
 *           onProgress?:(done,total,label)=>void }} opts
 * @returns {Promise<{ prospects, stats, alsoSeen }>}
 */
export async function discoverMany({
  userId = "local", niches = [], cities = [], state, sources = ["google", "facebook"], limit = 30,
  forceRefresh = false, onProgress, scrapers = REAL_SCRAPERS,
}) {
  const nicheList = (Array.isArray(niches) ? niches : [niches]).filter(Boolean);
  const cityList = (Array.isArray(cities) ? cities : [cities]).filter(Boolean);
  const fc = freshnessConfig();

  const agg = {
    scanned: 0, qualified: 0, hasWebsite: 0, offNiche: 0,
    activeSeen: 0, staleSeen: 0, unknownSeen: 0, inactive: 0, dismissed: 0,
    fbDeepChecked: 0, googleDeepChecked: 0, runs: 0, cells: nicheList.length * cityList.length,
    sinceLabel: fc.enabled ? fc.since || `last ${fc.withinDays}d` : null,
    bySource: { google: 0, facebook: 0, instagram: 0 },
  };
  const SUM_KEYS = [
    "scanned", "hasWebsite", "offNiche", "activeSeen", "staleSeen",
    "unknownSeen", "inactive", "dismissed", "fbDeepChecked", "googleDeepChecked",
  ];

  const merged = [];
  const alsoMerged = [];
  const seen = new Set();
  let done = 0;
  for (const city of cityList) {
    for (const niche of nicheList) {
      onProgress?.(done, agg.cells, `${niche} · ${city}`);
      let r;
      try {
        r = await discover({ userId, niche, city, state, sources, limit, forceRefresh, scrapers });
      } catch (e) {
        console.log(`[batch] ${niche} · ${city} failed: ${e.message}`);
        done++;
        continue;
      }
      agg.runs++;
      for (const k of SUM_KEYS) agg[k] += r.stats?.[k] || 0;
      for (const p of r.prospects) {
        if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
      }
      if (Array.isArray(r.alsoSeen)) alsoMerged.push(...r.alsoSeen);
      done++;
    }
  }
  onProgress?.(done, agg.cells, "done");

  // Each cell tagged its own list from w0, so re-tag after merging to keep ids unique, and
  // re-apply the cap to the whole batch rather than per cell.
  const alsoSeen = tagAlsoSeen(dedupeScanned(alsoMerged).slice(0, ALSO_SEEN_MAX));

  // Collapse the same business appearing across cells/sources into one row (cross-cell dedup;
  // each cell was already de-duped internally, but a business can span multiple cities/niches).
  const prospects = dedupeProspects(merged);

  // Honest headline numbers from the de-duped merged set.
  agg.qualified = prospects.length;
  agg.crossSourceMerged = merged.length - prospects.length;
  agg.bySource = {
    google: prospects.filter((l) => l.source === "google_maps").length,
    facebook: prospects.filter((l) => l.source === "facebook").length,
    instagram: prospects.filter((l) => l.source === "instagram").length,
  };
  return { prospects, stats: agg, alsoSeen };
}

// ── The guarantee: 5 no-website companies, or you pay the standard rate ──────
// A depth number is a promise about EFFORT ("we will look at 50 businesses"), which is
// not what anyone is buying. This is a promise about RESULT: keep scanning, in rounds,
// until five qualified companies are in hand. Yield is roughly 1 per 7 scanned and 1 per
// 20 on a bad day, so the caps below are what stop a thin market turning into a runaway
// bill or a run that never returns inside the host's own time limit.
export const GUARANTEE_TARGET = 5;
export const GUARANTEE_ROUND_DEPTH = 25; // how much deeper each round goes, per source
export const GUARANTEE_MAX_SCANNED = 120; // ~6 x the worst measured yield for 5 companies
export const GUARANTEE_MAX_SECONDS = 550; // well inside the 800s host ceiling

// Which of the three lists a stored prospect belongs to, by the same rule the pages use.
// The guarantee counts the "qualified" list only: no website AND still active. Anything
// inactive or already online rides along on the results, but does not count towards five.
export function bucketOfRow(row) {
  let lj = row;
  if (typeof row?.lead_json === "string") {
    try { lj = JSON.parse(row.lead_json) || row; } catch { lj = row; }
  } else if (row?.lead_json) {
    lj = row.lead_json;
  }
  if (hasRealWebsite({ website: row?.website || lj?.website || "" })) return "has_website";
  return activityStatus(lj) === "active" ? "qualified" : "inactive";
}

/**
 * Plan the next round of a guaranteed search, or return null when there is no round left
 * to run. Pure, so the walk (deepen this cell, then move to the next one) can be reasoned
 * about and tested without scanning anything.
 *
 * A round asks one cell for `limit` businesses PER SOURCE. Asking deeper re-reads what the
 * shallower round already saw, so the round only adds `limit - depth` new businesses per
 * source while costing `limit x sources`, which is why the budget check is against the
 * whole ask, and why a cell is abandoned as soon as the budget cannot fund a deeper look.
 *
 * @param {{cells:number, sources:number, scanned:number, cellIndex:number, depth:number,
 *          maxScanned?:number, roundDepth?:number}} state
 *   cells      how many (city x trade) cells the expansion pool holds
 *   scanned    businesses scanned so far across the whole run
 *   cellIndex  which cell the last round used
 *   depth      per-source depth already scanned in THAT cell (0 = untouched)
 * @returns {{cellIndex:number, limit:number, deeper:boolean}|null}
 */
export function planGuaranteedRound({
  cells, sources = 1, scanned = 0, cellIndex = 0, depth = 0,
  maxScanned = GUARANTEE_MAX_SCANNED, roundDepth = GUARANTEE_ROUND_DEPTH,
}) {
  const step = Math.max(1, roundDepth);
  const srcN = Math.max(1, sources);
  let ci = Math.max(0, cellIndex);
  let d = Math.max(0, depth);
  while (ci < cells) {
    const affordable = Math.floor(Math.max(0, maxScanned - scanned) / srcN);
    if (affordable < 1) return null; // not even one place per source left in the budget
    if (affordable > d) return { cellIndex: ci, limit: Math.min(d + step, affordable), deeper: d > 0 };
    ci++; // this cell can't be looked at any deeper on what's left: move to the next one
    d = 0;
  }
  return null; // pool exhausted
}

/**
 * Run a guaranteed search: rounds against cell 1 until it is exhausted, then cell 2, and
 * so on, stopping the moment `target` qualified companies are in hand. The cities (and
 * trades, when several are picked) are the expansion pool, walked city-major.
 *
 * Stops early on ANY of: target met, scan budget spent, time budget spent, pool exhausted.
 * Deliberately does NOT meter: the caller prices the whole run once, because whether this
 * was a premium search or a plain scan is only known when it stops.
 *
 * @returns {Promise<{prospects, alsoSeen, stats, cached, guarantee}>}
 *   guarantee: { target, found, met, scanned, rounds, cellsUsed, capped, capReason, elapsedMs }
 */
export async function discoverGuaranteed({
  userId = "local", niches = [], cities = [], state, sources = ["google", "facebook"],
  target = GUARANTEE_TARGET, forceRefresh = false, scrapers = REAL_SCRAPERS,
  maxScanned = GUARANTEE_MAX_SCANNED, maxSeconds = GUARANTEE_MAX_SECONDS,
  roundDepth = GUARANTEE_ROUND_DEPTH, now = () => Date.now(), onProgress,
}) {
  const nicheList = (Array.isArray(niches) ? niches : [niches]).filter(Boolean);
  const cityList = (Array.isArray(cities) ? cities : [cities]).filter(Boolean);
  // City-major: every trade in city 1 before city 2 is touched, so the pool expands the
  // way the user reads their own city list.
  const cells = [];
  for (const city of cityList) for (const niche of nicheList) cells.push({ niche, city });

  const fc = freshnessConfig();
  const agg = {
    scanned: 0, qualified: 0, hasWebsite: 0, offNiche: 0,
    activeSeen: 0, staleSeen: 0, unknownSeen: 0, inactive: 0, dismissed: 0,
    fbDeepChecked: 0, googleDeepChecked: 0, runs: 0, cells: cells.length,
    sinceLabel: fc.enabled ? fc.since || `last ${fc.withinDays}d` : null,
    bySource: { google: 0, facebook: 0, instagram: 0 },
  };
  const SUM_KEYS = [
    "scanned", "hasWebsite", "offNiche", "activeSeen", "staleSeen",
    "unknownSeen", "inactive", "dismissed", "fbDeepChecked", "googleDeepChecked",
  ];

  const t0 = now();
  const merged = [];
  const alsoMerged = [];
  const seen = new Set();
  const cellsUsed = [];
  let scanned = 0;
  let cellIndex = 0;
  let depth = 0;
  let rounds = 0;
  let found = 0;
  let spent = false; // did any round actually hit the scrapers (vs being served from cache)?
  let capReason = "";

  while (found < target) {
    if ((now() - t0) / 1000 >= maxSeconds) { capReason = "time"; break; }
    const plan = planGuaranteedRound({
      cells: cells.length, sources: sources.length, scanned, cellIndex, depth, maxScanned, roundDepth,
    });
    // No round left to plan: every cell in the pool has been looked at as deeply as the
    // scan budget can pay for. ("pool" is the degenerate case of no cities at all.)
    if (!plan) { capReason = cells.length ? "scan" : "pool"; break; }
    cellIndex = plan.cellIndex;
    depth = plan.limit;
    const cell = cells[cellIndex];
    onProgress?.({ round: rounds + 1, city: cell.city, niche: cell.niche, found, scanned });

    let r;
    try {
      r = await discover({
        userId, niche: cell.niche, city: cell.city, state, sources,
        limit: plan.limit, forceRefresh, scrapers, meter: false,
      });
    } catch (e) {
      console.log(`[guarantee] ${cell.niche} · ${cell.city} round failed: ${e.message}`);
      cellIndex++; // a cell that throws is not worth deepening
      depth = 0;
      if (cellIndex >= cells.length) { capReason = "pool"; break; }
      continue;
    }

    rounds++;
    agg.runs++;
    if (!r.cached) spent = true;
    scanned += r.stats?.scanned || 0;
    for (const k of SUM_KEYS) agg[k] += r.stats?.[k] || 0;
    for (const p of r.prospects) {
      if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
    }
    if (Array.isArray(r.alsoSeen)) alsoMerged.push(...r.alsoSeen);
    const label = `${cell.niche} · ${cell.city}`;
    if (!cellsUsed.includes(label)) cellsUsed.push(label);
    found = dedupeProspects(merged).filter((p) => bucketOfRow(p) === "qualified").length;
  }

  const prospects = dedupeProspects(merged);
  const alsoSeen = tagAlsoSeen(dedupeScanned(alsoMerged).slice(0, ALSO_SEEN_MAX));
  found = prospects.filter((p) => bucketOfRow(p) === "qualified").length;
  const met = found >= target;

  agg.scanned = scanned;
  agg.qualified = prospects.length;
  agg.crossSourceMerged = merged.length - prospects.length;
  agg.bySource = {
    google: prospects.filter((l) => l.source === "google_maps").length,
    facebook: prospects.filter((l) => l.source === "facebook").length,
    instagram: prospects.filter((l) => l.source === "instagram").length,
  };

  // One last_search entry for the WHOLE run: each round wrote its own as it went, and a
  // restore should bring back everything the run found, not just its final round.
  const ids = prospects.map((l) => l.id);
  await store.setState(userId, "last_search", {
    niche: cells[0]?.niche || nicheList[0] || "",
    city: cityList.join(", "),
    state, sources, mode: "guaranteed", limit: null,
    ids, stats: agg, alsoSeen, ts: Date.now(),
  });

  return {
    prospects,
    alsoSeen,
    stats: agg,
    // Nothing was scraped: every round came back from the cache, so this run is a free
    // replay and must not be charged, guarantee met or not.
    cached: rounds > 0 && !spent,
    guarantee: {
      target, found, met, scanned, rounds,
      cells: cellsUsed,
      capped: !met && !!capReason,
      capReason: met ? "" : capReason,
      elapsedMs: now() - t0,
    },
  };
}
