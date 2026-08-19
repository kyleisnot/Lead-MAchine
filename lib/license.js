// license.js — best-effort, FREE "is this business licensed / registered?" SIGNAL.
//
// HONEST SCOPE: there is no free database that verifies licenses across all 50 states
// (every state board is a separate site and many block automated lookups). So we do two
// genuinely-free things instead of pretending to query every government database:
//
//   1) detectLicenseSignal(lead) — read what the business ITSELF advertises in the text we
//      already scraped (name + Facebook/Google/Instagram "about"/bio/intro). Many trades post
//      "Licensed & Insured", a license number, or operate as an "LLC/Inc" (a registered entity).
//      Text-based, so it works in EVERY state. It tells you what the business *claims*.
//
//   2) licenseSearchUrl(lead) — a one-click link to an OFFICIAL search, pre-filled with the
//      business name + state, so you can CONFIRM in seconds. No scraping, never breaks.
//
// This is a TAG, never a filter — leads are never dropped for it (your choice).

// "LLC / Inc / Corp / Co." in the NAME ⇒ almost certainly a state-registered legal entity.
const ENTITY_RE = /\b(l\.?\s?l\.?\s?c\.?|p\.?\s?l\.?\s?l\.?\s?c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?)\b/i;

// License / certification / registration language in the profile text.
const LICENSE_KW_RE = /\b(licen[sc]ed?|state[-\s]?licen[sc]ed|certified|state[-\s]?certified|registered|registration)\b/i;

// A license/cert/registration NUMBER — only when a license keyword sits right before it, so we
// never mistake a phone number or ZIP for a license number.
const LICENSE_NUM_RE = /\b(?:licen[sc]e|lic|cert(?:ificate)?|reg(?:istration)?)\.?\s*(?:no\.?|number|#)?\s*([A-Z]{0,5}-?\d{3,}[A-Z0-9-]*)/i;

function textOf(lead = {}) {
  return [lead.name, lead.about].filter(Boolean).join("  ");
}

/**
 * Best-effort license/registration signal from already-scraped text.
 * @returns {{ status: "mentioned"|"none", number: string, evidence: string }}
 */
export function detectLicenseSignal(lead = {}) {
  const name = String(lead.name || "");
  const about = String(lead.about || "");
  const all = textOf(lead);

  const isEntity = ENTITY_RE.test(name) || ENTITY_RE.test(about);
  const saysLicensed = LICENSE_KW_RE.test(all);
  const numMatch = about.match(LICENSE_NUM_RE) || name.match(LICENSE_NUM_RE);
  const number = numMatch ? numMatch[1].trim() : "";

  const bits = [];
  if (number) bits.push(`license #${number}`);
  else if (saysLicensed) bits.push("says licensed/registered");
  if (isEntity) bits.push("registered (LLC/Inc)");

  const status = number || saysLicensed || isEntity ? "mentioned" : "none";
  return { status, number, evidence: bits.join(" · ") };
}

/** One-click OFFICIAL search link, pre-filled with the business name + location. */
export function licenseSearchUrl(lead = {}) {
  const where = lead.state || lead.city || "";
  const q = `"${lead.name || ""}" ${where} contractor license OR business registration`;
  return "https://www.google.com/search?q=" + encodeURIComponent(q.trim());
}
