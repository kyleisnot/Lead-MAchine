// db.js — tiny SQLite store for leads. Tracks status through the pipeline and
// prevents contacting the same business twice (dedup on source+externalId).

import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "leads.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    external_id   TEXT NOT NULL,
    name          TEXT,
    category      TEXT,
    city          TEXT,
    state         TEXT,
    phone         TEXT,
    email         TEXT,
    website       TEXT,
    lead_json     TEXT,            -- full normalized lead
    site_data     TEXT,            -- mapped buildSite() data object
    preview_path  TEXT,            -- path to generated preview html
    email_subject TEXT,
    email_body    TEXT,
    status        TEXT NOT NULL DEFAULT 'new',  -- new|preview_built|sent|skipped
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    contacted_at  TEXT,
    UNIQUE(source, external_id)
  );
`);

// ── Migrations: add CRM columns to existing databases if missing ──
const cols = new Set(db.prepare(`PRAGMA table_info(leads)`).all().map((c) => c.name));
function addCol(name, def) {
  if (!cols.has(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${def}`);
}
addCol("saved", "INTEGER NOT NULL DEFAULT 0"); // 1 = in the CRM
addCol("saved_at", "TEXT");
addCol("crm_stage", "TEXT NOT NULL DEFAULT 'New'"); // New|Contacted|Interested|Won|Lost
addCol("notes", "TEXT NOT NULL DEFAULT ''");
addCol("dismissed", "INTEGER NOT NULL DEFAULT 0"); // 1 = hidden from future searches
addCol("contacted_on", "TEXT"); // when the lead was moved to the "Contacted" CRM stage (for follow-ups)
addCol("activity_verdict", "TEXT"); // your ✓/✗ on whether our "last active" tag was right: 'correct' | 'wrong'
addCol("activity_verdict_at", "TEXT"); // when you gave that verdict
addCol("activity_seen", "TEXT"); // what we SHOWED you (epoch+status) when you judged — for calibration
addCol("dedup_key", "TEXT"); // canonical business key (phone, else name+city) for cross-source dedup
addCol("bucket", "TEXT NOT NULL DEFAULT 'qualified'"); // qualified | inactive | has_website
addCol("follow_up_at", "TEXT"); // null = in that bucket's working list; set = in its follow-up list

// The three buckets a search result gets sorted into, and the CRM lists that mirror them.
// Anything unrecognized falls back to 'qualified' so a bad value can never hide a lead.
export const CRM_BUCKETS = ["qualified", "inactive", "has_website"];
const BUCKET_SET = new Set(CRM_BUCKETS);
export function normalizeBucket(b) {
  return BUCKET_SET.has(b) ? b : "qualified";
}

// Canonical key identifying the SAME real business across sources (Google/FB/IG). Prefers the
// phone number (last 10 digits, so +1 / formatting don't matter); falls back to name+city.
// Returns "" when there's nothing to key on (lead is then treated as always-unique).
export function dedupKeyFor({ phone, name, city } = {}) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length >= 10) return "p:" + digits.slice(-10);
  const n = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return "";
  const c = String(city || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `n:${n}|${c}`;
}

// Backfill dedup_key on any legacy rows that predate the column.
{
  const legacy = db.prepare(`SELECT id, phone, name, city FROM leads WHERE dedup_key IS NULL`).all();
  if (legacy.length) {
    const upd = db.prepare(`UPDATE leads SET dedup_key=? WHERE id=?`);
    db.transaction((rows) => { for (const r of rows) upd.run(dedupKeyFor(r), r.id); })(legacy);
  }
}

// Insert a freshly scraped lead. Ignores duplicates (already-seen businesses).
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO leads (source, external_id, name, category, city, state, phone, email, website, lead_json, dedup_key)
  VALUES (@source, @external_id, @name, @category, @city, @state, @phone, @email, @website, @lead_json, @dedup_key)
