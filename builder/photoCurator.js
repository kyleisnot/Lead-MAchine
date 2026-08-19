// photoCurator.js — uses Claude's vision to look at a business's scraped photos and decide
// WHAT each one is and WHERE it should go on the site: logo, hero, gallery, before/after, or skip.
// This fixes the core problem of the builder dumping random photos into fixed slots.
//
// Returns: { hero, logo, before, after, gallery: [url...], labels: [{url, role, quality, caption}] }
// or null if there's nothing to curate / no API key (the builder then falls back to naive ordering).

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const MAX_IMAGES = 12; // cap per business to control cost/latency

// JSON schema the model must return — one classification per image.
const SCHEMA = {
  type: "object",
  properties: {
    photos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "the image number shown" },
          role: {
            type: "string",
            enum: ["logo", "hero", "gallery", "before", "after", "skip"],
            description:
              "logo=brand mark/text logo; hero=single best wide finished-work shot for the top banner; gallery=good finished-work/project photos; before/after=a matched renovation pair; skip=blurry, selfie, meme, screenshot, stock, or irrelevant",
          },
          quality: { type: "integer", description: "1=bad, 5=excellent for a marketing website" },
          caption: { type: "string", description: "3-6 word description" },
        },
        required: ["index", "role", "quality", "caption"],
        additionalProperties: false,
      },
    },
    best_hero_index: { type: "integer", description: "index of the single best hero image, or -1 if none" },
  },
  required: ["photos", "best_hero_index"],
  additionalProperties: false,
};

export function curatorEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Download an image ourselves (Claude can't fetch FB/IG URLs — they're robots.txt-blocked)
// and return it as a base64 block Claude's vision accepts. Skips non-images / too-large / failures.
async function fetchImageBlock(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(jpeg|png|gif|webp)$/.test(ct)) return null; // skip HTML/photo-pages
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4.5 * 1024 * 1024) return null; // Claude ~5MB/image limit
    return { type: "image", source: { type: "base64", media_type: ct, data: buf.toString("base64") } };
  } catch {
    return null;
  }
}

/**
 * @param {{ images: string[], name: string, category: string }} lead-ish
 * @returns {Promise<object|null>}
 */
export async function curatePhotos({ images = [], name = "", category = "" }) {
  const urls = [...new Set(images.filter(Boolean))].slice(0, MAX_IMAGES);
  if (!curatorEnabled() || urls.length === 0) return null;

  const client = new Anthropic();

  // Download all images ourselves, keep only the ones that fetched as real images.
  const fetched = await Promise.all(urls.map((u) => fetchImageBlock(u)));
  const usable = []; // [{ url, block }]
  urls.forEach((url, i) => {
    if (fetched[i]) usable.push({ url, block: fetched[i] });
  });
  if (usable.length === 0) {
    console.log(`[curator] ${name}: no downloadable images — using naive order`);
    return null;
  }

  // Build the message: a numbered image for each downloaded photo, then instructions.
  const content = [];
  usable.forEach(({ block }, i) => {
    content.push({ type: "text", text: `Image ${i}:` });
    content.push(block);
  });
  content.push({
    type: "text",
    text:
      `These are photos scraped for "${name}", a ${category} business, to build them a marketing website.\n` +
      `Classify EACH image by index. Pick the single best wide, attractive, finished-work photo as the hero. ` +
      `Mark logos as "logo". Put other strong finished-work photos in "gallery". If you can find a clear ` +
      `before/after renovation pair, label them "before" and "after". Mark anything blurry, dark, a selfie, ` +
      `a screenshot, a meme, a stock photo, or irrelevant as "skip". Return every image's index exactly once.`,
  });

  let parsed;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
    const text = res.content.find((b) => b.type === "text")?.text || "{}";
    parsed = JSON.parse(text);
  } catch (e) {
    console.log(`[curator] vision failed (${e.message}) — using naive photo order`);
    return null;
  }

  // Turn the per-image labels into slot assignments (indices map to the downloaded set).
  const labels = (parsed.photos || [])
    .filter((p) => usable[p.index] != null)
    .map((p) => ({ url: usable[p.index].url, role: p.role, quality: p.quality, caption: p.caption }));

  const byRole = (role) => labels.filter((l) => l.role === role).sort((a, b) => b.quality - a.quality);

  const heroFromIndex = usable[parsed.best_hero_index]?.url;
  const heroes = byRole("hero");
  const hero = heroFromIndex || heroes[0]?.url || byRole("gallery")[0]?.url || null;

  const gallery = [...byRole("gallery"), ...heroes]
    .map((l) => l.url)
    .filter((u) => u !== hero)
    .slice(0, 10);

  const result = {
    hero,
    logo: byRole("logo")[0]?.url || null,
    before: byRole("before")[0]?.url || null,
    after: byRole("after")[0]?.url || null,
    gallery,
    labels,
  };
  const kept = labels.filter((l) => l.role !== "skip").length;
  console.log(`[curator] ${name}: kept ${kept}/${labels.length} photos (hero${hero ? " ✓" : " ✗"}, ${gallery.length} gallery)`);
  return result;
}
