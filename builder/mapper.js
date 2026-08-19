// mapper.js — turns a normalized scraped business ("lead") into the data object
// that Site Flash's buildSite() expects. This is the bridge between scraping and building.
//
// Normalized lead shape (what scrapers produce — see scrapers/normalize.js):
// {
//   name, category, city, state, phone, email, website,
//   about, images: [url...], logo, fbUrl, igUrl, serviceAreas: [..]
// }

const DEFAULT_PRIMARY = "#F5A623";
const DEFAULT_DARK = "#111111";

// Pick the best hero photo (first decent image), keep the rest for the gallery.
function splitImages(images = []) {
  const clean = (images || []).filter(Boolean);
  return {
    hero: clean[0] || null,
    cta: clean[1] || clean[0] || null,
    gallery: clean.slice(0, 10),
  };
}

// Site Flash shows 3 services with images. We rarely get a real service list from a
// Maps/FB scrape, so we derive sensible names from the category and reuse scraped photos.
function deriveServices(category, images = []) {
  const c = (category || "").toLowerCase();
  let names;
  if (/(restaurant|pizz|cafe|food|bar|grill|bakery)/.test(c)) {
    names = ["Dine In", "Takeout", "Catering"];
  } else if (/(salon|barber|spa|nail|hair|beauty)/.test(c)) {
    names = ["Haircuts & Styling", "Color & Treatments", "Walk-Ins Welcome"];
  } else if (/(detail|car wash|auto)/.test(c)) {
    names = ["Interior Detailing", "Exterior & Wash", "Ceramic Coating"];
  } else if (
    /(roof|construct|remodel|deck|patio|concrete|cement|contractor|landscap|lawn|tree|paint|plumb|hvac|electric|hardscap|paver|fenc|garage door|pest|exterminat|termite|pressure wash|power wash|soft wash)/.test(c)
  ) {
    names = ["Free Estimates", "Residential Work", "Commercial Work"];
  } else {
    names = ["Our Services", "Quality Work", "Get a Quote"];
  }
  return names.map((name, i) => ({ name, imgURL: images[i] || null }));
}

// Build a short hero description from the longer "about" text.
function shortDesc(about, category, city) {
  if (about) {
    const firstSentence = about.split(/(?<=[.!?])\s/)[0];
    return firstSentence.length > 160 ? firstSentence.slice(0, 157) + "…" : firstSentence;
  }
  const what = category || "service";
  return `Your trusted local ${what.toLowerCase()}${city ? ` serving ${city}` : ""}. Quality work, honest pricing, friendly service.`;
}

/**
 * @param {object} lead - normalized scraped business
 * @param {object|null} curated - optional AI photo assignments from photoCurator.js
 * @returns {object} data object for buildSite()
 */
export function mapLeadToSiteData(lead, curated = null) {
  const {
    name = "Your Business",
    category = "Local Business",
    city = "",
    state = "",
    phone = "",
    email = "",
    about = "",
    images = [],
    logo = null,
    fbUrl = "#",
    igUrl = "#",
    serviceAreas = [],
    rating = null,
    reviews = null,
  } = lead;

  // Prefer AI-curated photo placement; fall back to naive ordering.
  let hero, cta, gallery, curatedLogo, beforeURL, afterURL;
  if (curated) {
    hero = curated.hero;
    gallery = curated.gallery || [];
    cta = gallery[0] || hero || null;
    curatedLogo = curated.logo;
    beforeURL = curated.before;
    afterURL = curated.after;
  } else {
    ({ hero, cta, gallery } = splitImages(images));
  }
  const cityState = [city, state].filter(Boolean).join(", ");

  return {
    name,
    niche: category,
    tagline: city ? `${city}'s Trusted ${category}` : `Top-Rated ${category}`,
    cityState: cityState || "Your City, ST",
    phone: phone || "(000) 000-0000",
    email: email || "",
    desc: shortDesc(about, category, city),
    aboutText:
      about ||
      `${name} is a local ${category.toLowerCase()} dedicated to quality work and great service. Get in touch today for a free quote!`,
    baText: `We Are: ${name}`,
    primary: DEFAULT_PRIMARY,
    dark: DEFAULT_DARK,
    why: [
      { title: "Locally Owned & Operated", desc: `Proudly serving ${city || "our community"} with personal, dependable service.` },
      { title: "Quality You Can Trust", desc: "Experienced professionals committed to doing the job right the first time." },
      { title: "Free, No-Pressure Quotes", desc: "Reach out today and we'll get you a fast, honest estimate." },
    ],
    serviceAreas: serviceAreas.length ? serviceAreas : [city].filter(Boolean),
    fbUrl: fbUrl || "#",
    igUrl: igUrl || "#",
    elfsight: "",
    logoURL: curatedLogo || logo,
    heroURL: hero,
    ctaURL: cta,
    beforeURL: beforeURL || null,
    afterURL: afterURL || null,
    baSynthetic: !!(curated && curated.baSynthetic), // before/after is AI-generated → label it
    galleryURLs: gallery,
    services: deriveServices(category, gallery),
    rating,
    reviews,
  };
}