`);

export function insertLead(lead) {
  const info = insertStmt.run({
    source: lead.source,
    external_id: String(lead.externalId || lead.name),
    name: lead.name ?? "",
    category: lead.category ?? "",
    city: lead.city ?? "",
    state: lead.state ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    website: lead.website ?? "",
    lead_json: JSON.stringify(lead),
    dedup_key: dedupKeyFor(lead),
  });
  return info.changes > 0; // true = new, false = duplicate
}

// Re-scan refresh: update ONLY scraped fields on existing rows (preserve status/preview/CRM/
// dismissed/saved). This is why a business that added a website, changed its phone, or gained
// photos isn't stuck showing stale data forever (the old INSERT OR IGNORE never updated).
const refreshStmt = db.prepare(`
  UPDATE leads SET
    name=@name, category=@category, city=@city, state=@state,
    phone=COALESCE(NULLIF(@phone,''), phone),
    email=COALESCE(NULLIF(@email,''), email),
    website=@website, lead_json=@lead_json, dedup_key=@dedup_key
  WHERE source=@source AND external_id=@external_id
`);

// Insert if new (and refresh scraped fields if existing), ALWAYS returning the row id.
export function upsertLeadReturningId(lead) {
  const isNew = insertLead(lead);
  if (!isNew) {
    refreshStmt.run({
      source: lead.source,
      external_id: String(lead.externalId || lead.name),
      name: lead.name ?? "",
      category: lead.category ?? "",
      city: lead.city ?? "",
      state: lead.state ?? "",
      phone: lead.phone ?? "",
      email: lead.email ?? "",
      website: lead.website ?? "",
      lead_json: JSON.stringify(lead),
      dedup_key: dedupKeyFor(lead),
    });
  }
  const row = db
    .prepare(`SELECT id FROM leads WHERE source = ? AND external_id = ?`)
    .get(lead.source, String(lead.externalId || lead.name));
  return row?.id;
}

// Record your ✓/✗ on whether the "last active" tag we showed was right.
// `seen` is a short string of what we displayed (e.g. "active|May 2026") for later calibration.
export function setActivityFeedback(id, verdict, seen = "") {
  const v = verdict === "correct" || verdict === "wrong" ? verdict : null;
  db.prepare(
    `UPDATE leads SET activity_verdict=?, activity_verdict_at=datetime('now'), activity_seen=? WHERE id=?`
  ).run(v, seen, id);
}

// All feedback rows (for reviewing how accurate the activity dating is).
export function activityFeedback() {
  return db
    .prepare(
      `SELECT id, name, source, activity_verdict AS verdict, activity_seen AS seen, activity_verdict_at AS at
       FROM leads WHERE activity_verdict IS NOT NULL ORDER BY activity_verdict_at DESC`
    )
    .all();
}

export function activityFeedbackCounts() {
  return db
    .prepare(
      `SELECT activity_verdict AS verdict, COUNT(*) n FROM leads WHERE activity_verdict IS NOT NULL GROUP BY activity_verdict`
    )
    .all();
}

export function alreadySeen(source, externalId) {
  const row = db
    .prepare(`SELECT 1 FROM leads WHERE source = ? AND external_id = ?`)
    .get(source, String(externalId));
  return !!row;
}

export function attachPreview(id, { siteData, previewPath, emailSubject, emailBody }) {
  db.prepare(
    `UPDATE leads SET site_data=?, preview_path=?, email_subject=?, email_body=?, status='preview_built' WHERE id=?`
  ).run(JSON.stringify(siteData), previewPath, emailSubject, emailBody, id);
}

export function markSent(id) {
  db.prepare(`UPDATE leads SET status='sent', contacted_at=datetime('now') WHERE id=?`).run(id);
}

export function markSkipped(id) {
  db.prepare(`UPDATE leads SET status='skipped' WHERE id=?`).run(id);
}

export function updateDraft(id, { emailSubject, emailBody, email }) {
  db.prepare(`UPDATE leads SET email_subject=?, email_body=?, email=? WHERE id=?`).run(
    emailSubject,
    emailBody,
    email,
    id
  );
}

export function getLead(id) {
  return db.prepare(`SELECT * FROM leads WHERE id=?`).get(id);
}

export function listLeads(status) {
  if (status) return db.prepare(`SELECT * FROM leads WHERE status=? ORDER BY created_at DESC`).all(status);
  return db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
}

export function counts() {
  return db.prepare(`SELECT status, COUNT(*) n FROM leads GROUP BY status`).all();
}

// ── App state (remembers the last search so it survives page navigation) ──
db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)`);
export function setState(key, value) {
  db.prepare(`INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
    key,
    JSON.stringify(value)
  );
}
export function getState(key) {
  const row = db.prepare(`SELECT value FROM app_state WHERE key=?`).get(key);
  return row ? JSON.parse(row.value) : null;
}

// Fetch leads by id list, preserving the given order, skipping dismissed ones.
export function getLeadsByIds(ids = []) {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT * FROM leads WHERE id IN (${ids.map(() => "?").join(",")}) AND dismissed=0`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// ── Usage log: count actions + estimate AI (Claude/OpenAI) spend ──
db.exec(`CREATE TABLE IF NOT EXISTS usage_log (kind TEXT, cost REAL DEFAULT 0, at TEXT DEFAULT (datetime('now')))`);
export function logUsage(kind, cost = 0) {
  db.prepare(`INSERT INTO usage_log (kind, cost) VALUES (?,?)`).run(kind, cost);
}
export function usageSummary() {
  const monthStart = "datetime('now','start of month')";
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind='search' THEN 1 END),0) searches,
      COALESCE(SUM(CASE WHEN kind='build'  THEN 1 END),0) builds,
      COALESCE(SUM(cost),0) aiUsd
    FROM usage_log WHERE at >= ${monthStart}`).get();
  return { searches: row.searches, builds: row.builds, aiUsd: row.aiUsd };
}

// How many outreach emails we've sent in the last 24h — used to enforce a Gmail-friendly
// daily send cap so cold outreach doesn't trip spam throttling / account suspension.
export function sentInLast24h() {
  const row = db
    .prepare(`SELECT COUNT(*) n FROM leads WHERE status='sent' AND contacted_at >= datetime('now','-1 day')`)
    .get();
  return row?.n || 0;
}

// ── Search cache: remember a whole search so repeats are free (no Apify call) ──
db.exec(`CREATE TABLE IF NOT EXISTS searches (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
export function getSearchCache(key) {
  const r = db.prepare(`SELECT data, updated_at FROM searches WHERE key=?`).get(key);
  return r ? { ...JSON.parse(r.data), updatedAt: r.updated_at } : null;
}
export function saveSearchCache(key, data) {
  db.prepare(
    `INSERT INTO searches (key,data,updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
  ).run(key, JSON.stringify(data));
}

// ── Checked-business memory: every business we've ever evaluated + whether it had a website ──
db.exec(`CREATE TABLE IF NOT EXISTS checked_businesses (
  source TEXT, external_id TEXT, name TEXT, has_website INTEGER,
  niche TEXT, city TEXT, state TEXT, checked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(source, external_id)
)`);
const recordCheckedStmt = db.prepare(`
  INSERT INTO checked_businesses (source,external_id,name,has_website,niche,city,state)
  VALUES (@source,@external_id,@name,@has_website,@niche,@city,@state)
  ON CONFLICT(source,external_id) DO UPDATE SET has_website=excluded.has_website, checked_at=datetime('now')
`);
export const recordChecked = db.transaction((rows) => {
  for (const b of rows) recordCheckedStmt.run(b);
});
export function checkedStats() {
  return db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(has_website),0) withSite FROM checked_businesses`).get();
}
// The "brain" — every business ever scanned. noSiteOnly=true returns just the
// qualifying no-website ones; otherwise everything, newest-checked first.
export function listCheckedBusinesses({ noSiteOnly = false } = {}) {
  const where = noSiteOnly ? `WHERE has_website=0` : ``;
  return db
    .prepare(`SELECT source, external_id, name, has_website, niche, city, state, checked_at FROM checked_businesses ${where} ORDER BY checked_at DESC`)
    .all();
}
// Every lead ever surfaced (all statuses), newest first.
export function listAllLeads() {
  return db.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
}

// ── Dismiss / "mark off" (hide from future searches) ──
export function dismissLead(id) {
  const row = db.prepare(`SELECT dedup_key FROM leads WHERE id=?`).get(id);
  db.prepare(`UPDATE leads SET dismissed=1 WHERE id=?`).run(id);
  // Cascade: also hide the SAME business found via other sources (same dedup_key), so it
  // can't quietly reappear from a different platform after you've marked it off.
  if (row?.dedup_key) db.prepare(`UPDATE leads SET dismissed=1 WHERE dedup_key=?`).run(row.dedup_key);
}
export function undismissLead(id) {
  db.prepare(`UPDATE leads SET dismissed=0 WHERE id=?`).run(id);
}
// Set of "source|external_id" for every dismissed business, to filter search results.
export function dismissedKeys() {
  const rows = db.prepare(`SELECT source, external_id FROM leads WHERE dismissed=1`).all();
  return new Set(rows.map((r) => `${r.source}|${r.external_id}`));
}

// ── CRM ──
export function saveToCrm(id) {
  db.prepare(`UPDATE leads SET saved=1, saved_at=COALESCE(saved_at, datetime('now')) WHERE id=?`).run(id);
}
export function removeFromCrm(id) {
  db.prepare(`UPDATE leads SET saved=0 WHERE id=?`).run(id);
}
export function updateCrm(id, { stage, notes }) {
  if (stage !== undefined) {
    db.prepare(`UPDATE leads SET crm_stage=? WHERE id=?`).run(stage, id);
    // Stamp the follow-up clock the moment a lead is marked "Contacted".
    if (stage === "Contacted") {
      db.prepare(`UPDATE leads SET contacted_on=datetime('now') WHERE id=?`).run(id);
    }
  }
  if (notes !== undefined) db.prepare(`UPDATE leads SET notes=? WHERE id=?`).run(notes, id);
}
export function listCrm(stage) {
  if (stage) return db.prepare(`SELECT * FROM leads WHERE saved=1 AND crm_stage=? ORDER BY saved_at DESC`).all(stage);
  return db.prepare(`SELECT * FROM leads WHERE saved=1 ORDER BY saved_at DESC`).all();
}
export function crmCounts() {
  return db.prepare(`SELECT crm_stage, COUNT(*) n FROM leads WHERE saved=1 GROUP BY crm_stage`).all();
}

// ── CRM buckets: moving search results into the CRM, per bucket ──
// A search-result prospect can arrive either as a raw scraped lead (externalId, camelCase)
// or as a lead ROW that discover() already stored (external_id). Accept both shapes.
function crmRowFrom(p, bucket) {
  if (!p) return null;
  const source = p.source ?? "";
  const externalId = String(p.external_id ?? p.externalId ?? p.id ?? p.name ?? "");
  if (!source || !externalId) return null;
  return {
    source,
    external_id: externalId,
    name: p.name ?? "",
    category: p.category ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    phone: p.phone ?? "",
    email: p.email ?? "",
    website: p.website ?? "",
    // A stored row carries lead_json as a JSON string already; a raw prospect is the object itself.
    lead_json: typeof p.lead_json === "string" ? p.lead_json : JSON.stringify(p.lead_json ?? p),
    dedup_key: dedupKeyFor(p),
    bucket,
  };
}

const crmInsertStmt = db.prepare(`
  INSERT OR IGNORE INTO leads
    (source, external_id, name, category, city, state, phone, email, website, lead_json, dedup_key,
     saved, saved_at, crm_stage, status, bucket, follow_up_at)
  VALUES
    (@source, @external_id, @name, @category, @city, @state, @phone, @email, @website, @lead_json, @dedup_key,
     1, datetime('now'), 'New', 'new', @bucket, NULL)
`);
const crmExistingStmt = db.prepare(`SELECT id, saved FROM leads WHERE source=? AND external_id=?`);
// Adopting an already-known lead touches ONLY its CRM membership. crm_stage, status and notes
// are left exactly as they are, so a lead the user has already worked is never reset.
const crmAdoptStmt = db.prepare(`
  UPDATE leads SET saved=1, saved_at=COALESCE(saved_at, datetime('now')), bucket=?, follow_up_at=NULL WHERE id=?
`);

// Move search-result prospects into the CRM under one bucket. Returns { added, skipped }:
// skipped counts prospects already in the CRM (plus unusable/duplicate entries in the batch),
// so added + skipped always equals prospects.length.
export const moveToCrm = db.transaction((prospects = [], bucket = "qualified") => {
  const b = normalizeBucket(bucket);
  let added = 0;
  let skipped = 0;
  const seen = new Set(); // collapse duplicates inside the batch
  for (const p of prospects || []) {
    const row = crmRowFrom(p, b);
    if (!row) { skipped++; continue; }
    const key = `${row.source}|${row.external_id}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    if (crmInsertStmt.run(row).changes > 0) { added++; continue; }
    const existing = crmExistingStmt.get(row.source, row.external_id);
    if (!existing || existing.saved) { skipped++; continue; } // already in the CRM: leave it alone
    crmAdoptStmt.run(b, existing.id);
    added++;
  }
  return { added, skipped };
});

// whenISO = an ISO timestamp to schedule the follow-up, or null to clear it (back to working).
export function setFollowUp(leadId, whenISO) {
  db.prepare(`UPDATE leads SET follow_up_at=? WHERE id=?`).run(whenISO || null, Number(leadId));
}

export function setLeadBucket(leadId, bucket) {
  db.prepare(`UPDATE leads SET bucket=? WHERE id=?`).run(normalizeBucket(bucket), Number(leadId));
}

// { qualified: {working, followups}, inactive: {...}, has_website: {...} }
// working  = saved, not dismissed, no follow-up date, newest saved first.
// followups = saved, not dismissed, has a follow-up date, soonest first.
export function listCrmBuckets() {
  const out = {};
  for (const b of CRM_BUCKETS) out[b] = { working: [], followups: [] };
  const working = db
    .prepare(`SELECT * FROM leads WHERE saved=1 AND dismissed=0 AND follow_up_at IS NULL ORDER BY saved_at DESC, id DESC`)
    .all();
  const followups = db
    .prepare(`SELECT * FROM leads WHERE saved=1 AND dismissed=0 AND follow_up_at IS NOT NULL ORDER BY follow_up_at ASC, id ASC`)
    .all();
  for (const r of working) out[normalizeBucket(r.bucket)].working.push(r);
  for (const r of followups) out[normalizeBucket(r.bucket)].followups.push(r);
  return out;
}

// ── Global business directory: EVERY business ever scanned, across all users ──
// Deliberately has no user_id. In Supabase this table is service-role only; the SQLite
// mirror exists so the same store code runs locally.
db.exec(`CREATE TABLE IF NOT EXISTS business_directory (
  source      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name        TEXT,
  niche       TEXT,
  city        TEXT,
  state       TEXT,
  phone       TEXT,
  email       TEXT,
  website     TEXT,
  has_website INTEGER,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, external_id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS directory_site_idx ON business_directory (has_website)`);
db.exec(`CREATE INDEX IF NOT EXISTS directory_place_idx ON business_directory (city, state)`);

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
    has_website: site === undefined || site === null ? null : site ? 1 : 0,
  };
}

// first_seen is never moved; last_seen always refreshes; a field only overwrites the stored
// value when the new scrape actually has something (so a thinner re-scan can't wipe a phone).
const directoryStmt = db.prepare(`
  INSERT INTO business_directory
    (source, external_id, name, niche, city, state, phone, email, website, has_website)
  VALUES
    (@source, @external_id, @name, @niche, @city, @state, @phone, @email, @website, @has_website)
  ON CONFLICT(source, external_id) DO UPDATE SET
    name        = COALESCE(NULLIF(excluded.name, ''), name),
    niche       = COALESCE(NULLIF(excluded.niche, ''), niche),
    city        = COALESCE(NULLIF(excluded.city, ''), city),
    state       = COALESCE(NULLIF(excluded.state, ''), state),
    phone       = COALESCE(NULLIF(excluded.phone, ''), phone),
    email       = COALESCE(NULLIF(excluded.email, ''), email),
    website     = COALESCE(NULLIF(excluded.website, ''), website),
    has_website = COALESCE(excluded.has_website, has_website),
    last_seen   = datetime('now')
`);

export const recordDirectory = db.transaction((businesses = []) => {
  const byKey = new Map(); // one row per (source, external_id), last one wins
  for (const b of businesses || []) {
    const row = directoryRowFrom(b);
    if (row) byKey.set(`${row.source}|${row.external_id}`, row);
  }
  for (const row of byKey.values()) directoryStmt.run(row);
  return { upserted: byKey.size };
});

// ── Manual follow-ups: your OWN reminders (e.g. people you called on your own), separate from leads ──
db.exec(`CREATE TABLE IF NOT EXISTS manual_followups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  due        TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
export function addFollowup({ title, note, due }) {
  const info = db
    .prepare(`INSERT INTO manual_followups (title, note, due) VALUES (?,?,?)`)
    .run(title, note || "", due || null);
  return info.lastInsertRowid;
}
export function listFollowups() {
  // open items first, soonest due first, then newest.
  return db
    .prepare(`SELECT * FROM manual_followups ORDER BY done ASC, COALESCE(due,'9999-12-31') ASC, created_at DESC`)
    .all();
}
export function updateFollowup(id, { note, due, done }) {
  if (note !== undefined) db.prepare(`UPDATE manual_followups SET note=? WHERE id=?`).run(note, id);
  if (due !== undefined) db.prepare(`UPDATE manual_followups SET due=? WHERE id=?`).run(due || null, id);
  if (done !== undefined) db.prepare(`UPDATE manual_followups SET done=? WHERE id=?`).run(done ? 1 : 0, id);
}
export function removeFollowup(id) {
  db.prepare(`DELETE FROM manual_followups WHERE id=?`).run(id);
}

// ── Wins: a user's closed deals — their trophy case (mirrors the Supabase `wins` table) ──
db.exec(`CREATE TABLE IF NOT EXISTS wins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  amount      REAL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// clientName is required; amount is a number-or-null (a win with no dollar figure is fine).
export function addWin({ clientName, amount, note } = {}) {
  const info = db
    .prepare(`INSERT INTO wins (client_name, amount, note) VALUES (?,?,?)`)
    .run(String(clientName), amount == null ? null : Number(amount), note ? String(note) : "");
  return info.lastInsertRowid;
}
// Newest first; id breaks ties when two wins share a created_at second.
export function listWins() {
  return db.prepare(`SELECT * FROM wins ORDER BY created_at DESC, id DESC`).all();
}
export function winStats() {
  const row = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) total FROM wins`).get();
  return { count: row.count || 0, total: row.total || 0 };
}
export function removeWin(id) {
  db.prepare(`DELETE FROM wins WHERE id=?`).run(id);
}

export default db;
