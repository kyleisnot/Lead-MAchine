// pipeline.js — the shared engine used by BOTH the CLI and the search UI.
//
//   discover()      → search source(s) for a niche+city, keep only no-website in-niche leads,
//                     store them as "found" prospects, return them + stats. (cheap/fast)
//   buildForLead()  → for one found prospect: enrich (if needed), build the Site Flash preview,
//                     write the email draft, store it as "preview_built". (the expensive bit)
//
// Splitting "find" from "build" means a search is fast + cheap, and you only spend the
// expensive enrichment/build on prospects you actually choose.

import { scrapeGoogleMaps, scrapeGooglePlacesByIds, enrichGoogleActivity } from "../scrapers/maps.js";
import { searchFacebook } from "../scrapers/facebookSearch.js";
import { searchInstagram } from "../scrapers/instagram.js";
import { enrichWithFacebook, enrichFacebookActivity, scrapeFacebookPage, facebookUrlFor } from "../scrapers/facebook.js";
import { fetchMorePhotos } from "../scrapers/morePhotos.js";
import { qualifyLeads, hasRealWebsite, keepUsOnly } from "../scrapers/filter.js";
import { NICHES, isTargetNiche } from "./niches.js";
import { freshnessConfig } from "./freshness.js";
import { publicPreviewUrl } from "./publicUrl.js";
import {
  upsertLeadReturningId, getLead, attachPreview, dismissedKeys, setState,
  getSearchCache, saveSearchCache, recordChecked, getLeadsByIds, logUsage,
} from "../data/db.js";
import { mapLeadToSiteData } from "../builder/mapper.js";
import { curatePhotos } from "../builder/photoCurator.js";
import { ensureBeforeAfter } from "../builder/beforeAfter.js";
import { savePreviewV2 } from "../builder/template.js";
import { draftEmail } from "../mailer/draft.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const previewPathFor = (id) => join(__dirname, "..", "data", "previews", `${id}.html`);

// Map a niche key/label to its Google + Facebook search phrases.
export function searchPhrase(nicheKey) {
  const n = NICHES.find((x) => x.key === nicheKey?.toLowerCase());
  return n ? n.search : nicheKey;
}

/**
 * Find qualified (in-niche, no-website) prospects for a niche + city across the chosen sources.
 * @param {{ niche, city, state, sources?: string[], limit?: number }} opts
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
export function willSearchSpend({ niche, city, state, sources = ["google", "facebook"], limit = 30, forceRefresh = false }) {
  if (forceRefresh) return true;
  return !getSearchCache(cacheKey(niche, city, state, sources, limit));
}

export async function discover({ niche, city, state, sources = ["google", "facebook"], limit = 30, forceRefresh = false }) {
  const key = cacheKey(niche, city, state, sources, limit);

  // Served a matching search before? Return it for free — no Apify call.
  if (!forceRefresh) {
    const cached = getSearchCache(key);
    if (cached) {
      const rows = getLeadsByIds(cached.ids || []); // also drops any since-dismissed
      const stats = { ...cached.stats, qualified: rows.length };
      setState("last_search", { niche, city, state, sources, limit, ids: rows.map((r) => r.id), stats, ts: Date.now() });
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
  recordChecked(
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
  const hidden = dismissedKeys();
  const kept = qualified.filter((l) => !hidden.has(`${l.source}|${l.externalId}`));
  const dismissedCount = qualified.length - kept.length;

  // Store each qualified prospect, then reload as DB rows (accurate saved/built state).
  for (const lead of kept) lead.id = upsertLeadReturningId(lead);
  const fresh = getLeadsByIds(kept.map((l) => l.id));

  // Collapse the SAME business found via multiple sources (Google + FB + IG) into one row, so
  // we never build/email the same business 2–3 times. Keeps the richest copy for outreach.
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

  logUsage("search", 0); // count live searches (Apify $ comes from Apify's API)

  // Cache this search so repeats are free, and remember it for navigation restore.
  const ids = prospects.map((l) => l.id);
  saveSearchCache(key, { ids, stats });
  setState("last_search", { niche, city, state, sources, limit, ids, stats, ts: Date.now() });

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
 * @param {{ niches:string[], cities:string[], state?, sources?, limit?, forceRefresh?,
 *           onProgress?:(done,total,label)=>void }} opts
 * @returns {Promise<{ prospects, stats }>}
 */
