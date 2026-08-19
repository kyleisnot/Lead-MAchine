// freshness.js — "is this business still active?" gate.
// A lead qualifies only if its MOST RECENT post/activity is within ACTIVE_WITHIN_DAYS
// (rolling window). Leads we can't date are dropped when FRESHNESS_STRICT is on.
//
// Config (.env):
//   ACTIVE_WITHIN_DAYS=365   → keep leads active within this many days. 0/blank = filter OFF.
//   FRESHNESS_STRICT=true    → also hide leads whose last activity can't be determined.
//                              false = keep undated leads (lenient).

import "dotenv/config";

const WITHIN_DAYS = parseInt(process.env.ACTIVE_WITHIN_DAYS ?? "365", 10) || 0;
// Absolute cutoff date, e.g. "2026-01-01". Takes precedence over the rolling window.
const SINCE_RAW = (process.env.ACTIVE_SINCE || "").trim();
const SINCE_EPOCH = SINCE_RAW && !isNaN(Date.parse(SINCE_RAW)) ? Date.parse(SINCE_RAW) : null;
const STRICT = String(process.env.FRESHNESS_STRICT ?? "true").toLowerCase() !== "false";
// Scrape each FB / Google candidate during search to read its real last activity so the
// "active" tags/filter are actually meaningful. Default ON: dating runs ONLY on leads that
// could otherwise qualify (in-niche, no-website, undated), so the extra Apify cost is bounded
// to the handful of leads you actually care about. Set FB_DEEP_CHECK/GOOGLE_DEEP_CHECK=false
// in .env to turn it off and save those credits (leads then show as "undated").
const FB_DEEP_CHECK = String(process.env.FB_DEEP_CHECK ?? "true").toLowerCase() === "true";
const GOOGLE_DEEP_CHECK = String(process.env.GOOGLE_DEEP_CHECK ?? "true").toLowerCase() === "true";
// "label"  = NEVER drop a lead — just tag it active/old/unknown so you can judge.
// "filter" = actually drop stale + undated leads (used once you trust the dates).
const MODE = String(process.env.FRESHNESS_MODE ?? "label").toLowerCase() === "filter" ? "filter" : "label";
const ENABLED = SINCE_EPOCH != null || WITHIN_DAYS > 0;

// The "must be active after this moment" cutoff (epoch ms), or null when disabled.
function cutoffEpoch() {
  if (SINCE_EPOCH != null) return SINCE_EPOCH;
  if (WITHIN_DAYS > 0) return Date.now() - WITHIN_DAYS * 86400000;
  return null;
}

export function freshnessConfig() {
  return {
    withinDays: WITHIN_DAYS,
    since: SINCE_RAW || null,
    strict: STRICT,
    enabled: ENABLED,
    mode: MODE,
    fbDeepCheck: FB_DEEP_CHECK,
    googleDeepCheck: GOOGLE_DEEP_CHECK,
  };
}

// Parse "3 days ago" / "yesterday" / "an hour ago" / "last week" → epoch ms (or null).
// Facebook's posts scraper very often returns these instead of real dates; without this
// they parse to null and otherwise-active pages get dropped as "undated".
const UNIT_MS = {
  second: 1000, minute: 60000, hour: 3600000, day: 86400000,
  week: 604800000, month: 2629800000, year: 31557600000,
};
function relativeToEpoch(s) {
  const str = s.toLowerCase().trim();
  if (/^(just now|now|today)$/.test(str)) return Date.now();
  if (str === "yesterday") return Date.now() - UNIT_MS.day;
  // "a/an <unit> ago", "last <unit>", "N <unit>(s) ago"
  let m = str.match(/^(?:(\d+)|a|an|last)\s+(second|minute|hour|day|week|month|year)s?(?:\s+ago)?$/);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    return Date.now() - n * UNIT_MS[m[2]];
  }
  return null;
}

// Parse the many date shapes Apify actors return → epoch ms (or null).
// Handles ISO strings, "2024-03-01", unix seconds, unix milliseconds, and relative
// phrases like "3 days ago" / "yesterday".
export function toEpoch(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // seconds vs ms
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return t;
  return relativeToEpoch(s); // last resort: "3 days ago" etc.
}

// Most recent (largest) epoch from a list of date-ish values.
export function latestEpoch(values = []) {
  let best = null;
  for (const v of (Array.isArray(values) ? values : [values])) {
    const e = toEpoch(v);
    if (e != null && (best == null || e > best)) best = e;
  }
  return best;
}

// "active" | "stale" | "unknown" for a normalized lead (uses lead.lastActivity).
export function activityStatus(lead) {
  const e = toEpoch(lead?.lastActivity);
  if (e == null) return "unknown";
  const c = cutoffEpoch();
  if (c == null) return "active"; // no cutoff configured → a dated lead is fine
  return e >= c ? "active" : "stale";
}

// Should we KEEP this lead under the freshness rule?
// In "label" mode we NEVER drop — we only tag. Dropping happens only in "filter" mode.
export function passesFreshness(lead) {
  if (MODE !== "filter") return true; // label-only mode → keep everything, just tag it
  if (!ENABLED) return true; // no cutoff configured → everything passes
  const s = activityStatus(lead);
  if (s === "active") return true;
  if (s === "stale") return false;
  return !STRICT; // unknown → drop when strict, keep when lenient
}

// Short "Mar 2025" label for a lead's last activity (or "" if unknown).
export function lastActiveLabel(lead) {
  const e = toEpoch(lead?.lastActivity);
  if (e == null) return "";
  return new Date(e).toLocaleString("en-US", { month: "short", year: "numeric" });
}

// Which signal dated this lead (so the user can see WHY it qualified).
// Google has no posts → newest review; FB/IG → newest post.
export function activitySignal(lead) {
  if (!lead?.lastActivity) return "";
  switch (lead.source) {
    case "google_maps": return "Google review";
    case "facebook": return "FB post";
    case "instagram": return "IG post";
    default: return "activity";
  }
}

// Human label of the active-since cutoff, for the UI (e.g. "Jan 2025" or "last 365 days").
export function cutoffLabel() {
  if (SINCE_EPOCH != null) {
    // UTC so a date-only cutoff like "2025-01-01" reads as "Jan 2025", not "Dec 2024"
    // in timezones behind UTC.
    return new Date(SINCE_EPOCH).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  if (WITHIN_DAYS > 0) return `last ${WITHIN_DAYS} days`;
  return "any time";
}
