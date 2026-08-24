// pipeline.js — the shared engine used by BOTH the CLI and the search UI.
//
//   discover()     → search source(s) for a niche+city, keep only no-website in-niche leads,
//                    store them as this user's prospects, return them + stats.
//   discoverMany() → the same across a grid of niches × cities.
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
import { freshnessConfig } from "./freshness.js";
import { RATE_PER_1K } from "./spend.js";
import * as store from "../data/store.js";

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

export async function discover({ userId = "local", niche, city, state, sources = ["google", "facebook"], limit = 30, forceRefresh = false }) {
  const key = cacheKey(niche, city, state, sources, limit);

  // Served a matching search before? Return it for free — no Apify call.
  if (!forceRefresh) {
    const cached = await store.getSearchCache(userId, key);
    if (cached) {
      const rows = await store.getLeadsByIds(userId, cached.ids || []); // also drops any since-dismissed
      const stats = { ...cached.stats, qualified: rows.length };
      await store.setState(userId, "last_search", { niche, city, state, sources, limit, ids: rows.map((r) => r.id), stats, ts: Date.now() });
      await store.logUsage(userId, "search", 0); // a cached search counts, but costs nothing
      return { prospects: rows, stats, cached: true, cachedAt: cached.updatedAt };
    }
  }

  const phrase = searchPhrase(niche);
  let scanned = [];

  if (sources.includes("google")) {
    const g = await scrapeGoogleMaps({ category: phrase, city, state, limit, detail: "basic" });
    scanned.push(...g);
  }
  if (sources.includes("facebook")) {
    const f = await searchFacebook({ category: phrase, city, state, limit });
    scanned.push(...f);
  }
  if (sources.includes("instagram")) {
    const ig = await searchInstagram({ category: phrase, city, state, limit });
    scanned.push(...ig);
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
      console.log(`[freshness] deep-checking ${fbCandidates.length} Facebook page(s) for last-post date…`);
      try {
        await enrichFacebookActivity(fbCandidates);
        fbDeepChecked = fbCandidates.length;
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
      console.log(`[freshness] dating ${gCandidates.length} Google place(s) by newest review…`);
      try {
        await enrichGoogleActivity(gCandidates);
        googleDeepChecked = gCandidates.length;
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

  // Drop businesses you've already "marked off" so they never come back.
  const hidden = await store.dismissedKeys(userId);
  const kept = qualified.filter((l) => !hidden.has(`${l.source}|${l.externalId}`));
  const dismissedCount = qualified.length - kept.length;

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
  await store.logUsage(userId, "search", (scanned.length / 1000) * RATE_PER_1K);

  // Cache this search so repeats are free, and remember it for navigation restore.
  const ids = prospects.map((l) => l.id);
  await store.saveSearchCache(userId, key, { ids, stats });
  await store.setState(userId, "last_search", { niche, city, state, sources, limit, ids, stats, ts: Date.now() });

  return { prospects, stats, cached: false };
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
 * @returns {Promise<{ prospects, stats }>}
 */
export async function discoverMany({
  userId = "local", niches = [], cities = [], state, sources = ["google", "facebook"], limit = 30,
  forceRefresh = false, onProgress,
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
  const seen = new Set();
  let done = 0;
  for (const city of cityList) {
    for (const niche of nicheList) {
      onProgress?.(done, agg.cells, `${niche} · ${city}`);
      let r;
      try {
        r = await discover({ userId, niche, city, state, sources, limit, forceRefresh });
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
      done++;
    }
  }
  onProgress?.(done, agg.cells, "done");

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
  return { prospects, stats: agg };
}