export async function discoverMany({
  niches = [], cities = [], state, sources = ["google", "facebook"], limit = 30,
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
        r = await discover({ niche, city, state, sources, limit, forceRefresh });
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

/**
 * Build the preview + email draft for one stored lead (by DB id).
 * Enriches Google leads with photos/contacts first (Facebook leads already have them).
 */
export async function buildForLead(id) {
  const row = getLead(id);
  if (!row) throw new Error(`Lead #${id} not found`);
  const lead = JSON.parse(row.lead_json);

  // Google basic-discovery leads have no photos/email yet — enrich just this one now.
  if (lead.source === "google_maps" && lead.placeId && !(lead.images && lead.images.length)) {
    const [enriched] = await scrapeGooglePlacesByIds([lead.placeId], { detail: "full" });
    if (enriched) {
      if (enriched.images?.length) lead.images = enriched.images;
      if (enriched.email && !lead.email) lead.email = enriched.email;
      if (enriched.about && !lead.about) lead.about = enriched.about;
      if (enriched.fbUrl && enriched.fbUrl !== "#") lead.fbUrl = enriched.fbUrl;
    }
  }

  // FB bridge: if we still have no email but the lead links a Facebook page
  // (common for Instagram & Google leads), scrape that page for the email.
  if (!lead.email && lead.fbUrl && lead.fbUrl !== "#") {
    try {
      await enrichWithFacebook([lead]);
    } catch {}
  }

  // Deep photo fetch: photo-light leads (e.g. Facebook-only) → pull real photos from their
  // Google Business Profile so the gallery fills out like a fully-photographed lead.
  if ((lead.images || []).length < 6) {
    try {
      const more = await fetchMorePhotos(lead);
      if (more.length) lead.images = [...new Set([...(lead.images || []), ...more])];
    } catch {}
  }

  // AI photo curation: have Claude decide which photo is the logo/hero/gallery/before-after.
  let curated = null;
  if (lead.images?.length) {
    curated = await curatePhotos({ images: lead.images, name: lead.name, category: lead.category });
  }

  // Ensure a Before/After: real pair → real-after + AI-before → fully AI (see beforeAfter.js).
  const ba = await ensureBeforeAfter({ curated, lead });
  if (ba) {
    curated = curated || {};
    curated.before = ba.before;
    curated.after = ba.after;
    curated.baSynthetic = !!ba.synthetic; // true when the before (or both) is AI-generated
  }

  // Log estimated AI spend for this build (Claude curation + OpenAI before/after).
  logUsage("build", (curated && curated.hero ? 0.02 : 0) + (ba?.cost || 0));

  const siteData = mapLeadToSiteData(lead, curated);
  const previewPath = previewPathFor(id);
  savePreviewV2(siteData, previewPath);
  const { subject, body } = draftEmail(lead, publicPreviewUrl(id));
  attachPreview(id, { siteData, previewPath, emailSubject: subject, emailBody: body });
  return { id, name: lead.name, email: lead.email, previewPath };
}

/**
 * MANUAL lead: paste a single Facebook page URL → scrape it, store it, and build the
 * full preview + email draft. Skips the niche/no-website qualification on purpose —
 * you found this lead yourself, so we build a preview regardless.
 * @returns {Promise<{ id, name, email, previewPath }>}
 */
export async function buildFromUrl(url) {
  const u = (url || "").trim();
  if (!u) throw new Error("Paste a Facebook page URL first.");
  if (!/facebook\.com|fb\.com/i.test(u)) {
    throw new Error("This accepts Facebook page URLs (e.g. https://facebook.com/their-business).");
  }
  const lead = await scrapeFacebookPage(u);
  if (!lead.name) lead.name = "Your Business";
  const id = upsertLeadReturningId(lead);
  logUsage("manual", 0);
  return buildForLead(id); // enriches photos/email, AI curation + before/after, writes draft
}
