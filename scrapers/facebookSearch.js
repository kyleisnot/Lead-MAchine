// facebookSearch.js — Facebook AS A LEAD SOURCE.
// "Go to Facebook and look up landscaping in Knoxville, TN" → returns business pages,
// each already including whether they have a website + their email. No website = a lead.

import { ApifyClient } from "apify-client";
import { normalizeFacebookSearch } from "./normalize.js";
import "dotenv/config";

const ACTOR = process.env.APIFY_FACEBOOK_SEARCH_ACTOR || "apify/facebook-search-scraper";

export async function searchFacebook({ category, city, state, limit = 30 }) {
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN missing.");
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

  const location = [city, state].filter(Boolean).join(", ");
  console.log(`[fb-search] "${category}" in ${location} (up to ${limit})…`);

  const run = await client.actor(ACTOR).call({
    categories: [category],
    locations: location ? [location] : [],
    resultsLimit: limit,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[fb-search] got ${items.length} Facebook pages.`);

  return items.map((it) => normalizeFacebookSearch(it, location));
}
