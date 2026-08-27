// store.js — the one data layer the app talks to. Async, and USER-SCOPED: every
// function takes `userId` first.
//
// Two providers behind DATA_PROVIDER (see lib/supabase.js):
//   sqlite   → wraps the existing synchronous functions in data/db.js. Single local
//              user, so userId is accepted and ignored ("local").
//   supabase → service-role Postgres client. The service role BYPASSES row-level
//              security, so every single query here carries an explicit
//              .eq("user_id", userId). That app-level scoping is what keeps one
//              user's leads out of another user's dashboard.
//
// Supabase rows are normalized back to the SQLite shape callers already expect:
// lead_json / site_data come back as JSON *strings* (they're jsonb in Postgres),
// timestamps stay strings. Booleans may be real booleans — call sites use truthiness.
//
// PostgREST caps un-ranged selects at 1000 rows, which silently truncates the brain
// and the leads list. Every potentially-big select below asks for an explicit
// .range(0, BIG) and pure counts use { count: "exact", head: true }.

import { dataProvider, getSupabase } from "../lib/supabase.js";

const BIG = 4999; // upper bound for "give me everything" selects (0-indexed, inclusive)

const isSupabase = () => dataProvider() === "supabase";

// data/db.js opens (and migrates) the SQLite file at import time, so it's loaded
// lazily — a Supabase deployment never touches better-sqlite3 or the .db file.
let _db = null;
async function db() {
  if (!_db) _db = await import("./db.js");
  return _db;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

const nowIso = () => new Date().toISOString();

// Start of the current calendar month, UTC (matches SQLite's datetime('now','start of month')).
function monthStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// jsonb → the JSON string SQLite callers parse.
const jsonText = (v) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));

function leadRow(r) {
  if (!r) return r;
  return { ...r, lead_json: jsonText(r.lead_json), site_data: jsonText(r.site_data) };
}

// Canonical key identifying the SAME business across sources. Mirrors dedupKeyFor()
// in data/db.js — duplicated (not imported) so the Supabase path never loads SQLite.
export function dedupKeyFor({ phone, name, city } = {}) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length >= 10) return "p:" + digits.slice(-10);
  const n = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return "";
  const c = String(city || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `n:${n}|${c}`;
}

// ── Leads ────────────────────────────────────────────────────────────────────

// Insert a scraped lead (or refresh its scraped fields), always returning the row id.
// Pipeline/CRM state (status, saved, notes, dismissed…) is deliberately NOT in the
// payload, so an upsert never resets what the user has done with the lead.
export async function upsertLeadReturningId(userId, lead) {
  if (!isSupabase()) return (await db()).upsertLeadReturningId(lead);

  const c = await getSupabase();
  const row = {
    user_id: userId,
    source: lead.source,
    external_id: String(lead.externalId || lead.name || ""),
    name: lead.name ?? "",
    category: lead.category ?? "",
    city: lead.city ?? "",
    state: lead.state ?? "",
    website: lead.website ?? "",
    lead_json: lead,
    dedup_key: dedupKeyFor(lead),
  };
  // Only send phone/email when we actually scraped one, so a later thinner scrape
  // can't wipe a contact we already have (mirrors the COALESCE/NULLIF in db.js).
  if (lead.phone) row.phone = lead.phone;
  if (lead.email) row.email = lead.email;

  const data = must(
    await c.from("leads").upsert(row, { onConflict: "user_id,source,external_id" }).select("id").single(),
    "upsertLead"
  );
  return data?.id;
}

export async function getLead(userId, id) {
  if (!isSupabase()) return (await db()).getLead(id);
  const c = await getSupabase();
  const data = must(
    await c.from("leads").select("*").eq("user_id", userId).eq("id", Number(id)).maybeSingle(),
    "getLead"
  );
  return leadRow(data);
}

