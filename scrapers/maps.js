// maps.js — scrapes Google Business Profiles via the Apify "crawler-google-places" actor.
//
// Two detail levels (to save money — see run.js two-pass strategy):
//   detail: "basic"  → name, category, website, phone. NO photos, NO contact crawl. Cheap.
//   detail: "full"   → adds photos + email/socials (visits the site). More expensive.
//
// Usage:
//   await scrapeGoogleMaps({ category, city, state, limit, detail: "basic" })   // discovery
//   await scrapeGooglePlacesByIds(placeIds, { detail: "full" })                 // enrich winners

import { ApifyClient } from "apify-client";
import { normalizeGooglePlace } from "./normalize.js";
import { latestEpoch } from "../lib/freshness.js";
import "dotenv/config";

const ACTOR = process.env.APIFY_MAPS_ACTOR || "compass/crawler-google-places";

function client() {
  if (!process.env.APIFY_TOKEN) {
    throw new Error("APIFY_TOKEN missing — copy .env.example to .env and fill it in.");
  }
  return new ApifyClient({ token: process.env.APIFY_TOKEN });
}

// Detail level → actor options that drive cost.
function detailOpts(detail) {
  if (detail === "full") return { scrapeContacts: true, maxImages: 8 };
  return { scrapeContacts: false, maxImages: 0 }; // "basic" (default) — cheapest
}

export async function scrapeGoogleMaps({ category, city, state, limit = 40, detail = "basic" }) {
  const location = [city, state].filter(Boolean).join(", ");
  const searchString = `${category} in ${location}`;

  const input = {
    searchStringsArray: [searchString],
    maxCrawledPlacesPerSearch: limit,
    language: "en",
    skipClosedPlaces: true,
    ...detailOpts(detail),
  };

  console.log(`[maps] ${detail} scan: "${searchString}" (up to ${limit})…`);
  const run = await client().actor(ACTOR).call(input);
  const { items } = await client().dataset(run.defaultDatasetId).listItems();
  console.log(`[maps] got ${items.length} places.`);

  return items.map((it) => normalizeGooglePlace(it, location));
}

// Re-scrape specific places (by Google placeId) WITH full detail. Used to enrich
// only the qualified, no-website leads — so we never pay for photos/email on
// businesses we're discarding.
export async function scrapeGooglePlacesByIds(placeIds, { detail = "full" } = {}) {
  const ids = placeIds.filter(Boolean);
  if (!ids.length) return [];

  const input = {
    placeIds: ids,
    language: "en",
    ...detailOpts(detail),
  };

  console.log(`[maps] enriching ${ids.length} qualified place(s) with ${detail} detail…`);
  const run = await client().actor(ACTOR).call(input);
  const { items } = await client().dataset(run.defaultDatasetId).listItems();
  return items.map((it) => normalizeGooglePlace(it));
}

// Date Google leads by their NEWEST review (Google has no "posts"). Re-scrapes the given
// leads by placeId pulling just the latest review, and sets lead.lastActivity in place.
// Used by the activity filter's "Google deep-check" so Maps leads get a real 2026 check.
export async function enrichGoogleActivity(leads) {
  const targets = leads.filter((l) => l.placeId);
  if (!targets.length) return { dated: 0 };

  const input = {
    placeIds: targets.map((l) => l.placeId),
    language: "en",
    maxReviews: 1,
    reviewsSort: "newest",
    scrapeContacts: false,
    maxImages: 0,
  };
  console.log(`[g-reviews] dating ${targets.length} Google place(s) by newest review…`);
  const run = await client().actor(ACTOR).call(input);
  const { items } = await client().dataset(run.defaultDatasetId).listItems();

  const byId = new Map();
  for (const it of items) {
    const pid = it.placeId || it.cid;
    const dates = Array.isArray(it.reviews) ? it.reviews.map((r) => r.publishedAtDate || r.publishAt || r.date) : [];
    const t = latestEpoch(dates);
    if (pid && t != null) byId.set(pid, t);
  }

  let dated = 0;
  for (const lead of targets) {
    const t = byId.get(lead.placeId);
    if (t != null) {
      lead.lastActivity = t;
      dated++;
    }
  }
  console.log(`[g-reviews] dated ${dated}/${targets.length}.`);
  return { dated };
}
