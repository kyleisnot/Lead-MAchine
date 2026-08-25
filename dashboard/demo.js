// demo.js — the live-meeting demo screen (Agent D).
//
// One page, projected in a sales meeting: the operator types the prospect's city
// and trade, hits "Find leads", and the room watches the machine scan, filter and
// surface businesses with no website. Big type, no chrome, nothing to explain.
//
// It runs on the EXISTING search stack — the page just posts to /api/search with
// the session cookie, so results, caching, metering and dedup are identical to the
// normal Prospector page. The theatre (staged progress, count-up stats, cards that
// land one by one) is all client-side.
//
// Zero-cost replay: GET /demo/api/saved lists this user's cached searches. Clicking
// a chip fills the inputs and re-runs it; the search cache answers for free, so a
// demo never depends on live Apify credits (and there is no APIFY_TOKEN in dev).
//
// ── The demo WORKSPACE (the second half of this file) ────────────────────────
// The page above sells the *search*. The workspace sells the *product*: one click
// drops the operator into the real app — every page, every feature — signed in as a
// dedicated demo account preloaded with a believable 36-lead pipeline, and one click
// puts it back exactly as it was for the next meeting.
//
// Nothing here is a mock: the seed writes ordinary rows for an ordinary user, so what
// the prospect sees IS the shipping product. Impersonation lives in auth.js (the
// lm_demo cookie, honoured only for an authenticated admin).
//
// ── LIVE demos: presenting as the PROSPECT ───────────────────────────────────
// The staged workspace above rehearses; this sells. The operator types the prospect's
// email, the app quietly creates (or adopts) that person's REAL account, and the
// meeting runs inside it — so every search saves REAL leads into the prospect's own
// dashboard. Nothing is seeded: the meeting's own searches are the data. At the end
// "Get their sign-in link" mints a Supabase recovery link that drops them straight
// into the account they just watched fill up.
//
// Contract:
//   export const demoRouter — express Router, every route guarded by
//                             requireUser + requireAdmin (same as admin.js).
//   GET  /demo               — the presentation page (+ the demo panels)
//   GET  /demo/api/saved     — { ok, saved:[{key,niche,city,state,sources,limit,…}], keys:[…] }
//   POST /demo/enter         — ensure the staged account + its data, set cookie → /
//   POST /demo/prospect      — find-or-create the prospect's account (form: email),
//                              set cookie to its uuid → /
//   POST /demo/exit          — clear cookie → /demo
//   POST /demo/api/reset     — wipe and reseed the staged account's rows
//   POST /demo/api/claim-link— { ok, link, email }: the prospect's sign-in link
import express from "express";
import crypto from "node:crypto";
import {
  requireUser, requireAdmin, demoEmail, demoUserId, rememberDemoUserId, forgetDemoUserId,
  writeDemoCookie, clearDemoCookie, isAdminEmail, originOf,
} from "./auth.js";
import * as store from "../data/store.js";
import { dataProvider, getSupabase } from "../lib/supabase.js";
import { RATE_PER_1K } from "../lib/spend.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar, FAVICON } from "./shell.js";

export const demoRouter = express.Router();

// The demo always scans all three sources at "Quick" depth: fast enough to hold a
// room's attention, and the same shape the saved Chattanooga demos were cached with.
const DEMO_SOURCES = ["google", "facebook", "instagram"];
const DEMO_LIMIT = 20;
const MAX_CHIPS = 18;

