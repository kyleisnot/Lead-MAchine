// admin.js — the operator admin panel (Agent C).
//
// One self-contained file: the router, the page render, and the small inline
// script that posts per-user tier/allotment edits.
//
// This is the ONE place cross-user queries are allowed. Every other module
// scopes by req.userId; here the operator deliberately looks across all users,
// so we go straight to the service-role client from lib/supabase.js.
//
// Contract (see the MVP spec, section 6):
//   export const adminRouter   — express Router, all paths under /admin,
//                                every route guarded by requireUser + requireAdmin.
//   GET  /admin                — operator overview (stat cards + users table)
//   POST /admin/api/user/:id   — {tier, monthly_token_allotment} → updates profiles
import express from "express";
import { requireUser, requireAdmin } from "./auth.js";
import { dataProvider, getSupabase } from "../lib/supabase.js";
import { apifySpend } from "../lib/spend.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar } from "./shell.js";

export const adminRouter = express.Router();

const TIERS = ["trial", "starter", "pro"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST caps un-ranged selects at 1000 rows — ask for more explicitly.
const MAX_ROWS = 4999;

// ── small helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Tokens are the user-facing unit; usage_log.cost is stored in USD.
function tokensPerUsd() {
  const n = parseFloat(process.env.TOKENS_PER_USD || "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

// Start of the current calendar month, server-local, as an ISO timestamp.
function firstOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

function num(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Throws on a PostgREST error so the route's try/catch can show one clean message.
function unwrap(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res;
}

// Run an async fn over a list with a small concurrency cap (a handful of users
// at MVP scale, but this keeps the query burst bounded as that grows).
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── data ─────────────────────────────────────────────────────────────────────

// Everything the overview needs, in one shot. Counts use head:true count
// queries (cheap, no row transfer); the month's usage rows are fetched ranged
// and summed in JS since PostgREST has no sum() without a view.
async function loadOverview() {
  const sb = await getSupabase();
  const since = firstOfMonthISO();

  const [profilesRes, userCountRes, leadCountRes] = await Promise.all([
    sb
      .from("profiles")
      .select("id,email,tier,monthly_token_allotment,created_at")
      .order("created_at", { ascending: false })
      .range(0, MAX_ROWS),
    sb.from("profiles").select("*", { count: "exact", head: true }),
    sb.from("leads").select("*", { count: "exact", head: true }),
  ]);

  const profiles = unwrap(profilesRes, "profiles").data || [];
  const totalUsers = unwrap(userCountRes, "user count").count ?? profiles.length;
  const totalLeads = unwrap(leadCountRes, "lead count").count ?? 0;

  const users = await mapPool(profiles, 6, async (p) => {
    const [leadsRes, savedRes, usageRes, lastRes] = await Promise.all([
      sb.from("leads").select("*", { count: "exact", head: true }).eq("user_id", p.id),
      sb
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("user_id", p.id)
        .eq("saved", true),
      sb.from("usage_log").select("cost").eq("user_id", p.id).gte("at", since).range(0, MAX_ROWS),
      sb
        .from("usage_log")
        .select("at")
        .eq("user_id", p.id)
        .order("at", { ascending: false })
        .limit(1),
    ]);

    const costUsd = (unwrap(usageRes, "usage").data || []).reduce(
      (a, r) => a + (Number(r.cost) || 0),
      0
    );
    return {
      id: p.id,
      email: p.email || "—",
      tier: TIERS.includes(String(p.tier || "").toLowerCase())
        ? String(p.tier).toLowerCase()
        : String(p.tier || "trial"),
      allotment: Number(p.monthly_token_allotment ?? 0),
      createdAt: p.created_at,
      leads: unwrap(leadsRes, "user lead count").count ?? 0,
      saved: unwrap(savedRes, "user saved count").count ?? 0,
      costUsd,
      tokens: Math.round(costUsd * tokensPerUsd()),
      lastUsage: (unwrap(lastRes, "last usage").data || [])[0]?.at || null,
    };
  });

  // The month total is summed from the per-user numbers so the card and the
  // table can never disagree (and so no single global fetch has to page).
  const monthUsd = users.reduce((a, u) => a + u.costUsd, 0);

  return {
    totalUsers,
    totalLeads,
    monthTokens: Math.round(monthUsd * tokensPerUsd()),
    users,
  };
}

// ── render ───────────────────────────────────────────────────────────────────

function page(body, extraScript = "") {
  return `<!doctype html><html><head>${THEME_INIT_SCRIPT}<meta charset="utf-8"><title>Lead Machine — Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
  .stat{border-radius:10px;padding:16px}
  .stat .n{font-size:26px;font-weight:800;line-height:1.15}
  .stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
  .stat .s{font-size:12px;margin-top:6px;color:var(--faint)}
  .tblwrap{overflow-x:auto;border-radius:12px}
  table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden;min-width:940px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:12px 14px;white-space:nowrap}
  td{padding:11px 14px;font-size:14px;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  th.n{text-align:right}
  td.d{white-space:nowrap;color:var(--muted)}
  .who{font-weight:600}
  .sub{font-size:12px;margin-top:2px}
  select.tier{border-radius:7px;padding:6px 8px;font-size:13px}
  input.allot{border-radius:7px;padding:6px 8px;font-size:13px;width:96px;text-align:right}
  .rowact{display:flex;align-items:center;gap:8px;white-space:nowrap}
  .savebtn{background:var(--accent);color:var(--on-accent);border:none;border-radius:7px;padding:7px 14px;font-weight:700;font-size:13px;cursor:pointer}
  .savebtn:disabled{opacity:.55;cursor:wait}
  .flag{font-size:13px;font-weight:700;min-width:14px}
  .flag.ok{color:var(--accent-ink)}
  .flag.err{color:var(--danger)}
  .notice{border-radius:12px;padding:22px 24px;max-width:620px;background:var(--panel);border:1px solid var(--border)}
  .notice h2{font-size:16px;font-weight:800;margin-bottom:8px}
  .notice p{font-size:14px;color:var(--muted);line-height:1.6}
  .notice code{background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:13px;color:var(--text)}
  .empty{color:var(--muted);font-size:15px;padding:26px 4px}
  @media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}}
${SHARED_CSS}</style></head><body>
${sidebar("admin", { isAdmin: true })}<div class="pagehead"><div class="titlewrap"><h1>Admin</h1><div class="pagesub">Operator overview — every user, their usage this month, and their plan</div></div><div class="spacer"></div></div>
${body}
${extraScript}${SHELL_TAIL_SCRIPT}</main></div></body></html>`;
}

function statCard(n, label, sub = "") {
  return `<div class="stat"><div class="n">${n}</div><div class="l">${esc(label)}</div>${
    sub ? `<div class="s">${esc(sub)}</div>` : ""
  }</div>`;
}

function noticeCard(title, text) {
  return `<div class="notice"><h2>${title}</h2><p>${text}</p></div>`;
}

function userRow(u) {
  const opts = TIERS.map(
    (t) => `<option value="${t}"${u.tier === t ? " selected" : ""}>${t}</option>`
  ).join("");
  // A tier the DB holds that isn't one of the three stays visible as its own option.
  const extra = TIERS.includes(u.tier)
    ? ""
    : `<option value="${esc(u.tier)}" selected>${esc(u.tier)}</option>`;
  const id = esc(u.id);
  return `<tr id="u-${id}">
  <td><div class="who">${esc(u.email)}</div><div class="sub muted">${id.slice(0, 8)}</div></td>
  <td><select class="tier" aria-label="Tier for ${esc(u.email)}">${extra}${opts}</select></td>
  <td><input class="allot" type="number" min="0" step="10" value="${u.allotment}" aria-label="Monthly token allotment for ${esc(
    u.email
  )}"><div class="sub muted">${u.allotment ? "" : "unlimited"}</div></td>
  <td class="n">${num(u.tokens)}</td>
  <td class="n">${num(u.leads)}</td>
  <td class="n">${num(u.saved)}</td>
  <td class="d">${fmtDate(u.createdAt)}</td>
  <td class="d">${fmtDate(u.lastUsage)}</td>
  <td><div class="rowact"><button class="savebtn" onclick="lmSaveUser('${id}',this)">Save</button><span class="flag" id="f-${id}"></span></div></td>
</tr>`;
}

function renderOverview(d, spend) {
  const cards = `<div class="stats">
${statCard(num(d.totalUsers), "Users")}
${statCard(num(d.totalLeads), "Leads, all users")}
${statCard(num(d.monthTokens), "Tokens this month", `at ${num(tokensPerUsd())} tokens per $1`)}
${statCard(
  spend == null ? "—" : "$" + Number(spend).toFixed(2),
  "Apify spend, month to date",
  spend == null ? "No Apify token configured" : "Operator cost"
)}
</div>`;

  const table = d.users.length
    ? `<div class="tblwrap"><table>
<thead><tr>
  <th>User</th><th>Tier</th><th>Allotment</th><th class="n">Tokens this month</th>
  <th class="n">Leads</th><th class="n">Saved to CRM</th><th>Signed up</th><th>Last usage</th><th></th>
</tr></thead>
<tbody>${d.users.map(userRow).join("\n")}</tbody></table></div>`
    : `<div class="empty">No users yet. They appear here as soon as someone signs up.</div>`;

  const script = `<script>
async function lmSaveUser(id,btn){
  var row=document.getElementById('u-'+id);
  var flag=document.getElementById('f-'+id);
  if(!row)return;
  var tier=row.querySelector('select.tier').value;
  var raw=row.querySelector('input.allot').value;
  var allot=parseInt(raw,10); if(!isFinite(allot)||allot<0)allot=0;
  btn.disabled=true; flag.className='flag'; flag.textContent='';
  try{
    var r=await fetch('/admin/api/user/'+encodeURIComponent(id),{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tier:tier,monthly_token_allotment:allot})
    });
    var j=await r.json();
    if(j&&j.ok){flag.className='flag ok';flag.textContent='\\u2713';setTimeout(function(){flag.textContent=''},2500)}
    else{flag.className='flag err';flag.textContent=(j&&j.error)?j.error:'Save failed'}
  }catch(e){flag.className='flag err';flag.textContent='Save failed'}
  btn.disabled=false;
}
</script>`;

  return page(cards + table, script);
}

// ── routes ───────────────────────────────────────────────────────────────────

adminRouter.get("/admin", requireUser, requireAdmin, async (req, res) => {
  if (dataProvider() !== "supabase") {
    return res.send(
      page(
        noticeCard(
          "The admin panel needs Supabase mode",
          "This app is running on local SQLite, which is single-user, so there is nothing to administer. " +
            "Set <code>DATA_PROVIDER=supabase</code> in <code>.env</code> (with the project URL and service-role key) and restart to see users, usage and plans here."
        )
      )
    );
  }
  try {
    // The spend lookup is a third-party call — never let it fail the page.
    const [data, spend] = await Promise.all([
      loadOverview(),
      apifySpend().catch(() => null),
    ]);
    res.send(renderOverview(data, spend));
  } catch (e) {
    res
      .status(500)
      .send(
        page(
          noticeCard(
            "Could not load the admin data",
            `Supabase returned an error: <code>${esc(e && e.message ? e.message : String(e))}</code>`
          )
        )
      );
  }
});

adminRouter.post(
  "/admin/api/user/:id",
  requireUser,
  requireAdmin,
  express.json(),
  async (req, res) => {
    if (dataProvider() !== "supabase") {
      return res.status(400).json({ ok: false, error: "Admin edits need Supabase mode." });
    }
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: "Invalid user id." });

    const body = req.body || {};
    const patch = {};

    if (body.tier !== undefined && body.tier !== null && body.tier !== "") {
      const tier = String(body.tier).trim().toLowerCase();
      if (!TIERS.includes(tier)) {
        return res.status(400).json({ ok: false, error: "Tier must be trial, starter or pro." });
      }
      patch.tier = tier;
    }

    const allot = body.monthly_token_allotment;
    if (allot !== undefined && allot !== null && allot !== "") {
      const n = Number(allot);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, error: "Allotment must be zero or more." });
      }
      patch.monthly_token_allotment = Math.round(n);
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: "Nothing to update." });
    }

    try {
      const sb = await getSupabase();
      const { data, error } = await sb
        .from("profiles")
        .update(patch)
        .eq("id", id)
        .select("id,tier,monthly_token_allotment");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!data || !data.length) return res.status(404).json({ ok: false, error: "User not found." });
      res.json({ ok: true, profile: data[0] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e && e.message ? e.message : "Update failed." });
    }
  }
);

export default adminRouter;
