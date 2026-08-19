// normalize.js — converts raw Apify actor output into our standard "lead" shape,
// so the rest of the app never has to care which scraper the data came from.
//
// Standard lead shape:
// {
//   source, externalId, name, category, city, state, phone, email, website,
//   about, images: [url...], logo, fbUrl, igUrl, serviceAreas: [..], rating, reviews
// }

import { pickBestWebsite } from "./filter.js";
import { latestEpoch } from "../lib/freshness.js";

// Split "Knoxville, TN" / "Knoxville, Tennessee, USA" into city + state.
function splitCityState(str = "") {
  const parts = str.split(",").map((s) => s.trim()).filter(Boolean);
  return { city: parts[0] || "", state: parts[1] || "" };
}

// ── Google Maps (compass/crawler-google-places) ──
export function normalizeGooglePlace(item, fallbackLocation = "") {
  const loc = splitCityState(item.city ? `${item.city}, ${item.state || ""}` : fallbackLocation);
  const images = [];
  if (item.imageUrls?.length) images.push(...item.imageUrls);
  else if (item.imageUrl) images.push(item.imageUrl);

  // The Maps actor sometimes surfaces social links under additionalInfo or in the website.
  const fbUrl = pickSocial(item, "facebook");
  const igUrl = pickSocial(item, "instagram");

  return {
    source: "google_maps",
    externalId: item.placeId || item.cid || item.url || item.title,
    placeId: item.placeId || null,
    name: item.title || item.name || "",
    category: item.categoryName || (item.categories && item.categories[0]) || "Local Business",
    city: item.city || loc.city,
    state: item.state || loc.state,
    phone: item.phone || item.phoneUnformatted || "",
    email: firstEmail(item.emails) || item.email || "",
    website: cleanWebsite(item.website),
    about: item.description || "",
    images,
    logo: null,
    fbUrl: fbUrl || "#",
    igUrl: igUrl || "#",
    serviceAreas: [],
    rating: item.totalScore ?? null,
    reviews: item.reviewsCount ?? null,
    // Google has no "posts" — best we can do is the newest review date (only present if reviews were scraped).
    lastActivity: latestEpoch(
      Array.isArray(item.reviews) ? item.reviews.map((r) => r.publishedAtDate || r.publishAt || r.date) : []
    ),
  };
}

// ── Facebook Search (apify/facebook-search-scraper) ──
// Returns business pages matching a query+location, with website + email already included.
export function normalizeFacebookSearch(item, fallbackLocation = "") {
  const loc = splitCityState(item.address || fallbackLocation);
  // Facebook lists several links per page — pick the real website if any exists,
  // so a business with a real site (listed 2nd behind Instagram) isn't mis-qualified.
  const candidates = [].concat(item.websites || [], item.website || []);
  const website = pickBestWebsite(candidates);

  const images = [];
  for (const k of ["coverPhotoUrl", "profilePhoto", "profilePictureUrl"]) {
    if (item[k]) images.push(item[k]);
  }

  return {
    source: "facebook",
    externalId: item.pageId || item.facebookId || item.pageUrl || item.facebookUrl || item.title,
    placeId: null,
    name: item.title || item.pageName || "",
    category: item.category || (Array.isArray(item.categories) ? item.categories[0] : "") || "Local Business",
    city: loc.city,
    state: loc.state,
    phone: item.phone || "",
    email: firstEmail(item.email),
    website: cleanWebsite(website),
    about: item.intro || item.info || "",
    images,
    logo: item.profilePhoto || item.profilePictureUrl || null,
    fbUrl: item.pageUrl || item.facebookUrl || "#",
    igUrl: "#",
    serviceAreas: [],
    rating: item.rating ?? null,
    reviews: item.ratingCount ?? null,
    lastActivity: latestEpoch([
      item.lastPostDate, item.latestPostDate, item.latestPost?.time, item.lastActive,
      ...(Array.isArray(item.posts) ? item.posts.map((p) => p.time || p.date || p.timestamp) : []),
    ]),
  };
}