function tokensPerUsd() {
  const n = parseFloat(process.env.TOKENS_PER_USD || "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

// Cache keys are `niche|city|state|sources|limit`, lowercased, sources comma-joined
// (see cacheKey() in lib/pipeline.js). Parse one back into fields; returns null for
// anything malformed or from an older key format (those can't be replayed for free).
function parseKey(key) {
  const parts = String(key || "").split("|");
  if (parts.length !== 5) return null;
  const [niche, city, state, sources, limit] = parts.map((p) => p.trim());
  const lim = parseInt(limit, 10);
  const srcs = sources.split(",").map((s) => s.trim()).filter(Boolean);
  if (!niche || !city || !srcs.length || !Number.isFinite(lim) || lim <= 0) return null;
  return { key: String(key), niche, city, state, sources: srcs, limit: lim };
}

// Cache keys are stored lowercased; title-case them again so a chip reads well on a
// projector ("Landscaping · Chattanooga TN", not "landscaping · chattanooga tn").
const titleCase = (s) => String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function labelFor(p) {
  const where = [titleCase(p.city), (p.state || "").toUpperCase()].filter(Boolean).join(" ");
  return where ? `${titleCase(p.niche)} · ${where}` : titleCase(p.niche);
}

// ── routes ───────────────────────────────────────────────────────────────────

// This user's cached searches → the "Saved demos" strip. `saved` is the replayable
// subset (chips); `keys` is every cached key, which the page uses to tell whether a
// typed search will spend credits or come back free.
demoRouter.get("/demo/api/saved", requireUser, requireAdmin, async (req, res) => {
  try {
    const rows = (await store.listSearchCache(req.userId)) || [];
    const saved = [];
    const seen = new Set();
    for (const r of rows) {
      const p = parseKey(r.key);
      if (!p) continue;
      // The same niche+city cached at two depths would read as two identical chips —
      // keep the newest one only (rows arrive newest first).
      const label = labelFor(p);
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      saved.push({ ...p, label, updatedAt: r.updated_at || null });
      if (saved.length >= MAX_CHIPS) break;
    }
    res.json({ ok: true, saved, keys: rows.map((r) => String(r.key)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : "Could not load saved demos." });
  }
});

demoRouter.get("/demo", requireUser, requireAdmin, async (req, res) => {
  // Which account are we presenting as? The panel below has to say the prospect's
  // email out loud, so it is resolved server-side from req.userId rather than
  // trusted from the cookie.
  const target = await impersonationTarget(req).catch(() => null);
  res.type("html").send(renderDemoPage(req, target));
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO WORKSPACE — seed data
// ═════════════════════════════════════════════════════════════════════════════
// Deterministic on purpose: the same 36 businesses, the same pipeline and the same
// numbers after every reset, so a rehearsed meeting runs exactly as rehearsed. Only
// the DATES are relative (daysAgo), so "contacted 3 days ago" is still true a year
// from now — a demo full of 2026 timestamps is the fastest way to look abandoned.

const DAY_MS = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);
const isoDaysAgo = (n) => daysAgo(n).toISOString();
const pad2 = (n) => String(n).padStart(2, "0");
// manual_followups.due is a plain date and the UI reads it back as LOCAL midnight,
// so "due today" has to mean the operator's today, not UTC's.
function dueDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

const DEMO_STATE = "TN";
const SEED_SOURCES = ["google", "facebook", "instagram"]; // the depth the demo searches ran at
const SEED_LIMIT = 20;
const SOURCE_CYCLE = ["google_maps", "facebook", "instagram"];

// Each city has a headline trade — the cached search for that city returns those 8,
// while the other 4 keep the city's lead list looking like real mixed prospecting.
const DEMO_CITIES = [
  { city: "Knoxville", area: "865", niche: "landscaping" },
  { city: "Chattanooga", area: "423", niche: "roofing" },
  { city: "Nashville", area: "615", niche: "pressure washing" },
];

const CATEGORY = {
  landscaping: ["Landscaper", "Lawn care service"],
  roofing: ["Roofing contractor", "Roofer"],
  "pressure washing": ["Pressure washing service", "Power washing service"],
};

// Half of these carry "Licensed & insured" or "LLC" so the license badge on the lead
// cards has something real to read — that badge is part of the pitch.
const ABOUT = {
  landscaping: [
    "Family-run lawn and landscape crew serving {city} since 2014. Licensed & insured.",
    "Weekly mowing, mulch and spring cleanups across {city}. Free estimates.",
    "{name} LLC — full-service landscaping, sod and retaining walls.",
    "Small crew, big yards. Mowing, hedges and leaf removal around {city}.",
  ],
  roofing: [
    "Roof repair, replacement and storm damage in {city}. Licensed & insured.",
    "Shingle and metal roofing. Free inspections across the {city} area.",
    "{name} LLC — residential roofing, gutters and skylights.",
    "Third-generation roofers covering {city} and the surrounding counties.",
  ],
  "pressure washing": [
    "Soft wash, driveways and decks in {city}. Licensed & insured.",
    "House washing, gutter brightening and concrete cleaning. Same-week booking.",
    "{name} LLC — commercial and residential pressure washing.",
    "Driveways, patios and fences cleaned across greater {city}.",
  ],
};

// 36 businesses: 12 per city, 8 of them in that city's headline trade.
const DEMO_BUSINESSES = [
  // Knoxville — landscaping ×8
  ["Iron Oak Landscaping", "landscaping"],
  ["Cedar Bluff Lawn & Landscape", "landscaping"],
  ["Tennessee Valley Landscaping", "landscaping"],
  ["Third Creek Lawn Care", "landscaping"],
  ["Bearden Yard Works", "landscaping"],
  ["Smoky Ridge Landscaping", "landscaping"],
  ["Powell Green Lawn Care", "landscaping"],
  ["Hardin Valley Landscape Co.", "landscaping"],
  ["Summit Ridge Roofing", "roofing"],
  ["Volunteer State Roofing", "roofing"],
  ["Clear Creek Pressure Washing", "pressure washing"],
  ["Riverbend Power Wash", "pressure washing"],
  // Chattanooga — roofing ×8
  ["Lookout Mountain Roofing", "roofing"],
  ["Signal Point Roofing", "roofing"],
  ["Scenic City Roof Works", "roofing"],
  ["Ridgeline Roofing & Repair", "roofing"],
  ["Chickamauga Roofing Co.", "roofing"],
  ["Red Bank Roofing", "roofing"],
  ["Tennessee River Roofing", "roofing"],
  ["Hixson Roof Pros", "roofing"],
  ["Moccasin Bend Landscaping", "landscaping"],
  ["Southside Lawn & Landscape", "landscaping"],
  ["Bluff View Pressure Washing", "pressure washing"],
  ["Riverwalk Power Washing", "pressure washing"],
  // Nashville — pressure washing ×8
  ["Music City Pressure Washing", "pressure washing"],
  ["Cumberland Power Wash", "pressure washing"],
  ["Nolensville Pressure Washing", "pressure washing"],
  ["Broadway Soft Wash", "pressure washing"],
  ["Harpeth Valley Power Washing", "pressure washing"],
  ["Germantown Pressure Pros", "pressure washing"],
  ["Donelson Power Wash Co.", "pressure washing"],
  ["Bellevue Soft Wash", "pressure washing"],
  ["Twelve South Landscaping", "landscaping"],
  ["Percy Warner Lawn Care", "landscaping"],
  ["Stones River Roofing", "roofing"],
  ["Antioch Ridge Roofing", "roofing"],
];

// The 12 leads already in the pipeline, by index into the list above: 4 New,
// 4 Contacted, 2 Interested, 1 Won, 1 Lost, spread 4 per city.
const SAVED_PLAN = [
  { i: 0, stage: "Contacted", contacted: 3, savedAgo: 18, notes: "Quoted $2,400 — deciding this week" },
  { i: 2, stage: "New", savedAgo: 16, notes: "Google listing only, no site at all" },
  { i: 5, stage: "Interested", savedAgo: 14, notes: "Wants something up before the spring rush" },
  { i: 8, stage: "Contacted", contacted: 6, savedAgo: 13, notes: "Voicemail ×2, try Thursday" },
  { i: 12, stage: "Won", savedAgo: 11, notes: "Signed — 5 pages, build starts Monday" },
  { i: 14, stage: "New", savedAgo: 10, notes: "Storm-damage ads on FB, still no website" },
  { i: 17, stage: "Contacted", contacted: 2, savedAgo: 8, notes: "Owner asked for pricing by email" },
  { i: 20, stage: "Lost", savedAgo: 7, notes: "Nephew is building them one" },
  { i: 24, stage: "Contacted", contacted: 9, savedAgo: 6, notes: "Left a card at the shop — call back Friday" },
  { i: 26, stage: "New", savedAgo: 4, notes: "2.1k on Instagram, link in bio goes nowhere" },
  { i: 29, stage: "Interested", savedAgo: 3, notes: "Asked what a 5-page site runs" },
  { i: 33, stage: "New", savedAgo: 1, notes: "Referred by the Iron Oak crew" },
];

const FOLLOWUPS = [
  { title: "Call back Marcus @ Iron Oak", note: "Wants the $2,400 quote broken out by page", due: -2 },
  { title: "Send Scenic City Roof Works the mockup", note: "Promised it on Tuesday's call", due: 0 },
  { title: "Follow up with Music City Pressure Washing", note: "Left a card at the shop — ask for Dana", due: 3 },
];

// 14 metered searches summing to exactly $12.40 → 1,240 of the plan's 2,500 tokens,
// which lands the sidebar meter at a comfortable-but-visible half full.
const USAGE_COSTS = [1.2, 0.85, 0.6, 1.1, 0.75, 0.95, 1.35, 0.5, 0.8, 1.05, 0.65, 1.15, 0.7, 0.75];

// The brain: the 36 leads (no website) plus 84 businesses that already had one, so the
// "Remembered" statbox reads 120 · 36 no site · 84 had one — the ratio that sells the filter.
const FILLER_COUNT = 84;
const FILLER_SUFFIX = ["& Sons", "Services", "Pros", "Co.", "Group", "of Tennessee", "Contractors"];

const DEMO_TABLES = ["leads", "checked_businesses", "searches", "app_state", "usage_log", "manual_followups"];

// Mirrors cacheKey() in lib/pipeline.js so a seeded search really is a cache HIT.
function seedCacheKey(niche, city) {
  return [niche, city, DEMO_STATE, [...SEED_SOURCES].sort().join(","), SEED_LIMIT]
    .map((x) => String(x ?? "").trim().toLowerCase())
    .join("|");
}

function buildLeads() {
  const out = [];
  DEMO_CITIES.forEach((c, ci) => {
    for (let k = 0; k < 12; k++) {
      const i = ci * 12 + k;
      const [name, trade] = DEMO_BUSINESSES[i];
      const source = SOURCE_CYCLE[i % 3];
      const category = CATEGORY[trade][k % 2];
      const phone = `(${c.area}) 555-01${pad2(k + 1)}`;
      const email = i % 5 < 3 ? `${slug(name).slice(0, 24)}@${i % 2 ? "yahoo.com" : "gmail.com"}` : ""; // ~60%
      const about = ABOUT[trade][i % 4].replace("{city}", c.city).replace("{name}", name);
      // ~2/3 have a dated last activity (3–200 days back); the rest read as "undated".
      const lastActivity = i % 3 !== 2 ? daysAgo(3 + ((i * 17) % 198)).getTime() : null;
      out.push({
        i, trade, name, category, phone, email, source,
        city: c.city,
        externalId: `demo-${slug(name)}`,
        lead_json: { name, category, city: c.city, state: DEMO_STATE, phone, email, source, about, lastActivity },
      });
    }
  });
  return out;
}

// The stats block a real search would have produced for this group of leads.
function statsFor(group) {
  const bySource = { google: 0, facebook: 0, instagram: 0 };
  let activeSeen = 0;
  for (const l of group) {
    if (l.source === "google_maps") bySource.google++;
    else if (l.source === "facebook") bySource.facebook++;
    else bySource.instagram++;
    if (l.lead_json.lastActivity) activeSeen++;
  }
  return {
    scanned: 44, qualified: group.length, hasWebsite: 27, offNiche: 5,
    activeSeen, staleSeen: 2, unknownSeen: 3, inactive: 0, crossSourceMerged: 2,
    sinceLabel: null, fbDeepChecked: 0, googleDeepChecked: 0, dismissed: 0, bySource,
  };
}

// ── reseed ───────────────────────────────────────────────────────────────────
// Wipe every row the demo user owns and lay the whole workspace down again. The auth
// user and its profile row survive (deleting the account would break impersonation);
// the profile is re-stamped with the plan the demo is supposed to show.
//
// `step` is carried through so a failure comes back as {ok:false, step, error} and the
// operator can see WHICH part broke from the browser, mid-meeting, without a log.
async function reseedDemo(sb, userId) {
  let step = "wipe";
  try {
    for (const table of DEMO_TABLES) {
      const { error } = await sb.from(table).delete().eq("user_id", userId);
      if (error) throw new Error(`${table}: ${error.message}`);
    }

    // Leads first — every other table refers to the ids Postgres hands back.
    step = "leads";
    const leads = buildLeads();
    const savedBy = new Map(SAVED_PLAN.map((p) => [p.i, p]));
    const leadRows = leads.map((l) => {
      const p = savedBy.get(l.i);
      return {
        user_id: userId,
        source: l.source,
        external_id: l.externalId,
        name: l.name,
        category: l.category,
        city: l.city,
        state: DEMO_STATE,
        phone: l.phone,
        email: l.email,
        website: "",
        lead_json: l.lead_json,
        dedup_key: store.dedupKeyFor({ phone: l.phone, name: l.name, city: l.city }),
        status: "new",
        dismissed: false,
        created_at: isoDaysAgo(2 + (l.i % 21)),
        saved: !!p,
        saved_at: p ? isoDaysAgo(p.savedAgo) : null,
        crm_stage: p ? p.stage : "New",
        notes: p ? p.notes : "",
        contacted_on: p && p.contacted ? isoDaysAgo(p.contacted) : null,
      };
    });
    const inserted = await sb.from("leads").insert(leadRows).select("id,external_id");
    if (inserted.error) throw new Error(inserted.error.message);
    const idByExt = new Map((inserted.data || []).map((r) => [r.external_id, r.id]));
    if (idByExt.size !== leadRows.length) {
      throw new Error(`inserted ${idByExt.size} of ${leadRows.length} leads`);
    }

    // Cached searches — one per city, keyed exactly as the pipeline would key them,
    // so the operator can replay any of the three chips for free.
    step = "searches";
    const searchRows = [];
    let lastSearch = null;
    DEMO_CITIES.forEach((c, ci) => {
      const group = leads.filter((l) => l.city === c.city && l.trade === c.niche);
      const ids = group.map((l) => idByExt.get(l.externalId)).filter((n) => n != null);
      const stats = statsFor(group);
      stats.qualified = ids.length;
      searchRows.push({
        user_id: userId,
        key: seedCacheKey(c.niche, c.city),
        data: { ids, stats },
        updated_at: isoDaysAgo(1 + ci * 2),
      });
      if (ci === 0) {
        lastSearch = {
          niche: c.niche, city: c.city, state: DEMO_STATE,
          sources: SEED_SOURCES.slice(), limit: SEED_LIMIT, ids, stats, ts: Date.now(),
        };
      }
    });
    const searchIns = await sb.from("searches").insert(searchRows);
    if (searchIns.error) throw new Error(searchIns.error.message);

    // The Search page restores this the moment the operator lands on it — results
    // already on screen, before anyone has typed anything.
    step = "app_state";
    const stateIns = await sb.from("app_state").insert({ user_id: userId, key: "last_search", value: lastSearch });
    if (stateIns.error) throw new Error(stateIns.error.message);

    step = "usage_log";
    const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    const span = Math.max(1, Date.now() - monthStart);
    const usageRows = USAGE_COSTS.map((cost, n) => ({
      user_id: userId,
      kind: "search",
      cost,
      at: new Date(monthStart + Math.round((span * (n + 0.5)) / USAGE_COSTS.length)).toISOString(),
    }));
    const usageIns = await sb.from("usage_log").insert(usageRows);
    if (usageIns.error) throw new Error(usageIns.error.message);

    step = "manual_followups";
    const fuIns = await sb.from("manual_followups").insert(
      FOLLOWUPS.map((f) => ({
        user_id: userId, title: f.title, note: f.note, due: dueDate(f.due), done: false,
        created_at: isoDaysAgo(5),
      }))
    );
    if (fuIns.error) throw new Error(fuIns.error.message);

    step = "checked_businesses";
    const checkedRows = leads.map((l) => ({
      user_id: userId,
      source: l.source,
      external_id: l.externalId,
      name: l.name,
      has_website: false,
      niche: l.trade,
      city: l.city,
      state: DEMO_STATE,
      checked_at: isoDaysAgo(1 + (l.i % 20)),
    }));
    for (let n = 0; n < FILLER_COUNT; n++) {
      const base = leads[n % leads.length];
      checkedRows.push({
        user_id: userId,
        source: SOURCE_CYCLE[(n + 1) % 3],
        external_id: `demo-checked-${n}`,
        name: `${base.name} ${FILLER_SUFFIX[n % FILLER_SUFFIX.length]}`,
        has_website: true,
        niche: base.trade,
        city: base.city,
        state: DEMO_STATE,
        checked_at: isoDaysAgo(1 + (n % 26)),
      });
    }
    const checkedIns = await sb.from("checked_businesses").insert(checkedRows);
    if (checkedIns.error) throw new Error(checkedIns.error.message);

    step = "profile";
    const profIns = await sb
      .from("profiles")
      .update({ tier: "starter", monthly_token_allotment: 2500 })
      .eq("id", userId)
      .select("id");
    if (profIns.error) throw new Error(profIns.error.message);
    if (!profIns.data || !profIns.data.length) throw new Error("no profile row for the demo account");

    const usd = USAGE_COSTS.reduce((a, c) => a + c, 0);
    return {
      ok: true,
      seeded: {
        leads: leadRows.length,
        saved: SAVED_PLAN.length,
        followups: FOLLOWUPS.length,
        checked: checkedRows.length,
        searches: searchRows.length,
        tokensUsed: Math.round(usd * tokensPerUsd()),
      },
    };
  } catch (e) {
    return { ok: false, step, error: e && e.message ? e.message : String(e) };
  }
}

// ── the demo account ─────────────────────────────────────────────────────────

// Find the auth user by email even when its profile row is missing (a half-created
// account from an interrupted first run).
async function findAuthUserId(sb, email) {
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const users = (data && data.users) || [];
    const hit = users.find((u) => String(u.email || "").toLowerCase() === email);
    if (hit) return String(hit.id);
    if (users.length < 200) break;
  }
  return null;
}

// The demo account, created on first use. Its password is random and immediately
// thrown away: the account is only ever reached by admin impersonation, never by
// signing in, so nobody (including us) holds a credential for it.
async function ensureDemoAccount(sb) {
  const email = demoEmail();

  const known = await demoUserId();
  if (known) {
    const check = await sb.from("profiles").select("id").eq("id", known).maybeSingle();
    if (check.data && check.data.id) return known;
    forgetDemoUserId(); // deleted from the Supabase dashboard → build it again
  }

  let id = null;
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: crypto.randomBytes(24).toString("base64url").slice(0, 32),
    email_confirm: true,
  });
  if (error) {
    id = await findAuthUserId(sb, email); // already there → adopt it
    if (!id) throw new Error(error.message || "Could not create the demo account.");
  } else {
    id = String((data && data.user && data.user.id) || "");
    if (!id) throw new Error("Supabase created the demo account but returned no id.");
  }

  // The signup trigger writes the profile row; give it a beat, then verify. If the
  // trigger isn't installed we write the row ourselves — impersonation resolves the
  // demo account BY its profile row, so a missing one would silently disable the
  // whole feature.
  let hasProfile = false;
  for (let n = 0; n < 10 && !hasProfile; n++) {
    const r = await sb.from("profiles").select("id").eq("id", id).maybeSingle();
    if (r.data && r.data.id) hasProfile = true;
    else await sleep(300);
  }
  if (!hasProfile) {
    const up = await sb
      .from("profiles")
      .upsert({ id, email, tier: "starter", monthly_token_allotment: 2500 }, { onConflict: "id" });
    if (up.error) throw new Error(`profile: ${up.error.message}`);
  }

  rememberDemoUserId(id);
  return id;
}

// ── the prospect's account ───────────────────────────────────────────────────
// Same create-or-adopt dance as ensureDemoAccount, with two differences: nothing is
// seeded (the meeting's real searches ARE the data) and the profile is left on the
// trigger's defaults — trial / 500 tokens — because this is a genuine new signup that
// the prospect will keep. Returns the account's uuid.
// A demo'd prospect keeps every lead found in the meeting, but has no search credit
// left: the empty meter is what asks for the sale. `prospect` is the admin panel's
// 1-token plan (0 would mean UNLIMITED), so the next search prompts an upgrade.
const PROSPECT_PLAN = { tier: "prospect", monthly_token_allotment: 1 };

async function ensureProspectAccount(sb, email) {
  const existing = await sb.from("profiles").select("id").eq("email", email).limit(1);
  if (!existing.error && existing.data && existing.data[0] && existing.data[0].id) {
    return String(existing.data[0].id); // they already signed up — present as them
  }

  let id = null;
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: crypto.randomBytes(24).toString("base64url").slice(0, 32),
    email_confirm: true,
  });
  if (error) {
    id = await findAuthUserId(sb, email); // auth user exists but has no profile row → adopt
    if (!id) throw new Error(error.message || "Could not create that account.");
  } else {
    id = String((data && data.user && data.user.id) || "");
    if (!id) throw new Error("Supabase created the account but returned no id.");
  }

  // Impersonation resolves the target BY its profile row, so a missing one would
  // silently refuse the cookie. Wait for the signup trigger, then write it ourselves.
  let hasProfile = false;
  for (let n = 0; n < 10 && !hasProfile; n++) {
    const r = await sb.from("profiles").select("id").eq("id", id).maybeSingle();
    if (r.data && r.data.id) hasProfile = true;
    else await sleep(300);
  }
  if (!hasProfile) {
    const up = await sb.from("profiles").upsert({ id, email, ...PROSPECT_PLAN }, { onConflict: "id" });
    if (up.error) throw new Error(`profile: ${up.error.message}`);
  } else {
    // The signup trigger writes trial/500. A brand-new account created FOR a demo
    // starts on the prospect plan instead — an account they already made themselves
    // was returned earlier, so this only ever touches accounts we just created.
    await sb.from("profiles").update(PROSPECT_PLAN).eq("id", id);
  }
  return id;
}