// Fetch leads by id list, preserving the given order, skipping dismissed ones.
export async function getLeadsByIds(userId, ids = []) {
  if (!isSupabase()) return (await db()).getLeadsByIds(ids);
  const list = (ids || []).map(Number).filter((n) => Number.isFinite(n));
  if (!list.length) return [];
  const c = await getSupabase();
  const data = must(
    await c
      .from("leads")
      .select("*")
      .eq("user_id", userId)
      .eq("dismissed", false)
      .in("id", list)
      .range(0, BIG),
    "getLeadsByIds"
  );
  const byId = new Map((data || []).map((r) => [r.id, leadRow(r)]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

export async function listLeads(userId, status) {
  if (!isSupabase()) return (await db()).listLeads(status);
  const c = await getSupabase();
  let q = c.from("leads").select("*").eq("user_id", userId);
  if (status) q = q.eq("status", status);
  const data = must(await q.order("created_at", { ascending: false }).range(0, BIG), "listLeads");
  return (data || []).map(leadRow);
}

// Every lead ever surfaced, newest first — powers the "found" tab of /leads.
// Deliberately SLIM: only the columns that tab renders. lead_json/site_data are the
// two fat jsonb columns and neither is used there, so leaving them out keeps this
// page fast even for a user with thousands of leads. Capped at 2000 rows (the tab
// renders the newest 500 and filters client-side).
const FOUND_COLS = "id,source,name,category,city,state,phone,email,status,created_at,saved,crm_stage,contacted_on";
export async function listAllLeads(userId) {
  if (!isSupabase()) return listLeads(userId);
  const c = await getSupabase();
  const data = must(
    await c
      .from("leads")
      .select(FOUND_COLS)
      .eq("user_id", userId)
      .eq("dismissed", false)
      .order("created_at", { ascending: false })
      .range(0, 1999),
    "listAllLeads"
  );
  return data || [];
}

// [{ status, n }] — same shape SQLite's GROUP BY returns.
const LEAD_STATUSES = ["new", "preview_built", "sent", "skipped"];
export async function counts(userId) {
  if (!isSupabase()) return (await db()).counts();
  const c = await getSupabase();
  const out = [];
  for (const status of LEAD_STATUSES) {
    const { count, error } = await c
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", status);
    if (error) throw new Error(`counts: ${error.message}`);
    if (count) out.push({ status, n: count });
  }
  return out;
}

export async function dismissLead(userId, id) {
  if (!isSupabase()) return (await db()).dismissLead(id);
  const c = await getSupabase();
  const row = must(
    await c.from("leads").select("dedup_key").eq("user_id", userId).eq("id", Number(id)).maybeSingle(),
    "dismissLead"
  );
  must(await c.from("leads").update({ dismissed: true }).eq("user_id", userId).eq("id", Number(id)), "dismissLead");
  // Cascade to the SAME business found via another source, so it can't reappear.
  if (row?.dedup_key) {
    must(
      await c.from("leads").update({ dismissed: true }).eq("user_id", userId).eq("dedup_key", row.dedup_key),
      "dismissLead cascade"
    );
  }
}

// Set of "source|external_id" for every dismissed business, to filter search results.
export async function dismissedKeys(userId) {
  if (!isSupabase()) return (await db()).dismissedKeys();
  const c = await getSupabase();
  const data = must(
    await c.from("leads").select("source,external_id").eq("user_id", userId).eq("dismissed", true).range(0, BIG),
    "dismissedKeys"
  );
  return new Set((data || []).map((r) => `${r.source}|${r.external_id}`));
}

// ── Activity feedback (was our "last active" tag right?) ─────────────────────
export async function setActivityFeedback(userId, id, verdict, seen = "") {
  if (!isSupabase()) return (await db()).setActivityFeedback(id, verdict, seen);
  const v = verdict === "correct" || verdict === "wrong" ? verdict : null;
  const c = await getSupabase();
  must(
    await c
      .from("leads")
      .update({ activity_verdict: v, activity_verdict_at: nowIso(), activity_seen: seen })
      .eq("user_id", userId)
      .eq("id", Number(id)),
    "setActivityFeedback"
  );
}

// [{ verdict, n }]
export async function activityFeedbackCounts(userId) {
  if (!isSupabase()) return (await db()).activityFeedbackCounts();
  const c = await getSupabase();
  const data = must(
    await c
      .from("leads")
      .select("activity_verdict")
      .eq("user_id", userId)
      .not("activity_verdict", "is", null)
      .range(0, BIG),
    "activityFeedbackCounts"
  );
  const tally = new Map();
  for (const r of data || []) tally.set(r.activity_verdict, (tally.get(r.activity_verdict) || 0) + 1);
  return [...tally].map(([verdict, n]) => ({ verdict, n }));
}

// ── App state (last search, etc.) ────────────────────────────────────────────
export async function setState(userId, key, value) {
  if (!isSupabase()) return (await db()).setState(key, value);
  const c = await getSupabase();
  must(
    await c.from("app_state").upsert({ user_id: userId, key, value }, { onConflict: "user_id,key" }),
    "setState"
  );
}

export async function getState(userId, key) {
  if (!isSupabase()) return (await db()).getState(key);
  const c = await getSupabase();
  const data = must(
    await c.from("app_state").select("value").eq("user_id", userId).eq("key", key).maybeSingle(),
    "getState"
  );
  return data ? data.value : null; // jsonb comes back already parsed
}

// ── Search cache (a repeated search costs nothing) ───────────────────────────
export async function getSearchCache(userId, key) {
  if (!isSupabase()) return (await db()).getSearchCache(key);
  const c = await getSupabase();
  const r = must(
    await c.from("searches").select("data,updated_at").eq("user_id", userId).eq("key", key).maybeSingle(),
    "getSearchCache"
  );
  return r ? { ...(r.data || {}), updatedAt: r.updated_at } : null;
}

export async function saveSearchCache(userId, key, data) {
  if (!isSupabase()) return (await db()).saveSearchCache(key, data);
  const c = await getSupabase();
  must(
    await c
      .from("searches")
      .upsert({ user_id: userId, key, data, updated_at: nowIso() }, { onConflict: "user_id,key" }),
    "saveSearchCache"
  );
}

// Every cached search this user has, newest first: [{ key, updated_at }]. Keys only —
// the demo page turns them back into "niche · city ST" chips it can replay for free.
export async function listSearchCache(userId) {
  if (!isSupabase()) {
    // db.js default-exports the better-sqlite3 handle; still a lazy import, so the
    // Supabase path never loads better-sqlite3.
    const sqlite = (await db()).default;
    return sqlite.prepare(`SELECT key, updated_at FROM searches ORDER BY updated_at DESC LIMIT 500`).all();
  }
  const c = await getSupabase();
  return (
    must(
      await c
        .from("searches")
        .select("key,updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .range(0, 499),
      "listSearchCache"
    ) || []
  );
}

// ── The brain: every business ever scanned ───────────────────────────────────
export async function recordChecked(userId, rows = []) {
  if (!isSupabase()) return (await db()).recordChecked(rows);
  if (!rows.length) return;
  const c = await getSupabase();
  // Collapse duplicates inside the batch — Postgres rejects an ON CONFLICT that hits
  // the same key twice in one statement.
  const byKey = new Map();
  for (const b of rows) {
    const key = `${b.source}|${b.external_id}`;
    byKey.set(key, {
      user_id: userId,
      source: b.source,
      external_id: String(b.external_id),
      name: b.name ?? "",
      has_website: !!b.has_website,
      niche: b.niche ?? "",
      city: b.city ?? "",
      state: b.state ?? "",
      checked_at: nowIso(),
    });
  }
  const all = [...byKey.values()];
  for (let i = 0; i < all.length; i += 500) {
    must(
      await c
        .from("checked_businesses")
        .upsert(all.slice(i, i + 500), { onConflict: "user_id,source,external_id" }),
      "recordChecked"
    );
  }
}

export async function checkedStats(userId) {
  if (!isSupabase()) return (await db()).checkedStats();
  const c = await getSupabase();
  const total = await c
    .from("checked_businesses")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (total.error) throw new Error(`checkedStats: ${total.error.message}`);
  const withSite = await c
    .from("checked_businesses")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("has_website", true);
  if (withSite.error) throw new Error(`checkedStats: ${withSite.error.message}`);
  return { total: total.count || 0, withSite: withSite.count || 0 };
}

export async function listCheckedBusinesses(userId, { noSiteOnly = false } = {}) {
  if (!isSupabase()) return (await db()).listCheckedBusinesses({ noSiteOnly });
  const c = await getSupabase();
  let q = c
    .from("checked_businesses")
    .select("source,external_id,name,has_website,niche,city,state,checked_at")
    .eq("user_id", userId);
  if (noSiteOnly) q = q.eq("has_website", false);
  return must(await q.order("checked_at", { ascending: false }).range(0, BIG), "listCheckedBusinesses") || [];
}

// ── CRM ──────────────────────────────────────────────────────────────────────
export async function saveToCrm(userId, id) {
  if (!isSupabase()) return (await db()).saveToCrm(id);
  const c = await getSupabase();
  const row = must(
    await c.from("leads").select("saved_at").eq("user_id", userId).eq("id", Number(id)).maybeSingle(),
    "saveToCrm"
  );
  const patch = row?.saved_at ? { saved: true } : { saved: true, saved_at: nowIso() };
  must(await c.from("leads").update(patch).eq("user_id", userId).eq("id", Number(id)), "saveToCrm");
}

export async function removeFromCrm(userId, id) {
  if (!isSupabase()) return (await db()).removeFromCrm(id);
  const c = await getSupabase();
  must(await c.from("leads").update({ saved: false }).eq("user_id", userId).eq("id", Number(id)), "removeFromCrm");
}

export async function updateCrm(userId, id, { stage, notes } = {}) {
  if (!isSupabase()) return (await db()).updateCrm(id, { stage, notes });
  const patch = {};
  if (stage !== undefined) {
    patch.crm_stage = stage;
    if (stage === "Contacted") patch.contacted_on = nowIso(); // starts the follow-up clock
  }
  if (notes !== undefined) patch.notes = notes;
  if (!Object.keys(patch).length) return;
  const c = await getSupabase();
  must(await c.from("leads").update(patch).eq("user_id", userId).eq("id", Number(id)), "updateCrm");
}

// The old flat CRM listing: every saved lead (optionally one stage), newest first.
// listCrm() now returns the bucketed shape below, so callers that want one plain array
// call this instead.
export async function listCrmFlat(userId, stage) {
  if (!isSupabase()) return (await db()).listCrm(stage);
  const c = await getSupabase();
  let q = c.from("leads").select("*").eq("user_id", userId).eq("saved", true);
  if (stage) q = q.eq("crm_stage", stage);
  const data = must(await q.order("saved_at", { ascending: false }).range(0, BIG), "listCrmFlat");
  return (data || []).map(leadRow);
}

// [{ crm_stage, n }] — same shape SQLite's GROUP BY returns (zero rows omitted).
// One HEAD count per stage instead of pulling every saved row back just to tally it:
// the five run in parallel, and nothing but the counts crosses the wire.
const CRM_STAGES = ["New", "Contacted", "Interested", "Won", "Lost"];
export async function crmCounts(userId) {
  if (!isSupabase()) return (await db()).crmCounts();
  const c = await getSupabase();
  const results = await Promise.all(
    CRM_STAGES.map((crm_stage) =>
      c
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("saved", true)
        .eq("crm_stage", crm_stage)
        .then(({ count, error }) => {
          if (error) throw new Error(`crmCounts: ${error.message}`);
          return { crm_stage, n: count || 0 };
        })
    )
  );
  return results.filter((r) => r.n);
}

// ── CRM buckets ──────────────────────────────────────────────────────────────
// A search sorts its results into three buckets; each one has a working list and a
// follow-up list. A lead's bucket lives on leads.bucket, and leads.follow_up_at decides
// which of the two lists it sits in (null = working).
//
// CRM_BUCKETS / normalizeBucket mirror data/db.js, duplicated (not imported) for the same
// reason dedupKeyFor is: the Supabase path must never load better-sqlite3.
export const CRM_BUCKETS = ["qualified", "inactive", "has_website"];
const BUCKET_SET = new Set(CRM_BUCKETS);
function normalizeBucket(b) {
  return BUCKET_SET.has(b) ? b : "qualified";
}

// lead_json is jsonb in Postgres but a JSON string on a row that came back from the store.
// Never let a malformed string throw: fall back to the prospect object itself.
function leadJsonOf(p) {
  if (typeof p.lead_json !== "string") return p.lead_json ?? p;
  try {
    return JSON.parse(p.lead_json) ?? p;
  } catch {
    return p;
  }
}

// A search-result prospect arrives either as a raw scraped lead (externalId, camelCase) or
// as the lead ROW discover() already stored (external_id). Accept both.
function crmRowFrom(p, bucket, userId) {
  if (!p) return null;
  const source = p.source ?? "";
  const externalId = String(p.external_id ?? p.externalId ?? p.id ?? p.name ?? "");
  if (!source || !externalId) return null;
  return {
    user_id: userId,
    source,
    external_id: externalId,
    name: p.name ?? "",
    category: p.category ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    phone: p.phone ?? "",
    email: p.email ?? "",
    website: p.website ?? "",
    lead_json: leadJsonOf(p),
    dedup_key: dedupKeyFor(p),
    saved: true,
    saved_at: nowIso(),
    crm_stage: "New",
    status: "new",
    bucket,
    follow_up_at: null,
  };
}

// Move search-result prospects into this user's CRM under one bucket.
// Returns { added, skipped }; added + skipped always equals prospects.length.
// A prospect the user already has in the CRM is SKIPPED, never rewritten, so its stage,
// status and notes survive. A lead that exists but was never saved is adopted into the
// CRM (counted as added) with its stage/status/notes left untouched.
export async function moveToCrm(userId, prospects, bucket) {
  const b = normalizeBucket(bucket);
  const total = (prospects || []).length;
  if (!isSupabase()) return (await db()).moveToCrm(prospects || [], b);
  if (!total) return { added: 0, skipped: 0 };

  const byKey = new Map(); // collapse duplicates inside the batch
  for (const p of prospects || []) {
    const row = crmRowFrom(p, b, userId);
    if (row) byKey.set(`${row.source}|${row.external_id}`, row);
  }
  const rows = [...byKey.values()];
  if (!rows.length) return { added: 0, skipped: total };

  const c = await getSupabase();

  // Which of these does the user already have? PostgREST can't filter on a composite key,
  // so ask for the union of sources and external_ids and match the exact pairs here.
  const existing = new Map();
  const ids = [...new Set(rows.map((r) => r.external_id))];
  const sources = [...new Set(rows.map((r) => r.source))];
  for (let i = 0; i < ids.length; i += 200) {
    const data = must(
      await c
        .from("leads")
        .select("id,source,external_id,saved,saved_at")
        .eq("user_id", userId)
        .in("source", sources)
        .in("external_id", ids.slice(i, i + 200))
        .range(0, BIG),
      "moveToCrm lookup"
    );
    for (const r of data || []) existing.set(`${r.source}|${r.external_id}`, r);
  }

  const toInsert = [];
  const adoptFresh = []; // never saved before: stamp saved_at now
  const adoptAgain = []; // saved once before: keep the original saved_at
  for (const row of rows) {
    const hit = existing.get(`${row.source}|${row.external_id}`);
    if (!hit) toInsert.push(row);
    else if (hit.saved) continue; // already in the CRM
    else (hit.saved_at ? adoptAgain : adoptFresh).push(hit.id);
  }

  let added = 0;
  // ignoreDuplicates maps to ON CONFLICT DO NOTHING, so a lead created between the lookup
  // and here is left alone rather than clobbered; the returned rows are the real inserts.
  for (let i = 0; i < toInsert.length; i += 200) {
    const data = must(
      await c
        .from("leads")
        .upsert(toInsert.slice(i, i + 200), { onConflict: "user_id,source,external_id", ignoreDuplicates: true })
        .select("id"),
      "moveToCrm insert"
    );
    added += (data || []).length;
  }
  for (const [list, patch] of [
    [adoptFresh, { saved: true, saved_at: nowIso(), bucket: b, follow_up_at: null }],
    [adoptAgain, { saved: true, bucket: b, follow_up_at: null }],
  ]) {
    for (let i = 0; i < list.length; i += 200) {
      must(
        await c.from("leads").update(patch).eq("user_id", userId).in("id", list.slice(i, i + 200)),
        "moveToCrm adopt"
      );
      added += list.slice(i, i + 200).length;
    }
  }
  return { added, skipped: total - added };
}

// whenISO = an ISO timestamp to schedule the follow-up, or null to clear it (back to working).
export async function setFollowUp(userId, leadId, whenISO) {
  if (!isSupabase()) return (await db()).setFollowUp(leadId, whenISO);
  const c = await getSupabase();
  must(
    await c.from("leads").update({ follow_up_at: whenISO || null }).eq("user_id", userId).eq("id", Number(leadId)),
    "setFollowUp"
  );
}

export async function setLeadBucket(userId, leadId, bucket) {
  if (!isSupabase()) return (await db()).setLeadBucket(leadId, bucket);
  const c = await getSupabase();
  must(
    await c.from("leads").update({ bucket: normalizeBucket(bucket) }).eq("user_id", userId).eq("id", Number(leadId)),
    "setLeadBucket"
  );
}

// { qualified: {working, followups}, inactive: {...}, has_website: {...} }
// working   = saved, not dismissed, no follow-up date, newest saved first.
// followups = saved, not dismissed, has a follow-up date, soonest first.
export async function listCrm(userId) {
  if (!isSupabase()) return (await db()).listCrmBuckets();
  const c = await getSupabase();
  const base = () => c.from("leads").select("*").eq("user_id", userId).eq("saved", true).eq("dismissed", false);
  const [working, followups] = await Promise.all([
    base().is("follow_up_at", null).order("saved_at", { ascending: false }).range(0, BIG),
    base().not("follow_up_at", "is", null).order("follow_up_at", { ascending: true }).range(0, BIG),
  ]);
  const out = {};
  for (const b of CRM_BUCKETS) out[b] = { working: [], followups: [] };
  for (const r of must(working, "listCrm working") || []) out[normalizeBucket(r.bucket)].working.push(leadRow(r));
  for (const r of must(followups, "listCrm followups") || []) out[normalizeBucket(r.bucket)].followups.push(leadRow(r));
  return out;
}

// ── Global business directory (operator-owned, cross-user) ───────────────────
// EVERY business ever scanned by ANY user, deduped on (source, external_id). No user_id:
// this is deliberately global. In Supabase the table has RLS on with ZERO policies, so it
// is unreachable from any client JWT; only the service-role client below can touch it.
function directoryRowFrom(b) {
  if (!b) return null;
  const source = b.source ?? "";
  const externalId = String(b.external_id ?? b.externalId ?? b.id ?? b.name ?? "");
  if (!source || !externalId) return null;
  const site = b.has_website ?? b.hasWebsite;
  return {
    source,
    external_id: externalId,
    name: b.name ?? null,
    niche: b.niche ?? null,
    city: b.city ?? null,
    state: b.state ?? null,
    phone: b.phone ?? null,
    email: b.email ?? null,
    website: b.website ?? null,
    has_website: site === undefined || site === null ? null : !!site,
  };
}

// Upsert into the global directory. Returns { upserted } (distinct keys written).
// On conflict Postgres refreshes last_seen and only overwrites name/phone/email/website/
// has_website when the new value is non-null; first_seen never moves. That merge lives in
// the business_directory_merge() BEFORE UPDATE trigger, because PostgREST can't express a
// custom ON CONFLICT SET clause.
export async function recordDirectory(businesses) {
  if (!isSupabase()) return (await db()).recordDirectory(businesses || []);
  const byKey = new Map();
  for (const b of businesses || []) {
    const row = directoryRowFrom(b);
    if (row) byKey.set(`${row.source}|${row.external_id}`, row);
  }
  const all = [...byKey.values()];
  if (!all.length) return { upserted: 0 };
  const c = await getSupabase(); // service-role: the only client RLS lets near this table
  for (let i = 0; i < all.length; i += 200) {
    must(
      await c.from("business_directory").upsert(all.slice(i, i + 200), { onConflict: "source,external_id" }),
      "recordDirectory"
    );
  }
  return { upserted: all.length };
}

// ── Manual follow-ups (the user's own reminders) ─────────────────────────────
export async function addFollowup(userId, { title, note, due } = {}) {
  if (!isSupabase()) return (await db()).addFollowup({ title, note, due });
  const c = await getSupabase();
  const data = must(
    await c
      .from("manual_followups")
      .insert({ user_id: userId, title, note: note || "", due: due || null })
      .select("id")
      .single(),
    "addFollowup"
  );
  return data?.id;
}

export async function listFollowups(userId) {
  if (!isSupabase()) return (await db()).listFollowups();
  const c = await getSupabase();
  // open items first, soonest due first, then newest.
  return (
    must(
      await c
        .from("manual_followups")
        .select("*")
        .eq("user_id", userId)
        .order("done", { ascending: true })
        .order("due", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .range(0, BIG),
      "listFollowups"
    ) || []
  );
}

export async function updateFollowup(userId, id, { note, due, done } = {}) {
  if (!isSupabase()) return (await db()).updateFollowup(id, { note, due, done });
  const patch = {};
  if (note !== undefined) patch.note = note;
  if (due !== undefined) patch.due = due || null;
  if (done !== undefined) patch.done = !!done;
  if (!Object.keys(patch).length) return;
  const c = await getSupabase();
  must(
    await c.from("manual_followups").update(patch).eq("user_id", userId).eq("id", Number(id)),
    "updateFollowup"
  );
}

export async function removeFollowup(userId, id) {
  if (!isSupabase()) return (await db()).removeFollowup(id);
  const c = await getSupabase();
  must(
    await c.from("manual_followups").delete().eq("user_id", userId).eq("id", Number(id)),
    "removeFollowup"
  );
}

// ── Usage metering (per user, per calendar month) ────────────────────────────
// cost is the ESTIMATED USD for the action; the UI turns it into tokens.
export async function logUsage(userId, kind, costUsd = 0) {
  if (!isSupabase()) return (await db()).logUsage(kind, costUsd);
  const c = await getSupabase();
  must(await c.from("usage_log").insert({ user_id: userId, kind, cost: Number(costUsd) || 0 }), "logUsage");
}

// { searches, builds, aiUsd } for the current calendar month.
export async function usageSummary(userId) {
  if (!isSupabase()) return (await db()).usageSummary();
  const c = await getSupabase();
  const data = must(
    await c
      .from("usage_log")
      .select("kind,cost")
      .eq("user_id", userId)
      .gte("at", monthStartIso())
      .range(0, 9999),
    "usageSummary"
  );
  let searches = 0, builds = 0, aiUsd = 0;
  for (const r of data || []) {
    if (r.kind === "search") searches++;
    else if (r.kind === "build") builds++;
    aiUsd += Number(r.cost) || 0;
  }
  return { searches, builds, aiUsd };
}

// ── Profile (plan + monthly token allotment + account settings) ──────────────
// The plan half (id, email, tier, monthly_token_allotment) is unchanged and is what the
// allotment gate and /api/usage read. The account-settings half is the seven camelCase
// keys below, added by the 20260827_accounts migration.

// camelCase key → profiles column. This list IS the contract: it decides both what
// getProfile() returns and what updateProfile() is allowed to write.
const PROFILE_FIELDS = [
  ["fullName", "full_name"],
  ["agencyName", "agency_name"],
  ["phone", "phone"],
  ["defaultCity", "default_city"],
  ["defaultState", "default_state"],
  ["defaultNiche", "default_niche"],
];
const PLAN_COLS = "id,email,tier,monthly_token_allotment";
const PROFILE_COLS = `${PLAN_COLS},${PROFILE_FIELDS.map(([, col]) => col).join(",")},onboarding_dismissed`;

// "  Kyle  " → "Kyle". Empty, whitespace-only, null and undefined all clear to null.
function cleanField(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// A profiles row (or null) → the seven account keys every getProfile() answer carries.
function accountFields(row) {
  const out = {};
  for (const [key, col] of PROFILE_FIELDS) out[key] = row?.[col] ?? null;
  out.onboardingDismissed = !!row?.onboarding_dismissed;
  return out;
}

// A caller patch → { column: value } for the keys actually present. Unknown keys are
// dropped here, so nothing outside PROFILE_FIELDS can ever reach the database.
function profilePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const [key, col] of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[col] = cleanField(patch[key]);
  }
  return out;
}

// True when Postgres rejected the query because a column doesn't exist (SQLSTATE 42703).
const isMissingColumn = (e) => e?.code === "42703" || /column .* does not exist/i.test(e?.message || "");

export async function getProfile(userId) {
  if (!isSupabase()) {
    return {
      id: "local",
      email: "local@dev",
      tier: "local",
      monthly_token_allotment: parseInt(process.env.MONTHLY_TOKEN_ALLOTMENT || "1000000", 10) || 1000000,
      ...accountFields((await db()).getProfileRow(userId)),
    };
  }
  const c = await getSupabase();
  const q = await c.from("profiles").select(PROFILE_COLS).eq("id", userId).maybeSingle();
  // Deploy-order safety net: if the accounts migration hasn't been applied to this project
  // yet, fall back to the plan columns alone rather than breaking every caller of
  // getProfile (the search gate and /api/usage both depend on it). Settings then read
  // empty until the operator applies the migration.
  const data =
    q.error && isMissingColumn(q.error)
      ? must(await c.from("profiles").select(PLAN_COLS).eq("id", userId).maybeSingle(), "getProfile")
      : must(q, "getProfile");
  // No profile row yet → an un-provisioned account: 0 tokens (blocked) until an admin
  // assigns a plan. New signups get their tokens from the DB trigger.
  const plan = data
    ? { id: data.id, email: data.email, tier: data.tier, monthly_token_allotment: data.monthly_token_allotment }
    : { id: userId, email: "", tier: "trial", monthly_token_allotment: 0 };
  return { ...plan, ...accountFields(data) };
}

// Save account settings. Accepts any of fullName, agencyName, phone, defaultCity,
// defaultState, defaultNiche; ignores every other key; trims strings and turns an empty
// one into null (which is how the UI clears a field). Returns the profile in the same
// shape getProfile() does, so a route can answer with it directly.
export async function updateProfile(userId, patch) {
  const set = profilePatch(patch);
  if (!Object.keys(set).length) return getProfile(userId);
  if (!isSupabase()) {
    (await db()).updateProfileRow(userId, set);
    return getProfile(userId);
  }
  const c = await getSupabase();
  // Upsert, not update: the signup trigger normally created the row already, and on the
  // rare account that has none the settings still save instead of vanishing. Only the id
  // and the patched columns are sent, so tier / monthly_token_allotment are never touched.
  must(await c.from("profiles").upsert({ id: userId, ...set }, { onConflict: "id" }), "updateProfile");
  return getProfile(userId);
}

// Hide (or bring back) the onboarding checklist. Returns the updated profile.
export async function dismissOnboarding(userId, dismissed = true) {
  const flag = !!dismissed;
  if (!isSupabase()) {
    (await db()).setOnboardingDismissed(userId, flag);
    return getProfile(userId);
  }
  const c = await getSupabase();
  must(
    await c.from("profiles").upsert({ id: userId, onboarding_dismissed: flag }, { onConflict: "id" }),
    "dismissOnboarding"
  );
  return getProfile(userId);
}

// ── Support messages + token requests ────────────────────────────────────────
// Both are write-then-read-your-own: a user creates a row and lists their own, and the
// operator answers from the admin panel (which queries the service client directly).
//
// Bad input THROWS. The error carries .status = 400 and a message safe to show the user,
// so a route can do: catch (e) { res.status(e.status || 500).json({ ok:false, error:e.message }) }
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = "bad_request";
  return err;
}

function supportRow(r) {
  return {
    id: Number(r.id),
    subject: r.subject ?? "",
    body: r.body ?? "",
    status: r.status ?? "open",
    createdAt: r.created_at ?? null,
    adminReply: r.admin_reply ?? null,
    repliedAt: r.replied_at ?? null,
  };
}

function tokenRequestRow(r) {
  return {
    id: Number(r.id),
    tokensRequested: Number(r.tokens_requested) || 0,
    note: r.note ?? "",
    status: r.status ?? "pending",
    createdAt: r.created_at ?? null,
    decidedAt: r.decided_at ?? null,
    tokensGranted: r.tokens_granted === null || r.tokens_granted === undefined ? null : Number(r.tokens_granted),
    priceUsd: r.price_usd === null || r.price_usd === undefined ? null : Number(r.price_usd),
    adminNote: r.admin_note ?? null,
  };
}

// { id } of the new message. Subject and body are both required after trimming.
export async function createSupportMessage(userId, { subject, body } = {}) {
  const s = String(subject ?? "").trim();
  const b = String(body ?? "").trim();
  if (!s) throw badRequest("Add a subject.");
  if (!b) throw badRequest("Add a message.");
  if (!isSupabase()) {
    return { id: Number((await db()).createSupportMessage(userId, { subject: s, body: b })) };
  }
  const c = await getSupabase();
  const data = must(
    await c.from("support_messages").insert({ user_id: userId, subject: s, body: b }).select("id").single(),
    "createSupportMessage"
  );
  return { id: Number(data?.id) };
}

// This user's messages, newest first. id breaks ties on identical timestamps.
export async function listSupportMessages(userId) {
  if (!isSupabase()) return ((await db()).listSupportMessages(userId) || []).map(supportRow);
  const c = await getSupabase();
  const data = must(
    await c
      .from("support_messages")
      .select("id,subject,body,status,created_at,admin_reply,replied_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, BIG),
    "listSupportMessages"
  );
  return (data || []).map(supportRow);
}

// { id } of the new request. tokens must be a positive whole number; note is optional.
export async function createTokenRequest(userId, { tokens, note } = {}) {
  // A form sends a string, code sends a number, and nothing else counts: without the
  // typeof guard `true` would coerce to a request for 1 token.
  const raw = typeof tokens === "string" ? tokens.trim() : tokens;
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw badRequest("Ask for a whole number of tokens, at least 1.");
  const text = String(note ?? "").trim();
  if (!isSupabase()) {
    return { id: Number((await db()).createTokenRequest(userId, { tokens: n, note: text })) };
  }
  const c = await getSupabase();
  const data = must(
    await c
      .from("token_requests")
      .insert({ user_id: userId, tokens_requested: n, note: text })
      .select("id")
      .single(),
    "createTokenRequest"
  );
  return { id: Number(data?.id) };
}

// This user's token requests, newest first.
export async function listTokenRequests(userId) {
  if (!isSupabase()) return ((await db()).listTokenRequests(userId) || []).map(tokenRequestRow);
  const c = await getSupabase();
  const data = must(
    await c
      .from("token_requests")
      .select("id,tokens_requested,note,status,created_at,decided_at,tokens_granted,price_usd,admin_note")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, BIG),
    "listTokenRequests"
  );
  return (data || []).map(tokenRequestRow);
}

// ── Wins (a user's closed deals) ─────────────────────────────────────────────
// client_name is required; amount is parsed to a number-or-null; note is optional.
export async function addWin(userId, { clientName, amount, note } = {}) {
  const client = String(clientName ?? "").trim();
  if (!client) throw new Error("addWin: a client/trade name is required");
  const parsed = amount === "" || amount === null || amount === undefined ? null : Number(amount);
  const cleanAmount = Number.isFinite(parsed) ? parsed : null;
  if (!isSupabase()) return (await db()).addWin({ clientName: client, amount: cleanAmount, note });
  const c = await getSupabase();
  const data = must(
    await c
      .from("wins")
      .insert({ user_id: userId, client_name: client, amount: cleanAmount, note: note ? String(note) : "" })
      .select("id")
      .single(),
    "addWin"
  );
  return data?.id;
}

// This user's wins, newest first.
export async function listWins(userId) {
  if (!isSupabase()) return (await db()).listWins();
  const c = await getSupabase();
  return (
    must(
      await c
        .from("wins")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(0, BIG),
      "listWins"
    ) || []
  );
}

// { count, total } — total is the sum of every win's amount (null amounts count as 0).
export async function winStats(userId) {
  if (!isSupabase()) return (await db()).winStats();
  const c = await getSupabase();
  const data = must(
    await c.from("wins").select("amount").eq("user_id", userId).range(0, BIG),
    "winStats"
  );
  let count = 0, total = 0;
  for (const r of data || []) { count++; total += Number(r.amount) || 0; }
  return { count, total };
}

export async function removeWin(userId, id) {
  if (!isSupabase()) return (await db()).removeWin(id);
  const c = await getSupabase();
  must(await c.from("wins").delete().eq("user_id", userId).eq("id", Number(id)), "removeWin");
}
