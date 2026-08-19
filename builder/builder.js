// builder.js — drives your real Site Flash HTML headlessly to produce a finished preview site.
//
// How it works: Site Flash's core is a pure function `buildSite(data)` that takes a plain
// object of business info and returns a complete website as an HTML string. We load your
// actual siteflash.html in an invisible browser and call that function with scraped data.
// No copy-pasting your builder code, and it keeps working when you ship a new Site Flash version.

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITEFLASH_HTML = join(__dirname, "siteflash.html");

let _browser = null;
let _page = null;

// Reuse one browser/page across many builds (fast for batch runs).
async function getPage() {
  if (_page) return _page;
  _browser = await chromium.launch({ headless: true });
  _page = await _browser.newPage();
  await _page.goto("file://" + SITEFLASH_HTML, { waitUntil: "load" });
  // Sanity check: confirm the builder function exists in the page.
  const hasFn = await _page.evaluate(() => typeof buildSite === "function");
  if (!hasFn) {
    throw new Error(
      "buildSite() not found in siteflash.html — the builder may have changed. " +
        "Check builder/siteflash.html."
    );
  }
  return _page;
}

/**
 * Build a finished preview website from a Site Flash data object.
 * @param {object} data - shape that buildSite() expects (see mapper.js).
 * @returns {Promise<string>} complete standalone HTML for the preview site.
 */
export async function buildPreviewHtml(data) {
  const page = await getPage();
  const html = await page.evaluate((d) => buildSite(d), data);
  if (!html || typeof html !== "string") {
    throw new Error("buildSite() returned no HTML.");
  }
  return html;
}

/** Build and save a preview to a file. Returns the file path. */
export async function savePreview(data, outPath) {
  const html = await buildPreviewHtml(data);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  return outPath;
}

export async function closeBuilder() {
  if (_browser) await _browser.close();
  _browser = _page = null;
}

// ── CLI test: `node builder/builder.js` builds a sample preview and opens it ──
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sample = {
    name: "Joe's Pizza",
    niche: "Pizzeria",
    tagline: "The Best Slice in Town",
    cityState: "Knoxville, TN",
    phone: "(865) 555-0199",
    email: "hello@joespizza.com",
    desc: "Hand-tossed, wood-fired pizza made fresh daily by a family that loves what they do.",
    aboutText:
      "Joe's Pizza has served Knoxville for over 15 years. We use fresh, local ingredients and old-world recipes to bring you the best slice in town.",
    baText: "We Are: Joe's Pizza",
    primary: "#F5A623",
    dark: "#111111",
    why: [
      { title: "15+ Years Serving Knoxville", desc: "A local family favorite you can trust." },
      { title: "Fresh, Local Ingredients", desc: "Dough made daily, never frozen." },
      { title: "Fast Delivery", desc: "Hot pizza to your door in 30 minutes or less." },
    ],
    serviceAreas: ["Knoxville", "Maryville", "Oak Ridge", "Farragut"],
    fbUrl: "#",
    igUrl: "#",
    elfsight: "",
    logoURL: null,
    heroURL: null,
    ctaURL: null,
    beforeURL: null,
    afterURL: null,
    galleryURLs: [],
    services: [
      { name: "Dine In", imgURL: null },
      { name: "Takeout", imgURL: null },
      { name: "Catering", imgURL: null },
    ],
  };

  const out = join(__dirname, "..", "data", "previews", "sample.html");
  console.log("Building sample preview…");
  savePreview(sample, out)
    .then(async (p) => {
      console.log("✅ Built:", p);
      await closeBuilder();
      console.log("Open it with:  open '" + p + "'");
    })
    .catch(async (e) => {
      console.error("❌ Build failed:", e.message);
      await closeBuilder();
      process.exit(1);
    });
}