// ── A SINGLE Facebook page (apify/facebook-pages-scraper) ──
// Used by the "Manual" tab: you paste one business's Facebook URL and we build the full lead.
export function normalizeFacebookPage(item, sourceUrl = "") {
  const loc = splitCityState(
    [item.addressDetails?.city, item.addressDetails?.region].filter(Boolean).join(", ") ||
      item.address ||
      ""
  );
  const candidates = [].concat(item.websites || [], item.website || []);
  const website = pickBestWebsite(candidates);

  const images = [];
  for (const k of ["coverPhotoUrl", "profilePhoto", "profilePictureUrl"]) {
    if (item[k]) images.push(item[k]);
  }
  if (Array.isArray(item.images)) images.push(...item.images.map((i) => i.url || i).filter(Boolean));

  const fbUrl = item.pageUrl || item.url || item.facebookUrl || sourceUrl || "#";
  const infoText = Array.isArray(item.info) ? item.info.join(" · ") : item.info || "";

  return {
    source: "facebook",
    externalId: item.pageId || item.facebookId || fbUrl,
    placeId: null,
    name: item.title || item.pageName || item.name || "",
    category: item.category || (Array.isArray(item.categories) ? item.categories[0] : "") || "Local Business",
    city: loc.city,
    state: loc.state,
    phone: item.phone || item.phoneNumber || "",
    email: firstEmail(item.email) || extractEmail(infoText),
    website: cleanWebsite(website),
    about: item.intro || infoText || item.about || "",
    images: [...new Set(images)],
    logo: item.profilePhoto || item.profilePictureUrl || null,
    fbUrl,
    igUrl: "#",
    serviceAreas: [],
    rating: item.rating ?? null,
    reviews: item.followers ?? item.likes ?? null,
    lastActivity: latestEpoch([
      item.lastPostDate, item.latestPost?.time, item.lastActive,
      ...(Array.isArray(item.posts) ? item.posts.map((p) => p.time || p.date || p.timestamp || p.publishTime) : []),
    ]),
  };
}

function firstEmail(emails) {
  if (Array.isArray(emails)) return emails[0] || "";
  return emails || "";
}

// Pull an email out of free text (e.g. an Instagram bio) if present.
export function extractEmail(text = "") {
  const m = String(text).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : "";
}

// ── Instagram (apify/instagram-scraper, resultsType "details") ──
export function normalizeInstagramProfile(item, fallbackLocation = "") {
  const loc = splitCityState(fallbackLocation);
  const website = pickBestWebsite([].concat(item.externalUrls?.map((u) => u.url || u) || [], item.externalUrl || []));

  const images = [];
  if (Array.isArray(item.latestPosts)) {
    for (const p of item.latestPosts) {
      const u = p.displayUrl || p.imageUrl || (Array.isArray(p.images) ? p.images[0] : null);
      if (u) images.push(u);
    }
  }
  const logo = item.profilePicUrlHD || item.profilePicUrl || null;

  return {
    source: "instagram",
    externalId: item.id || item.username,
    placeId: null,
    name: item.fullName || item.username || "",
    category: item.businessCategoryName || "Local Business",
    city: loc.city,
    state: loc.state,
    phone: item.businessPhoneNumber || "",
    email: item.businessEmail || item.publicEmail || extractEmail(item.biography),
    website: cleanWebsite(website),
    about: item.biography || "",
    images: images.slice(0, 8),
    logo,
    // The linked Facebook page lets us fetch the email later (the "FB bridge").
    fbUrl: item.facebookPage || "#",
    igUrl: item.url || (item.username ? `https://instagram.com/${item.username}` : "#"),
    serviceAreas: [],
    rating: null,
    reviews: item.followersCount ?? null,
    // Instagram is the reliable signal: newest post timestamp from the profile's latest posts.
    lastActivity: latestEpoch(
      Array.isArray(item.latestPosts)
        ? item.latestPosts.map((p) => p.timestamp || p.takenAtTimestamp || p.taken_at_timestamp)
        : []
    ),
  };
}

// Some "websites" on Google profiles are actually just social/booking links.
// Treat those as NOT a real website (the filter decides; we just clean obvious junk).
function cleanWebsite(url) {
  if (!url) return "";
  return String(url).trim();
}

function pickSocial(item, network) {
  const candidates = [item.website, ...(item.additionalInfo ? Object.values(item.additionalInfo).flat() : [])]
    .filter((v) => typeof v === "string");
  return candidates.find((v) => v.toLowerCase().includes(network + ".com")) || "";
}