// Who req.userId currently belongs to, when it isn't the operator's own account:
// { id, email, staged }. `staged` separates the rehearsal workspace from a live
// prospect — the two panels, and the claim-link route, hinge on it.
async function impersonationTarget(req) {
  if (!req.isDemo || dataProvider() !== "supabase") return null;
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.from("profiles").select("id,email").eq("id", req.userId).maybeSingle();
    if (error || !data || !data.id) return null;
    const email = String(data.email || "").trim().toLowerCase();
    // Belt and braces: an id match covers a staged profile whose email column is blank,
    // which would otherwise read as a prospect and expose a claim link for it.
    const staged = email === demoEmail() || String(data.id) === String(await demoUserId());
    return { id: String(data.id), email, staged };
  } catch {
    return null;
  }
}

// ── workspace routes ─────────────────────────────────────────────────────────

const SQLITE_NOTE = "The demo workspace needs Supabase mode.";

// Enter: make sure the account and its data exist, then set the cookie and land on
// the Search page — which restores the seeded search, so the room sees results
// before the operator has typed a word.
demoRouter.post("/demo/enter", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") return res.redirect(303, "/demo?err=" + encodeURIComponent(SQLITE_NOTE));
  try {
    const sb = await getSupabase();
    const userId = await ensureDemoAccount(sb);

    const { count, error } = await sb
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) throw new Error(`leads count: ${error.message}`);
    if (!count) {
      const seeded = await reseedDemo(sb, userId);
      if (!seeded.ok) throw new Error(`${seeded.step}: ${seeded.error}`);
    }

    writeDemoCookie(req, res);
    return res.redirect(303, "/");
  } catch (e) {
    const msg = e && e.message ? e.message : "Could not start the demo workspace.";
    return res.redirect(303, "/demo?err=" + encodeURIComponent(msg));
  }
});

