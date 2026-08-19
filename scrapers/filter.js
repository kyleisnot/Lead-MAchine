// filter.js — decides whether a business effectively has NO real website (= a good lead).
//
// "No real website" means one of:
//   - no website field at all, OR
//   - the only "website" is a social page (Facebook/Instagram), a link aggregator,
//     a review/listing page, or a free auto-generated page (Google business.site, etc.)
//
// Tweak NOT_A_REAL_WEBSITE below to change what counts. Set treatFreeSitesAsNone=false
// if you DON'T want to target businesses that already have a free Google/Wix-type page.

const NOT_A_REAL_WEBSITE = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linktr.ee",
  "yelp.com",
  "google.com",
  "g.page",
  "goo.gl",
  "tripadvisor.com",
  "nextdoor.com",
  "yellowpages.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "wa.me", // whatsapp
];

const FREE_AUTO_SITES = [
  "business.site", // Google free site
  "sites.google.com",
  "godaddysites.com",
  "wixsite.com",
  "weebly.com",
  "square.site",
];

// Extract the bare hostname (no www) from a URL so we match real domains,
// not substrings (e.g. "knox.com" must NOT match the blocked domain "x.com").
function hostOf(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "http://" + url);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}

// True if `host` IS the blocked domain or a subdomain of it (boundary-aware).
function matchesDomain(host, dom) {
  return host === dom || host.endsWith("." + dom);
}

// Is a SINGLE url a real, standalone website (not social/map/listing/free-site)?
export function isRealWebsiteUrl(raw, { treatFreeSitesAsNone = true } = {}) {
  const url = (raw || "").trim();
  if (!url) return false;
  const host = hostOf(url);
  const blocked = [...NOT_A_REAL_WEBSITE, ...(treatFreeSitesAsNone ? FREE_AUTO_SITES : [])];
  if (blocked.some((dom) => matchesDomain(host, dom))) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host); // looks like "something.tld"
}

// From a list of candidate links (e.g. Facebook lists several), return the first
// REAL website if any exists. Used so an Instagram/Maps link listed first doesn't
// hide a real website listed second.
export function pickBestWebsite(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  return list.find((u) => isRealWebsiteUrl(u)) || list[0] || "";
}

export function hasRealWebsite(lead, opts) {
  return isRealWebsiteUrl(lead.website, opts);
}

/** Returns only the leads WITHOUT a real website. */
export function keepNoWebsite(leads, opts) {
  return leads.filter((lead) => !hasRealWebsite(lead, opts));
}

// ── US-only gate ──
// Scrapers sometimes surface foreign businesses (e.g. an India +91 or Malaysia +60
// result) and mislabel them with a US city, so city/state can't be trusted. The one
// reliable signal is the phone's country code: US/Canada is "+1"; any other "+NN" is
// foreign. Businesses with NO phone are kept (we don't guess). This keeps foreign
// results out of BOTH the brain and the leads list at the source.
export function isUsBased(lead) {
  const raw = String((lead && lead.phone) || "").trim();
  if (!raw) return true; // no phone → don't guess, keep it
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+1")) return true; // +1 → US/Canada (NANP)
  if (digits.startsWith("+")) return false; // +<anything else> → foreign
  if (digits.startsWith("001")) return true; // 001 intl prefix → US
  if (digits.startsWith("00")) return false; // 00<other> intl prefix → foreign
  return true; // plain domestic number, no country code → treat as US
}

/** Drop businesses whose phone shows a non-US/Canada country code. */
export function keepUsOnly(leads) {
  return leads.filter(isUsBased);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GOAL, ENFORCED IN ONE PLACE:
// Only ever target businesses that are (1) in our chosen niches, (2) have NO
// website, AND (3) are still ACTIVE (most recent post within ACTIVE_WITHIN_DAYS).
// A lead must pass ALL THREE checks to qualify. Nothing else proceeds to the
// build/email pipeline. Change the niche list in lib/niches.js, the website rules
// above, or the freshness window in lib/freshness.js (.env ACTIVE_WITHIN_DAYS).
// ─────────────────────────────────────────────────────────────────────────────
import { isTargetNiche } from "../lib/niches.js";
import { passesFreshness, activityStatus } from "../lib/freshness.js";

export function qualifies(lead, opts) {
  return isTargetNiche(lead.category) && !hasRealWebsite(lead, opts) && passesFreshness(lead);
}

/**
 * Split scraped leads into qualified (target niche + no website) and the reasons
 * the rest were rejected. Only `qualified` should ever be built/emailed.
 */
export function qualifyLeads(leads, opts) {
  const qualified = [];
  let offNiche = 0;
  let hasSite = 0;
  let activeSeen = 0; // recent post (within window)
  let staleSeen = 0; // had a post, but older than the window
  let unknownSeen = 0; // no post date found
  let dropped = 0; // actually removed (only happens in "filter" mode)
  for (const lead of leads) {
    if (!isTargetNiche(lead.category)) {
      offNiche++;
      continue;
    }
    if (hasRealWebsite(lead, opts)) {
      hasSite++;
      continue;
    }
    const s = activityStatus(lead);
    if (s === "active") activeSeen++;
    else if (s === "stale") staleSeen++;
    else unknownSeen++;

    if (!passesFreshness(lead)) {
      dropped++; // filter mode only — label mode never gets here
      continue;
    }
    qualified.push(lead);
  }
  return {
    qualified,
    offNiche,
    hasSite,
    activeSeen,
    staleSeen,
    unknownSeen,
    inactive: dropped, // how many were actually removed by the freshness filter
    total: leads.length,
  };
}
