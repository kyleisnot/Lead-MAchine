// instagram.js — Instagram AS A LEAD SOURCE.
// Searches Instagram for business profiles matching a niche + city, returns their
// website link (so we can detect no-website ones), photos, bio, and any linked Facebook page.
// (Instagram rarely exposes emails directly — we recover those via bio text or the FB bridge.)

import { ApifyClient } from "apify-client";
import { normalizeInstagramProfile } from "./normalize.js";
import "dotenv/config";

const ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || "apify/instagram-scraper";

export async function searchInstagram({ category, city, state, limit = 20 }) {
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN missing.");
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

  const location = [city, state].filter(Boolean).join(", ");
  const query = `${category} ${city || ""}`.trim();
  console.log(`[ig] searching "${query}" (up to ${limit})…`);

  const run = await client.actor(ACTOR).call({
    search: query,
    searchType: "user",
    searchLimit: limit,
    resultsType: "details",
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[ig] got ${items.length} profiles.`);

  return items
    .filter((it) => it.username) // skip non-profile rows
    .map((it) => normalizeInstagramProfile(it, location));
}