// Start a LIVE demo: the operator types the prospect's email, we make sure that real
// account exists, and the cookie points at it for the rest of the meeting. Nothing is
// seeded — the searches run in front of the prospect are what fills their dashboard.
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const prospectBody = [express.urlencoded({ extended: false }), express.json()];

demoRouter.post("/demo/prospect", requireUser, requireAdmin, prospectBody, async (req, res) => {
  const bail = (msg) => res.redirect(303, "/demo?err=" + encodeURIComponent(msg));
  if (dataProvider() !== "supabase") return bail(SQLITE_NOTE);

  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!email) return bail("Enter the prospect's email address.");
  if (!looksLikeEmail(email)) return bail("That doesn't look like an email address.");
  // Two accounts we must never hand an operator a live session for: a colleague's
  // (one typo and you're presenting from inside their real dashboard) and the staged
  // demo account (that's the Practice demo, and it would hand out a sign-in link for it).
  if (isAdminEmail(email)) return bail("That's an operator account — use a prospect's own email.");
  if (email === demoEmail()) return bail("That's the staged demo account — use the Practice demo instead.");

  try {
    const sb = await getSupabase();
    const userId = await ensureProspectAccount(sb, email);
    writeDemoCookie(req, res, userId);
    return res.redirect(303, "/");
  } catch (e) {
    return bail(e && e.message ? e.message : "Could not start the prospect demo.");
  }
});

