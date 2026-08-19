// morePhotos.js — when a lead is photo-light (common for Facebook/Instagram-only leads),
// look the business up on Google Maps by name + city and pull its real project photos.
// Most local businesses have a Google Business Profile with 5–15 photos, even with no website.

import { scrapeGoogleMaps } from "./maps.js";
import { NICHES } from "../lib/niches.js";

// Generic words that DON'T identify a specific business — trade terms (from the niche
// keyword list) plus common company-name filler. Two different companies in the same trade
// share these, so they must not count toward a confident match.
const GENERIC = [
  "services", "service", "company", "contracting", "contractor", "contractors",
  "professional", "professionals", "solutions", "group", "design", "designs",
  "quality", "local", "best", "pros", "and", "the",
  ...NICHES.flatMap((n) => n.match.flatMap((m) => m.split(/\s+/))),
];

// Significant words (3+ chars) from a name.
const sig = (s = "") => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);

// True if a word is just a generic/trade term (substring match either way handles stems
// like "landscap" ↔ "landscaping").
const isGeneric = (w) => GENERIC.some((g) => w.includes(g) || g.includes(w));

// The DISTINCTIVE (brand) words of a name — what actually identifies this one business.
const distinctive = (s = "") => sig(s).filter((w) => !isGeneric(w));

/**
 * @param {object} lead
 * @param {number} minNeeded - skip if the lead already has at least this many photos
 * @returns {Promise<string[]>} extra photo URLs (deduped against existing)
 */
export async function fetchMorePhotos(lead, minNeeded = 6) {
  const have = (lead.images || []).filter(Boolean);
  if (have.length >= minNeeded || !lead.name || !lead.city) return [];

  let candidates = [];
  try {
    candidates = await scrapeGoogleMaps({ category: lead.name, city: lead.city, state: lead.state, limit: 3, detail: "full" });
  } catch (e) {
    console.log(`[morephotos] lookup failed (${e.message})`);
    return [];
  }

  // Confident match requires sharing the DISTINCTIVE (brand) part of the name — not just the
  // trade word. Otherwise "ABC Landscaping" wrongly matches "XYZ Landscaping" and we'd pull a
  // COMPETITOR's photos into the preview. Better to fetch no extra photos than the wrong ones.
  const leadName = sig(lead.name);
  const leadDist = new Set(distinctive(lead.name));
  const best = candidates
    .map((c) => {
      const candAll = new Set(sig(c.name));
      const sharedDistinct = [...leadDist].filter((w) => candAll.has(w)).length;
      const sharedAny = leadName.filter((w) => candAll.has(w)).length;
      return { c, sharedDistinct, sharedAny };
    })
    .sort((a, b) => b.sharedDistinct - a.sharedDistinct || b.sharedAny - a.sharedAny)[0];

  // Require a real brand-name overlap. If the lead name is purely generic (no distinctive
  // words at all), demand that essentially the whole name matches instead.
  const ok = best && (
    best.sharedDistinct >= 1 ||
    (leadDist.size === 0 && best.sharedAny >= Math.max(2, leadName.length))
  );
  if (!ok) {
    console.log(`[morephotos] ${lead.name}: no confident Google match (need a brand-name overlap) — skipping to avoid wrong photos`);
    return [];
  }

  const existing = new Set(have);
  const extra = (best.c.images || []).filter((u) => u && !existing.has(u));
  console.log(`[morephotos] ${lead.name}: +${extra.length} photos from Google match "${best.c.name}"`);
  return extra;
}
