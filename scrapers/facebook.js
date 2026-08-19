// facebook.js — enriches qualified (no-website) leads with data from their Facebook page,
// mainly the EMAIL (which Google Maps usually lacks) plus extra photos and an "about" blurb.
//
// How we find a lead's FB page: many no-website businesses list their Facebook page as their
// "website" on Google, or it shows up as a social link. If we have a FB URL, we scrape it.
// (Leads with no discoverable FB page are left as-is — no email found.)

import { ApifyClient } from "apify-client";
import { normalizeFacebookPage } from "./normalize.js";
import { latestEpoch } from "../lib/freshness.js";
import "dotenv/config";

const ACTOR = process.env.APIFY_FACEBOOK_ACTOR || "apify/facebook-pages-scraper";
const POSTS_ACTOR = process.env.APIFY_FACEBOOK_POSTS_ACTOR || "apify/facebook-posts-scraper";

// Read each page's most-recent POST date (the real "still active?" signal). Sets
// lead.lastActivity (epoch ms) in place. The pages-scraper can't do this — it returns
// no posts — so the freshness deep-check uses this dedicated posts actor instead.
export async function enrichFacebookActivity(leads) {
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN missing.");
  const targets = [];
  for (const lead of leads) {
    const url = facebookUrlFor(lead);
    if (url) targets.push({ url, lead });
  }
  if (!targets.length) return { dated: 0 };

  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const startUrls = [...new Set(targets.map((t) => t.url))].map((url) => ({ url }));
  console.log(`[fb-posts] reading last-post date for ${startUrls.length} page(s)…`);

  const run = await client.actor(POSTS_ACTOR).call({ startUrls, resultsLimit: 3 });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // The posts actor returns one row PER POST. Group by the originating page URL and
  // keep the newest timestamp. Field names vary, so we check several defensively.
  const newestByUrl = new Map();
  for (const it of items) {
    const pageUrl =
      it.pageUrl || it.facebookUrl || it.topLevelUrl || it.inputUrl || it.url || it.pageInfo?.url || it.user?.url;
    const t = latestEpoch([it.time, it.timestamp, it.date, it.publishTime, it.postedAt, it.publishedAt]);
    if (!pageUrl || t == null) continue;
    const k = normUrl(pageUrl);
    if (!newestByUrl.has(k) || t > newestByUrl.get(k)) newestByUrl.set(k, t);
  }

  let dated = 0;
  for (const { url, lead } of targets) {
    const t = newestByUrl.get(normUrl(url));
    if (t != null) {
      lead.lastActivity = t;
      dated++;
    }
  }
  console.log(`[fb-posts] dated ${dated}/${targets.length} page(s).`);
  return { dated };
}

// Scrape ONE Facebook page by URL → a full normalized lead.
// Used by the "Manual" tab when you paste a business's Facebook URL yourself.
export async function scrapeFacebookPage(url) {
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN missing.");
  if (!isFacebookUrl(url)) throw new Error("That doesn't look like a Facebook page URL.");
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  console.log(`[fb] scraping single page: ${url}`);
  const run = await client.actor(ACTOR).call({ startUrls: [{ url }] });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items.length) {
    throw new Error("Couldn't read that Facebook page — it may be private, deleted, or the URL is wrong.");
  }
  return normalizeFacebookPage(items[0], url);
}

function isFacebookUrl(u = "") {
  return /facebook\.com|fb\.com/i.test(u);
}

// Best guess at a lead's Facebook page URL from what we already scraped.
export function facebookUrlFor(lead) {
  if (isFacebookUrl(lead.fbUrl) && lead.fbUrl !== "#") return lead.fbUrl;
  if (isFacebookUrl(lead.website)) return lead.website;
  return null;
}

// Normalize a Facebook page record into the fields we care about (defensive about field names).
function normalizeFbPage(p) {
  const photos = [];
  for (const k of ["coverPhotoUrl", "profilePhotoUrl", "profilePictureUrl"]) {
    if (p[k]) photos.push(p[k]);
  }
  if (Array.isArray(p.images)) photos.push(...p.images.map((i) => i.url || i).filter(Boolean));

  // Newest post date on the page → "still active?" signal for the freshness filter.
  const postDates = Array.isArray(p.posts)
    ? p.posts.map((x) => x.time || x.date || x.timestamp || x.publishTime)
    : [];

  return {
    fbUrl: p.pageUrl || p.url || p.facebookUrl || null,
    email: (Array.isArray(p.email) ? p.email[0] : p.email) || "",
    about: p.intro || p.info || p.about || p.pageIntro || "",
    phone: p.phone || "",
    photos,
    lastActivity: latestEpoch([...postDates, p.lastPostDate, p.latestPost?.time, p.lastActive]),
  };
}

function normUrl(u = "") {
  return u.toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "");
}

/**
 * Enrich leads in place: scrape each lead's FB page (if known) and merge in email/photos/about.
 * Returns { enriched: number, emailsFound: number }.
 */
export async function enrichWithFacebook(leads) {
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN missing.");

  // Map FB URL → lead(s) to update.
  const targets = [];
  for (const lead of leads) {
    const url = facebookUrlFor(lead);
    if (url) targets.push({ url, lead });
  }
  if (!targets.length) {
    console.log("[fb] no Facebook pages to look up.");
    return { enriched: 0, emailsFound: 0 };
  }

  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const startUrls = [...new Set(targets.map((t) => t.url))].map((url) => ({ url }));
  console.log(`[fb] scraping ${startUrls.length} Facebook page(s)…`);

  // The Pages Scraper returns page details (email/photos/website/etc.) but NOT posts —
  // last-post dates come from the separate Posts Scraper (enrichFacebookActivity).
  const run = await client.actor(ACTOR).call({ startUrls });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // Index scraped pages by normalized URL.
  const byUrl = new Map();
  for (const item of items) {
    const fb = normalizeFbPage(item);
    if (fb.fbUrl) byUrl.set(normUrl(fb.fbUrl), fb);
  }

  let enriched = 0;
  let emailsFound = 0;
  for (const { url, lead } of targets) {
    const fb = byUrl.get(normUrl(url));
    if (!fb) continue;
    enriched++;
    lead.fbUrl = fb.fbUrl || lead.fbUrl;
    if (fb.email && !lead.email) {
      lead.email = fb.email;
      emailsFound++;
    }
    if (fb.about && !lead.about) lead.about = fb.about;
    if (fb.phone && !lead.phone) lead.phone = fb.phone;
    if (fb.photos.length) lead.images = [...(lead.images || []), ...fb.photos];
    if (fb.lastActivity && !lead.lastActivity) lead.lastActivity = fb.lastActivity;
  }

  console.log(`[fb] enriched ${enriched} lead(s), found ${emailsFound} new email(s).`);
  return { enriched, emailsFound };
}