// The handoff at the end of the meeting: a Supabase recovery link for the account the
// room just watched fill up. It lands on /auth/callback, which already knows how to
// turn the fragment it carries into this app's session cookie — so the prospect clicks
// once and is inside their own dashboard, leads and all. Prospect demos only: the
// staged account's link would be a credential for the rehearsal workspace.
demoRouter.post("/demo/api/claim-link", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") {
    return res.status(400).json({ ok: false, error: SQLITE_NOTE });
  }
  try {
    const target = await impersonationTarget(req);
    if (!target || target.staged || !target.email) {
      return res.status(400).json({ ok: false, error: "Start a prospect demo first — there's no account to hand over." });
    }
    const sb = await getSupabase();
    const { data, error } = await sb.auth.admin.generateLink({
      type: "recovery",
      email: target.email,
      options: { redirectTo: `${originOf(req)}/auth/callback` },
    });
    if (error) throw new Error(error.message || "Supabase would not mint a link.");
    const link = String((data && data.properties && data.properties.action_link) || "");
    if (!link) throw new Error("Supabase returned no link.");
    return res.json({ ok: true, link, email: target.email });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e && e.message ? e.message : "Could not create the sign-in link.",
    });
  }
});

// Exit: drop the cookie. Works in every mode — clearing a cookie that isn't there
// is a no-op, so this can never leave the operator stuck in the demo.
demoRouter.post("/demo/exit", requireUser, requireAdmin, (req, res) => {
  clearDemoCookie(req, res);
  return res.redirect(303, "/demo");
});

demoRouter.post("/demo/api/reset", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") {
    return res.status(400).json({ ok: false, step: "mode", error: SQLITE_NOTE });
  }
  try {
    const sb = await getSupabase();
    const userId = await ensureDemoAccount(sb);
    const result = await reseedDemo(sb, userId);
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      step: "account",
      error: e && e.message ? e.message : "Could not prepare the demo account.",
    });
  }
});

// ── page ─────────────────────────────────────────────────────────────────────

// The demo panels under the saved-demos strip. Two modes sit side by side when the
// operator is signed in as themselves — the rehearsal workspace (staged data) and the
// live prospect demo (their real account) — and whichever one is running replaces both
// while it's running. Server-rendered from req.isDemo + the resolved target, so the
// page can never disagree with the cookie the browser is actually carrying.
//
// `err` (from ?err=…) is rendered into the FIRST card only, so a redirect back here
// never shows the same message twice.
function workspacePanel(req, target) {
  const raw = String((req.query && req.query.err) || "").slice(0, 300);
  const err = raw ? `<div class="dwork-err">⚠️ ${escHtml(raw)}</div>` : "";

  if (dataProvider() !== "supabase") {
    return `<div class="dwork">
  <div class="dwork-ttl">Client demo</div>
  <h2>The demo workspace needs Supabase mode</h2>
  <p>This app is running on local SQLite, which is single-user — there is no second account to present as, so there is nothing to stage, reset or hand over.</p>
  <div class="dwork-note">Set <code>DATA_PROVIDER=supabase</code> in <code>.env</code> (with the project URL and service-role key) and restart to use the demo workspace.</div>
  ${err}
</div>`;
  }

  // Live demo in progress — presenting as the prospect's own account.
  if (req.isDemo && target && !target.staged) {
    const who = escHtml(target.email);
    return `<div class="dwork">
  <div class="dwork-ttl">Live demo for a prospect</div>
  <h2>You're presenting as <span class="dwork-who">${who}</span></h2>
  <p>This is their real account. Every search you run in the meeting saves real leads into it — so when you hand it over, the pipeline they just watched you build is already theirs. Nothing here touches your own leads.</p>
  <div class="dwork-act">
    <form method="post" action="/demo/exit"><button class="dwork-go" type="submit">Exit demo</button></form>
    <button class="dwork-reset" type="button" onclick="getClaimLink(this)">Get their sign-in link</button>
    <span class="dwork-flag" id="clFlag"></span>
  </div>
  <div class="dwork-claim" id="clWrap" hidden>
    <div class="dwork-claimrow">
      <input id="clLink" type="text" readonly spellcheck="false" onclick="this.select()">
      <button class="dwork-copy" type="button" onclick="copyClaimLink(this)">Copy</button>
    </div>
    <div class="dwork-note">Send this to the prospect — it signs them straight into their account (Google sign-in also works if it's a Gmail).</div>
  </div>
  ${err}
</div>`;
  }

  // Practice demo in progress (or a target we couldn't resolve — the safe default).
  if (req.isDemo) {
    return `<div class="dwork">
  <div class="dwork-ttl">Practice demo — staged data</div>
  <h2>You're presenting in the demo workspace</h2>
  <p>Every page you open is the real product, reading the demo account's staged data — nothing you click touches your own leads. Exit when the meeting ends, then reset from this panel before the next one.</p>
  <div class="dwork-act">
    <form method="post" action="/demo/exit"><button class="dwork-go" type="submit">Exit demo</button></form>
  </div>
  ${err}
</div>`;
  }

  return `<div class="dwork">
  <div class="dwork-ttl">Practice demo — staged data</div>
  <h2>Enter the demo workspace</h2>
  <p>Opens the real app as a dedicated demo account: 36 leads across Knoxville, Chattanooga and Nashville, a 12-lead pipeline mid-flight, follow-ups coming due, and half a plan of tokens spent. Nothing in there touches your own account — and Reset puts it back exactly as it started.</p>
  <div class="dwork-act">
    <form method="post" action="/demo/enter"><button class="dwork-go" type="submit">Enter demo workspace →</button></form>
    <button class="dwork-reset" type="button" onclick="resetDemoData(this)">Reset demo data</button>
    <span class="dwork-flag" id="dwFlag"></span>
  </div>
  ${err}
</div>
<div class="dwork">
  <div class="dwork-ttl">Live demo for a prospect</div>
  <h2>Present as the prospect, in their own account</h2>
  <p>Type their email and run the meeting from inside their dashboard. At the end, one button hands them a sign-in link — the leads you just found are already in their account.</p>
  <form class="dwork-act" method="post" action="/demo/prospect">
    <input class="dwork-email" type="email" name="email" placeholder="prospect@theircompany.com"
           autocomplete="off" spellcheck="false" autocapitalize="off" required>
    <button class="dwork-go" type="submit">Start prospect demo</button>
  </form>
  <div class="dwork-note">Creates their real account behind the scenes — searches you run will save leads into it. Live scans need the Apify key (<code>APIFY_TOKEN</code>).</div>
</div>`;
}

