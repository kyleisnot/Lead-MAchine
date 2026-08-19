// niches.js — the ONLY business types this tool targets.
// Edit this list to change what gets scraped + kept. Everything else is dropped.
//
// `search`  = the phrase used in the Google Maps search ("<search> in <city>").
// `match`   = keywords; if a scraped business's category contains ANY of these, it's a match.

export const NICHES = [
  { key: "landscaping",      search: "landscaping",          match: ["landscap", "lawn care", "lawn service", "lawn maintenance"] },
  { key: "concrete",         search: "concrete contractor",  match: ["concrete", "cement", "paving"] },
  { key: "construction",     search: "construction company", match: ["construction", "general contractor", "builder", "remodel"] },
  { key: "roofing",          search: "roofing contractor",   match: ["roof"] },
  { key: "hardscaping",      search: "hardscaping",          match: ["hardscap", "paver", "retaining wall", "patio"] },
  { key: "pest control",     search: "pest control",         match: ["pest", "exterminat", "termite"] },
  { key: "pressure washing", search: "pressure washing",     match: ["pressure wash", "power wash", "soft wash"] },
  { key: "car detailing",    search: "car detailing",        match: ["detail", "auto detail", "car wash"] },
  { key: "garage door",      search: "garage door",          match: ["garage door"] },
  { key: "fencing",          search: "fence contractor",     match: ["fenc"] },
];

// All the search phrases (for "scrape every niche" runs).
export const NICHE_SEARCHES = NICHES.map((n) => n.search);

// Does a scraped business category belong to one of our target niches?
export function isTargetNiche(category = "") {
  const c = category.toLowerCase();
  return NICHES.some((n) => n.match.some((kw) => c.includes(kw)));
}

// Keep only leads in our target niches.
export function keepTargetNiches(leads) {
  return leads.filter((l) => isTargetNiche(l.category));
}
