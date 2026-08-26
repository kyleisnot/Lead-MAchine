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

export async function listCrm(userId, stage) {
  if (!isSupabase()) return (await db()).listCrm(stage);
  const c = await getSupabase();
  let q = c.from("leads").select("*").eq("user_id", userId).eq("saved", true);
  if (stage) q = q.eq("crm_stage", stage);
  const data = must(await q.order("saved_at", { ascending: false }).range(0, BIG), "listCrm");
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

// ── Profile (plan + monthly token allotment) ─────────────────────────────────
export async function getProfile(userId) {
  if (!isSupabase()) {
    return {
      id: "local",
      email: "local@dev",
      tier: "local",
      monthly_token_allotment: parseInt(process.env.MONTHLY_TOKEN_ALLOTMENT || "1000000", 10) || 1000000,
    };
  }
  const c = await getSupabase();
  const data = must(
    await c.from("profiles").select("id,email,tier,monthly_token_allotment").eq("id", userId).maybeSingle(),
    "getProfile"
  );
  // No profile row yet → an un-provisioned account: 0 tokens (blocked) until an admin
  // assigns a plan. New signups get their tokens from the DB trigger.
  return data || { id: userId, email: "", tier: "trial", monthly_token_allotment: 0 };
}