function renderDemoPage(req, target) {
  return `<!doctype html><html lang="en"><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">${FAVICON}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prospector — Demo</title>${FAVICON}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .demo{max-width:1000px;margin:0 auto;padding:8px 0 80px}
  .dhead{text-align:center;margin:26px 0 34px}
  .dhead h1{font-size:40px;line-height:1.15;font-weight:800;letter-spacing:-.5px;color:var(--text)}
  .dhead p{margin:14px auto 0;max-width:620px;font-size:17px;line-height:1.6;color:var(--muted)}
  .dform{display:grid;grid-template-columns:1.5fr .5fr 1.4fr auto;gap:14px;align-items:end;
         background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px}
  .dform .f{min-width:0}
  .dform label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.7px;
               font-weight:700;color:var(--muted);margin:0 0 8px}
  .dform input{width:100%;font-family:inherit;font-size:20px;font-weight:600;padding:15px 16px;border-radius:11px}
  .dgo{font-family:inherit;font-size:19px;font-weight:800;padding:16px 34px;border-radius:11px;border:none;
       background:var(--accent);color:var(--on-accent);cursor:pointer;white-space:nowrap}
  .dgo:hover{filter:brightness(.96)}
  .dgo:disabled{opacity:.55;cursor:wait}
  .dest{min-height:22px;margin:12px 4px 0;font-size:13px;color:var(--faint);text-align:right}
  .dest b{color:var(--muted);font-weight:700}
  .dsaved{margin-top:26px}
  .dsavedlbl{font-size:11px;text-transform:uppercase;letter-spacing:.7px;font-weight:700;color:var(--muted);margin-bottom:12px}
  .dchips{display:flex;flex-wrap:wrap;gap:10px}
  .dchip{font-family:inherit;font-size:15px;font-weight:600;padding:10px 18px;border-radius:24px;cursor:pointer;
         background:var(--surface2);border:1px solid var(--border);color:var(--text)}
  .dchip:hover{border-color:var(--accent);color:var(--accent-ink)}
  .dchip:disabled{opacity:.5;cursor:wait}
  .dmsg{margin-top:26px;border-radius:12px;padding:18px 20px;font-size:16px;line-height:1.55;
        background:var(--warn-weak);color:var(--warn);border:1px solid var(--border)}
  .dstages{margin-top:34px;display:flex;flex-direction:column;gap:2px}
  .dstage{display:flex;align-items:center;gap:14px;font-size:18px;font-weight:600;color:var(--faint);
          padding:9px 2px;opacity:.45;transition:opacity .25s,color .25s}
  .dstage.run,.dstage.done{opacity:1}
  .dstage.run{color:var(--text)}
  .dstage.done{color:var(--muted)}
  .dmark{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
         font-size:14px;font-weight:800;background:var(--surface2);color:var(--faint)}
  .dstage.run .dmark{background:transparent;border:2px solid var(--accent);border-top-color:transparent;
                     animation:dspin .7s linear infinite;color:transparent}
  .dstage.done .dmark{background:var(--accent-weak);color:var(--accent-ink)}
  @keyframes dspin{to{transform:rotate(360deg)}}
  .dstats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:34px}
  .dstat{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:26px 24px;text-align:center;
         opacity:0;transform:translateY(10px);transition:opacity .45s,transform .45s}
  .dstat.in{opacity:1;transform:none}
  .dstat .n{font-size:56px;line-height:1;font-weight:800;letter-spacing:-1px;color:var(--text);font-variant-numeric:tabular-nums}
  .dstat .l{margin-top:10px;font-size:12px;text-transform:uppercase;letter-spacing:.8px;font-weight:700;color:var(--muted)}
  .dstat.win .n{color:var(--accent)}
  .dnote{margin-top:22px;font-size:15px;color:var(--muted);text-align:center}
  .dnote b{color:var(--accent-ink)}
  .dleads{margin-top:26px;display:flex;flex-direction:column;gap:12px}
  .dlead{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px 22px;
         opacity:0;transform:translateY(14px);transition:opacity .45s,transform .45s}
  .dlead.in{opacity:1;transform:none}
  .dlead h3{font-size:21px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .dbadge{font-size:12px;font-weight:800;letter-spacing:.3px;padding:4px 11px;border-radius:20px;
          background:var(--accent-weak);color:var(--accent-ink);text-transform:uppercase}
  .dmeta{margin-top:9px;font-size:16px;color:var(--muted);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .dphone{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
  .dact{margin-top:11px;display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;
        padding:4px 11px;border-radius:7px;background:var(--accent-weak);color:var(--accent-ink)}
  .dot{color:var(--faint)}
  .dwork{margin-top:26px;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px 24px}
  .dwork-ttl{font-size:11px;text-transform:uppercase;letter-spacing:.7px;font-weight:700;color:var(--muted)}
  .dwork h2{font-size:20px;font-weight:800;letter-spacing:-.2px;color:var(--text);margin:10px 0 7px}
  .dwork p{font-size:14px;line-height:1.6;color:var(--muted);max-width:660px}
  .dwork-act{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:18px}
  .dwork form{margin:0}
  .dwork-go{font-family:inherit;font-size:16px;font-weight:800;padding:13px 24px;border-radius:11px;border:none;
            background:var(--accent);color:var(--on-accent);cursor:pointer;white-space:nowrap}
  .dwork-go:hover{filter:brightness(.96)}
  .dwork-reset{font-family:inherit;font-size:14px;font-weight:600;padding:12px 18px;border-radius:11px;
               background:transparent;border:1px solid var(--border-strong);color:var(--muted);cursor:pointer}
  .dwork-reset:hover{color:var(--text)}
  .dwork-reset:disabled{opacity:.55;cursor:wait}
  .dwork-flag{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted)}
  .dwork-flag.ok{color:var(--accent-ink)}
  .dwork-flag.err{color:var(--danger)}
  .dwork-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--accent);border-top-color:transparent;
              border-radius:50%;animation:dspin .7s linear infinite}
  .dwork-err{margin-top:14px;font-size:13px;line-height:1.55;color:var(--danger)}
  .dwork-note{margin-top:16px;font-size:13px;line-height:1.6;color:var(--muted);background:var(--surface2);
              border:1px solid var(--border);border-radius:10px;padding:14px 16px}
  .dwork-note code{background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:12px;color:var(--text)}
  .dwork-who{color:var(--accent-ink);word-break:break-all}
  .dwork-email{flex:1 1 300px;min-width:0;font-family:inherit;font-size:15px;font-weight:600;
               padding:12px 14px;border-radius:11px}
  .dwork-claim{margin-top:18px}
  .dwork-claim[hidden]{display:none} /* explicit: never let a future SHARED_CSS div rule out-specify the UA sheet */
  .dwork-claimrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .dwork-claimrow input{flex:1 1 340px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
                        font-size:12px;padding:11px 13px;border-radius:10px}
  .dwork-copy{font-family:inherit;font-size:14px;font-weight:700;padding:11px 18px;border-radius:10px;
              border:1px solid var(--border-strong);background:var(--surface2);color:var(--text);cursor:pointer}
  .dwork-copy:hover{border-color:var(--accent);color:var(--accent-ink)}
  .dwork-claim .dwork-note{margin-top:12px}
  @media(max-width:820px){
    .dform{grid-template-columns:1fr 1fr;gap:12px}
    .dgo{grid-column:1/-1;width:100%}
    .dhead h1{font-size:30px}
    .dstats{grid-template-columns:1fr}
    .dstat .n{font-size:44px}
  }
${SHARED_CSS}</style></head><body>
${sidebar("demo", { isAdmin: true, demo: !!req.isDemo })}
<div class="demo">
  <div class="dhead">
    <h1>Which businesses near you have no website?</h1>
    <p>Pick a city and a trade. The machine scans Google, Facebook and Instagram, drops everyone who already has a site, and hands back the ones still open for business.</p>
  </div>

  <div class="dform">
    <div class="f"><label for="city">City</label><input id="city" value="Chattanooga" autocomplete="off" spellcheck="false"></div>
    <div class="f"><label for="state">State</label><input id="state" value="TN" autocomplete="off" spellcheck="false" maxlength="2"></div>
    <div class="f"><label for="niche">Trade</label><input id="niche" value="landscaping" autocomplete="off" spellcheck="false"></div>
    <button class="dgo" id="goBtn" onclick="runDemo()">Find leads</button>
  </div>
  <div class="dest" id="estimate"></div>

  <div class="dsaved" id="savedWrap" style="display:none">
    <div class="dsavedlbl">Saved demos — instant, no credits</div>
    <div class="dchips" id="savedChips"></div>
  </div>

${workspacePanel(req, target)}

  <div class="dmsg" id="msg" style="display:none"></div>
  <div class="dstages" id="stages" style="display:none"></div>
  <div class="dstats" id="stats" style="display:none"></div>
  <div class="dnote" id="note" style="display:none"></div>
  <div class="dleads" id="leads"></div>
</div>
<script>
var RATE_PER_1K = ${JSON.stringify(RATE_PER_1K)};
var TOKENS_PER_USD = ${JSON.stringify(tokensPerUsd())};
var SOURCES = ${JSON.stringify(DEMO_SOURCES)};
var DEPTH = ${JSON.stringify(DEMO_LIMIT)};
</script>
<script>
var STAGES = [
  'Scanning Google Maps\\u2026',
  'Checking Facebook pages\\u2026',
  'Checking Instagram profiles\\u2026',
  'Dropping businesses that already have websites\\u2026',
  'Checking who is still active\\u2026'
];
var CACHED = {};       // cache key -> true (a search we can replay for free)
var busy = false;
var stageTimer = null, stageIdx = 0;

function $(id){return document.getElementById(id)}
function val(id){return $(id).value.trim()}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function nfmt(n){return Number(n||0).toLocaleString()}
function tc(s){return String(s==null?'':s).replace(/\\b[a-z]/g,function(c){return c.toUpperCase()})}

// Mirrors cacheKey() in lib/pipeline.js so the page knows, before firing, whether a
// search comes back free from the cache or spends credits.
function keyFor(niche, city, state, sources, limit){
  return [niche, city, state, sources.slice().sort().join(','), limit]
    .map(function(x){return String(x==null?'':x).trim().toLowerCase()}).join('|');
}
// Typed searches always run at the default depth; clicking a saved demo adopts that
// demo's depth, so hitting "Find leads" straight after replays it free.
var DEPTH_ACTIVE = DEPTH;
function currentQuery(){
  return {niche: val('niche'), city: val('city'), state: val('state'), sources: SOURCES.slice(), limit: DEPTH_ACTIVE};
}

// Same maths as the Prospector's estimate: cities x niches x sources x depth places.
function updateEstimate(){
  var q = currentQuery();
  var el = $('estimate');
  if(!q.niche || !q.city){ el.innerHTML=''; return }
  if(CACHED[keyFor(q.niche,q.city,q.state,q.sources,q.limit)]){
    el.innerHTML = 'Saved search \\u2014 <b>replays free</b>';
    return;
  }
  var places = q.sources.length * q.limit;
  var tokens = Math.round((places/1000) * RATE_PER_1K * TOKENS_PER_USD);
  el.innerHTML = 'live scan \\u2248 <b>' + nfmt(tokens) + ' tokens</b>';
}

// ── staged progress ────────────────────────────────────────────────────────
function paintStages(){
  $('stages').innerHTML = STAGES.map(function(s,i){
    return '<div class="dstage" id="stage-'+i+'"><span class="dmark">\\u2713</span><span>'+esc(s)+'</span></div>';
  }).join('');
  $('stages').style.display='';
}
function markStage(i, cls){
  var el = $('stage-'+i);
  if(el) el.className = 'dstage' + (cls?' '+cls:'');
}
function startStages(step){
  stageIdx = 0;
  paintStages();
  markStage(0,'run');
  // Hold on the last stage until the response lands — the machine is still working.
  stageTimer = setInterval(function(){
    if(stageIdx < STAGES.length-1){ markStage(stageIdx,'done'); stageIdx++; markStage(stageIdx,'run'); }
  }, step);
}
async function finishStages(){
  clearInterval(stageTimer); stageTimer=null;
  while(stageIdx < STAGES.length){
    markStage(stageIdx,'done');
    stageIdx++;
    if(stageIdx < STAGES.length){ markStage(stageIdx,'run'); await sleep(130) }
  }
}

// ── reveal ─────────────────────────────────────────────────────────────────
function countUp(el, to){
  var start = performance.now(), dur = 900, settled = false;
  function frame(now){
    var t = Math.min(1,(now-start)/dur);
    var eased = 1-Math.pow(1-t,3);
    el.textContent = nfmt(Math.round(to*eased));
    if(t<1) requestAnimationFrame(frame); else settled = true;
  }
  requestAnimationFrame(frame);
  // rAF is paused in a hidden/throttled tab — make sure the real number still lands.
  setTimeout(function(){ if(!settled) el.textContent = nfmt(to) }, dur+400);
}
function statBox(label, cls){
  return '<div class="dstat '+(cls||'')+'"><div class="n">0</div><div class="l">'+esc(label)+'</div></div>';
}
function leadCard(p){
  var where = [p.city, p.state].filter(Boolean).join(', ');
  var bits = [];
  if(p.category) bits.push('<span>'+esc(p.category)+'</span>');
  if(where) bits.push('<span>'+esc(where)+'</span>');
  bits.push('<span class="dphone">'+esc(p.phone||'no phone listed')+'</span>');
  var act = p.lastActive
    ? '<div><span class="dact">\\u25CF Active \\u00b7 '+esc(p.lastActive)+(p.activeSignal?' \\u00b7 '+esc(p.activeSignal):'')+'</span></div>'
    : '';
  return '<div class="dlead"><h3>'+esc(p.name)+'<span class="dbadge">no website</span></h3>'+
    '<div class="dmeta">'+bits.join('<span class="dot">\\u00b7</span>')+'</div>'+act+'</div>';
}
async function reveal(r){
  var s = r.stats || {};
  var prospects = r.prospects || [];
  var scanned = Number(s.scanned||0);
  var hadSite = Number(s.hasWebsite||0);
  var leads = prospects.length;

  $('stats').innerHTML = statBox('Businesses scanned') + statBox('Already had a site') + statBox('No-website leads','win');
  $('stats').style.display='';
  var boxes = $('stats').querySelectorAll('.dstat');
  var nums = [scanned, hadSite, leads];
  for(var i=0;i<boxes.length;i++){
    (function(box,n,idx){
      setTimeout(function(){ box.classList.add('in'); countUp(box.querySelector('.n'), n) }, idx*180);
    })(boxes[i], nums[i], i);
  }
  await sleep(boxes.length*180 + 500);

  var note = $('note');
  note.innerHTML = leads
    ? '<b>'+nfmt(leads)+'</b> business'+(leads===1?'':'es')+' in '+esc(tc(val('city'))||'this city')+' with no website of their own'+
      (r.cached ? ' &nbsp;\\u00b7&nbsp; saved demo, no credits used' : '')
    : 'No no-website leads this time \\u2014 try another trade or a nearby city.';
  note.style.display='';

  $('leads').innerHTML = prospects.map(leadCard).join('');
  var cards = $('leads').querySelectorAll('.dlead');
  for(var j=0;j<cards.length;j++){
    (function(card,idx){ setTimeout(function(){ card.classList.add('in') }, idx*150) })(cards[j], j);
  }
}

function showMsg(html){ var m=$('msg'); m.innerHTML=html; m.style.display='' }
function clearScreen(){
  $('msg').style.display='none';
  $('stats').style.display='none'; $('stats').innerHTML='';
  $('note').style.display='none'; $('note').innerHTML='';
  $('leads').innerHTML='';
}

// ── run ────────────────────────────────────────────────────────────────────
async function runDemo(preset){
  if(busy) return;
  var q = preset || currentQuery();
  if(preset){
    $('city').value = tc(preset.city);
    $('state').value = (preset.state||'').toUpperCase();
    $('niche').value = tc(preset.niche);
    DEPTH_ACTIVE = preset.limit || DEPTH;
  }
  if(!q.niche || !q.city){ clearScreen(); showMsg('Enter a city and a trade first.'); return }

  var cached = !!CACHED[keyFor(q.niche,q.city,q.state,q.sources,q.limit)];
  busy = true;
  $('goBtn').disabled = true;
  var chips = document.querySelectorAll('.dchip');
  for(var i=0;i<chips.length;i++) chips[i].disabled = true;
  clearScreen();
  updateEstimate();

  var t0 = Date.now();
  startStages(cached ? 380 : 1500);

  var r = null, failed = false;
  try{
    var resp = await fetch('/api/search', {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({niche:q.niche, city:q.city, state:q.state, sources:q.sources, limit:q.limit})
    });
    r = await resp.json().catch(function(){return null});
    if(!resp.ok && !r) failed = true;
  }catch(e){ failed = true }

  // A cached replay answers in milliseconds — hold the animation to ~2s so the room
  // still sees the machine work.
  if(cached){ var wait = 1800-(Date.now()-t0); if(wait>0) await sleep(wait) }
  await finishStages();

  busy = false;
  $('goBtn').disabled = false;
  for(var k=0;k<chips.length;k++) chips[k].disabled = false;

  if(failed || !r || !r.ok){
    $('stages').style.display='none';
    var err = (r && r.error) ? String(r.error) : '';
    // Only the "no Apify credentials" family gets the canned line — a plan/cap 429
    // already carries a clean, specific sentence of its own.
    var apify = !err || /apify_token|apify token|apify key|actor|authentication/i.test(err);
    showMsg(apify
      ? 'Live scanning needs an Apify key (APIFY_TOKEN). Pick a saved demo below instead.'
      : esc(err));
    return;
  }
  if(r.cached) CACHED[keyFor(q.niche,q.city,q.state,q.sources,q.limit)] = true;
  updateEstimate();
  await reveal(r);
}

// ── saved demos ────────────────────────────────────────────────────────────
var SAVED = [];
function chipClick(i){ var s = SAVED[i]; if(s) runDemo(s) }
async function loadSaved(){
  try{
    var r = await (await fetch('/demo/api/saved',{headers:{'Accept':'application/json'}})).json();
    if(!r || !r.ok) return;
    (r.keys||[]).forEach(function(k){ CACHED[String(k).trim().toLowerCase()] = true });
    SAVED = r.saved || [];
    if(SAVED.length){
      $('savedChips').innerHTML = SAVED.map(function(s,i){
        return '<button type="button" class="dchip" onclick="chipClick('+i+')">'+esc(s.label)+'</button>';
      }).join('');
      $('savedWrap').style.display='';
    }
    updateEstimate();
  }catch(e){}
}

// ── demo workspace ─────────────────────────────────────────────────────────
// Reset reports what it actually wrote, and on failure names the step that broke —
// enough to diagnose it from the projector without opening a log.
async function resetDemoData(btn){
  var flag = $('dwFlag');
  btn.disabled = true;
  flag.className = 'dwork-flag';
  flag.innerHTML = '<span class="dwork-spin"></span> Reseeding\\u2026';
  try{
    var resp = await fetch('/demo/api/reset',{method:'POST',headers:{'Accept':'application/json'}});
    var j = await resp.json().catch(function(){return null});
    if(j && j.ok){
      var s = j.seeded || {};
      flag.className = 'dwork-flag ok';
      flag.textContent = '\\u2713 ' + nfmt(s.leads) + ' leads \\u00b7 ' + nfmt(s.saved) + ' tracked \\u00b7 ' +
        nfmt(s.followups) + ' follow-ups \\u00b7 ' + nfmt(s.checked) + ' remembered \\u00b7 ' +
        nfmt(s.tokensUsed) + ' tokens used';
    }else{
      flag.className = 'dwork-flag err';
      flag.textContent = '\\u2715 ' + ((j && j.step) ? j.step + ': ' : '') + ((j && j.error) || 'Reset failed');
    }
  }catch(e){
    flag.className = 'dwork-flag err';
    flag.textContent = '\\u2715 Reset failed \\u2014 the server did not answer.';
  }
  btn.disabled = false;
}

// ── prospect demo: the handoff link ────────────────────────────────────────
// Minted on demand rather than on page load: it is a one-shot credential for the
// prospect's account, so it only exists once the operator has asked for it.
async function getClaimLink(btn){
  var flag = $('clFlag'), wrap = $('clWrap');
  btn.disabled = true;
  flag.className = 'dwork-flag';
  flag.innerHTML = '<span class="dwork-spin"></span> Creating the link\\u2026';
  try{
    var resp = await fetch('/demo/api/claim-link',{method:'POST',headers:{'Accept':'application/json'}});
    var j = await resp.json().catch(function(){return null});
    if(j && j.ok && j.link){
      $('clLink').value = j.link;
      wrap.hidden = false;
      flag.className = 'dwork-flag ok';
      flag.textContent = '\\u2713 Link ready for ' + (j.email || 'the prospect');
      $('clLink').focus(); $('clLink').select();
    }else{
      flag.className = 'dwork-flag err';
      flag.textContent = '\\u2715 ' + ((j && j.error) || 'Could not create the link');
    }
  }catch(e){
    flag.className = 'dwork-flag err';
    flag.textContent = '\\u2715 Could not create the link \\u2014 the server did not answer.';
  }
  btn.disabled = false;
}

function copyClaimLink(btn){
  var input = $('clLink');
  input.focus(); input.select(); input.setSelectionRange(0, 99999);
  var done = false;
  // execCommand first: navigator.clipboard needs a secure context, which a demo
  // running over plain http on a laptop or a projector box will not have.
  try{ done = document.execCommand('copy') }catch(e){}
  var finish = function(ok){
    var was = btn.textContent;
    btn.textContent = ok ? '\\u2713 Copied' : 'Press \\u2318C';
    setTimeout(function(){ btn.textContent = was }, 1600);
  };
  if(done){ finish(true); return }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(input.value).then(function(){finish(true)},function(){finish(false)});
  }else finish(false);
}

['city','state','niche'].forEach(function(id){
  var el = $(id);
  el.addEventListener('input', function(){ DEPTH_ACTIVE = DEPTH; updateEstimate() });
  el.addEventListener('keydown', function(e){ if(e.key==='Enter') runDemo() });
});
updateEstimate();
loadSaved();
</script>
${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

export default demoRouter;
