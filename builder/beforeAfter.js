// beforeAfter.js — ensures every preview has a clean Before/After pair.
// Tiers:
//   1. Real pair    — the curator already found before/after in the scraped photos.
//   2. Real after + AI before — take a real finished-work photo as the "After" and have
//      OpenAI generate a matching worn "Before" of the same scene. (best: keeps after real)
//   3. Fully AI pair — only if there are no usable photos at all.
//
// Generated images are returned as data URLs so they work locally AND on Cloudflare with
// no extra hosting. No-ops (returns null) if OPENAI_API_KEY is missing.

import "dotenv/config";

const QUALITY = process.env.IMAGE_QUALITY || "high"; // gpt-image-1: low | medium | high
const SIZE = "1536x1024"; // landscape, good for a website before/after

function openaiEnabled() {
  return !!process.env.OPENAI_API_KEY;
}

// Trade-specific scene language so the AI before/after actually looks like the right work.
function tradeScene(niche = "") {
  const c = niche.toLowerCase();
  if (/(landscap|lawn|garden|sod|irrigation)/.test(c))
    return { subject: "a residential front yard", before: "overgrown, patchy, weedy, and neglected", after: "a lush, professionally landscaped yard with healthy green grass and clean edging" };
  if (/(tree)/.test(c)) return { subject: "a yard with large trees", before: "overgrown, dead, and hazardous branches", after: "neatly trimmed, healthy, well-maintained trees" };
  if (/(hardscap|paver|patio)/.test(c)) return { subject: "a backyard patio area", before: "cracked, uneven, weed-filled old pavers", after: "a beautiful new paver patio, level and clean" };
  if (/(concrete|cement|mason)/.test(c)) return { subject: "a residential driveway", before: "cracked, stained, crumbling old concrete", after: "a smooth, freshly poured clean concrete driveway" };
  if (/(roof)/.test(c)) return { subject: "a house roof", before: "old, damaged, with missing and curling shingles", after: "a brand-new, flawless shingle roof" };
  if (/(pressure|power wash|soft wash)/.test(c)) return { subject: "a driveway and house siding", before: "dirty, grimy, covered in mildew and stains", after: "spotless and clean after pressure washing" };
  if (/(detail|car wash|auto)/.test(c)) return { subject: "a car", before: "dirty, dusty, covered in grime", after: "spotless, glossy, professionally detailed and shining" };
  if (/(fenc)/.test(c)) return { subject: "a backyard fence", before: "old, broken, weathered, leaning", after: "a brand-new, straight, well-built fence" };
  if (/(garage door)/.test(c)) return { subject: "a residential garage door", before: "old, dented, faded, rusty", after: "a new, modern, clean garage door" };
  return null; // e.g. pest control — no meaningful visual before/after
}

async function openai(path, body, isForm = false) {
  const res = await fetch("https://api.openai.com/v1/images/" + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...(isForm ? {} : { "Content-Type": "application/json" }) },
    body: isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image returned");
  return `data:image/png;base64,${b64}`;
}

// Generate a fresh image from a text prompt.
async function generate(prompt) {
  return openai("generations", { model: "gpt-image-1", prompt, size: SIZE, quality: QUALITY, n: 1 });
}

// Generate a "before" by editing a real "after" photo (keeps the same scene).
async function editToBefore(afterUrl, scene) {
  const imgRes = await fetch(afterUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) throw new Error("could not fetch after photo");
  const blob = await imgRes.blob();
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("image", blob, "after.png");
  form.append("size", SIZE);
  form.append("quality", QUALITY);
  form.append(
    "prompt",
    `Edit this photo to look like a "before" version — but keep it SUBTLE and realistic. ` +
      `Keep the EXACT same background, location, subject, composition, angle, framing, and lighting unchanged. ` +
      `Only add a light, believable layer of everyday dust, dirt, and dullness to the ${scene.subject} — ` +
      `as if it simply needs a cleaning/service. Do NOT make it muddy, damaged, broken, or dramatically different. ` +
      `It should clearly be the same scene, just a bit dusty and dull. Photorealistic, clear, well-lit.`
  );
  return openai("edits", form, true);
}

/**
 * @param {{ curated: object|null, lead: object }}
 * @returns {Promise<{before:string, after:string}|null>}
 */
export async function ensureBeforeAfter({ curated, lead }) {
  // Tier 1: real pair already found (both photos are genuine — not synthetic).
  if (curated?.before && curated?.after) return { before: curated.before, after: curated.after, cost: 0, synthetic: false };
  if (!openaiEnabled()) return null;

  const scene = tradeScene(lead.category);
  if (!scene) return null; // no sensible before/after for this trade

  // The best real "after" photo we have, if any.
  const realAfter = curated?.hero || (curated?.gallery || [])[0] || (lead.images || [])[0] || null;

  const PER_IMG = 0.17; // rough gpt-image-1 high cost per image
  try {
    if (realAfter) {
      // Tier 2: real after + AI before (the "before" is AI-generated → mark synthetic).
      const before = await editToBefore(realAfter, scene);
      console.log(`[ba] ${lead.name}: generated AI "before" for a real "after"`);
      return { before, after: realAfter, cost: PER_IMG, synthetic: true };
    }
    // Tier 3: fully AI pair (both images AI-generated → synthetic).
    const [before, after] = await Promise.all([
      generate(`A photorealistic image of ${scene.subject} that is ${scene.before}. Natural daylight, clear, high quality.`),
      generate(`A photorealistic image of ${scene.subject}: ${scene.after}. Bright, clean, high quality, professional.`),
    ]);
    console.log(`[ba] ${lead.name}: generated a full AI before/after pair`);
    return { before, after, cost: PER_IMG * 2, synthetic: true };
  } catch (e) {
    console.log(`[ba] ${lead.name}: skipped (${e.message})`);
    return null;
  }
}
