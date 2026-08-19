// server.js — local review dashboard. Lists built previews, lets you eyeball each one,
// edit the email, and hit SEND (sends from your Gmail) or SKIP. Nothing sends without your click.

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import {
  listLeads, getLead, markSent, markSkipped, updateDraft, counts,
  saveToCrm, removeFromCrm, updateCrm, listCrm, crmCounts,
  dismissLead, getState, getLeadsByIds, checkedStats, usageSummary,
  setActivityFeedback, activityFeedbackCounts,
  addFollowup, listFollowups, updateFollowup, removeFollowup, sentInLast24h,
  listCheckedBusinesses, listAllLeads,
} from "../data/db.js";
import { sendEmail } from "../mailer/mailer.js";
import { discover, discoverMany, buildForLead, buildFromUrl, willSearchSpend } from "../lib/pipeline.js";
import { scheduleDeploy, cloudflareConfigured } from "../host/cloudflare.js";
import { NICHES } from "../lib/niches.js";
import { lastActiveLabel, activityStatus, activitySignal, cutoffLabel, freshnessConfig } from "../lib/freshness.js";
import { spendCapState, RATE_PER_1K } from "../lib/spend.js";
import { detectLicenseSignal, licenseSearchUrl } from "../lib/license.js";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public"))); // serves /logo.png, /mark.png
const PORT = process.env.PORT || 4000;

// Block a search if this month's Apify spend has hit the configured cap.
// `forceRefresh`/batch runs spend credits; cached single searches don't, so we only
// guard live calls. Returns an error response when blocked, or null when clear.
async function blockedBySpendCap(res, { live }) {
  if (!live) return false;
  const cap = await spendCapState();
  if (cap.blocked) {
    res.status(429).json({
      ok: false,
      error: `Spend cap reached: $${cap.spent.toFixed(2)} / $${cap.cap.toFixed(0)} of Apify this month. ` +
             `Raise APIFY_MONTHLY_CAP in .env to keep scanning.`,
    });
    return true;
  }
  return false;
}

// ── SEARCH API: run a live lookup (Google + Facebook) for a niche + city ──
app.post("/api/search", async (req, res) => {
  const { niche, city, state, sources, limit, forceRefresh } = req.body;
  if (!niche || !city) return res.status(400).json({ ok: false, error: "Need a niche and a city." });
  try {
    // Any search that will actually hit Apify (a cold/uncached lookup OR a forced re-scan)
    // spends credits — guard ALL of those, not just forced re-scans. Cached searches are
    // free and stay allowed even when capped.
    const resolvedSources = sources?.length ? sources : ["google", "facebook"];
    const willSpend = willSearchSpend({ niche, city, state, sources: resolvedSources, limit: limit || 30, forceRefresh: !!forceRefresh });
    if (await blockedBySpendCap(res, { live: willSpend })) return;
    const { prospects, stats, cached, cachedAt } = await discover({
      niche,
      city,
      state,
      sources: resolvedSources,
      limit: limit || 30,
      forceRefresh: !!forceRefresh,
    });
    res.json({ ok: true, stats, cached: !!cached, cachedAt: cachedAt || null, prospects: prospects.map(slimProspect) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── BATCH SEARCH API: many niches × many cities in one run (the "scan more" lever) ──
app.post("/api/search-batch", async (req, res) => {
  const { niches, cities, state, sources, limit, forceRefresh } = req.body;
  const nicheList = (Array.isArray(niches) ? niches : []).filter(Boolean);
  const cityList = (Array.isArray(cities) ? cities : []).filter(Boolean);
  if (!nicheList.length || !cityList.length) {
    return res.status(400).json({ ok: false, error: "Pick at least one niche and one city." });
  }
  try {
    if (await blockedBySpendCap(res, { live: true })) return;
    const { prospects, stats } = await discoverMany({
      niches: nicheList,
      cities: cityList,
      state,
      sources: sources?.length ? sources : ["google", "facebook"],
      limit: limit || 30,
      forceRefresh: !!forceRefresh,
    });
    res.json({ ok: true, stats, prospects: prospects.map(slimProspect) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Build the preview + email for one found prospect, then publish it.
app.post("/api/build/:id", async (req, res) => {
  try {
    const r = await buildForLead(req.params.id);
    let publicUrl = `/preview/${r.id}`;
    if (cloudflareConfigured()) {
      // Background, debounced publish — coalesces rapid builds into one deploy. The public URL
      // is deterministic, so we can hand it back now (it goes live within a few seconds).
      scheduleDeploy();
      if (process.env.PUBLIC_BASE_URL) publicUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${r.id}`;
    }
    res.json({ ok: true, id: r.id, email: r.email, publicUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── MANUAL API: paste a Facebook URL → scrape + build a preview for a lead you found yourself ──
app.post("/api/manual", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: "Paste a Facebook page URL." });
  try {
    const r = await buildFromUrl(url);
    let publicUrl = `/preview/${r.id}`;
    if (cloudflareConfigured()) {
      scheduleDeploy();
      if (process.env.PUBLIC_BASE_URL) publicUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${r.id}`;
    }
    res.json({ ok: true, id: r.id, name: r.name, email: r.email, publicUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CRM API ──
app.post("/api/crm/save/:id", (req, res) => {
  saveToCrm(req.params.id);
  res.json({ ok: true });
});
app.post("/api/crm/remove/:id", (req, res) => {
  removeFromCrm(req.params.id);
  res.json({ ok: true });
});
// Mark off a business so it won't show up in future searches.
app.post("/api/dismiss/:id", (req, res) => {
  dismissLead(req.params.id);
  res.json({ ok: true });
});

// Your ✓/✗ on whether our "last active" tag was right (trains/validates the dating).
app.post("/api/activity-feedback/:id", (req, res) => {
  const { verdict, seen } = req.body || {};
  setActivityFeedback(req.params.id, verdict, seen || "");
  res.json({ ok: true, counts: activityFeedbackCounts() });
});
app.post("/api/crm/update/:id", (req, res) => {
  updateCrm(req.params.id, { stage: req.body.stage, notes: req.body.notes });
  res.json({ ok: true });
});

app.get("/crm", (req, res) => res.send(renderCrmPage(req.query.view)));

// The "brain" — browse every business the machine has ever scanned or surfaced.
app.get("/brain", (req, res) => res.send(renderBrainPage(req.query.view)));

// ── Manual follow-ups (your own reminders) ──
app.post("/api/followup/add", (req, res) => {
  const { title, note, due } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ ok: false, error: "Add a name first." });
  const id = addFollowup({ title: title.trim(), note, due });
  res.json({ ok: true, id });
});
app.post("/api/followup/update/:id", (req, res) => {
  updateFollowup(req.params.id, req.body || {});
  res.json({ ok: true });
});
app.post("/api/followup/remove/:id", (req, res) => {
  removeFollowup(req.params.id);
  res.json({ ok: true });
});

// Usage tracker: real Apify monthly spend + estimated AI spend + action counts.
app.get("/api/usage", async (req, res) => {
  const u = usageSummary();
  let apify = null, apifyLimit = null;
  try {
    if (process.env.APIFY_TOKEN) {
      const auth = { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } }; // token in header, not URL
      const [mu, me] = await Promise.all([
        fetch("https://api.apify.com/v2/users/me/usage/monthly", auth).then((r) => r.json()),
        fetch("https://api.apify.com/v2/users/me", auth).then((r) => r.json()),
      ]);
      const d = mu.data || {};
      apify = d.totalUsageCreditsUsdAfterVolumeDiscount ?? d.totalUsageCreditsUsdBeforeVolumeDiscount ?? null;
      apifyLimit = me.data?.plan?.monthlyUsageCreditsUsd ?? me.data?.plan?.maxMonthlyUsageUsd ?? null;
    }
  } catch {}
  const total = (apify || 0) + (u.aiUsd || 0);
  const remaining = apifyLimit != null ? Math.max(0, apifyLimit - (apify || 0)) : null;
  res.json({ ok: true, apify, apifyLimit, remaining, aiUsd: u.aiUsd, total, searches: u.searches, builds: u.builds });
});

// How many businesses the database has remembered (and how many had websites).
app.get("/api/memory", (req, res) => {
  const s = checkedStats();
  res.json({ ok: true, total: s.total || 0, withSite: s.withSite || 0, noSite: (s.total || 0) - (s.withSite || 0) });
});

function slimProspect(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    city: l.city,
    state: l.state,
    phone: l.phone,
    email: l.email || "",
    source: l.source,
    website: l.website || "",
    reviews: l.reviews ?? null,
    rating: l.rating ?? null,
    lastActive: lastActiveLabel(lj), // "Mar 2025" or "" when unknown
    activeStatus: activityStatus(lj), // "active" | "stale" | "unknown"
    activeSignal: activitySignal(lj), // "FB post" | "IG post" | "Google review"
    verdict: l.activity_verdict || "", // your ✓/✗ on the activity tag, if given
    license: detectLicenseSignal(lj), // { status, number, evidence } — best-effort license/registration signal
    licenseUrl: licenseSearchUrl(lj), // one-click official-search link to confirm
    saved: !!l.saved,
    built: l.status === "preview_built" || l.status === "sent",
  };
}

// Restore the most recent search (so leaving for the CRM and coming back keeps results).
app.get("/api/last-search", (req, res) => {
  const ls = getState("last_search");
  if (!ls) return res.json({ ok: true, empty: true });
  const rows = getLeadsByIds(ls.ids || []);
  res.json({
    ok: true,
    query: { niche: ls.niche, city: ls.city, state: ls.state, sources: ls.sources, limit: ls.limit },
    stats: ls.stats,
    prospects: rows.map(slimProspect),
  });
});

// Serve a lead's generated preview html (used in the iframe AND as the email link).
app.get("/preview/:id", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead?.preview_path) return res.status(404).send("No preview for this lead.");
  try {
    res.set("Content-Type", "text/html").send(readFileSync(lead.preview_path, "utf8"));
  } catch {
    res.status(404).send("Preview file missing — re-run the scraper.");
  }
});

// Landing page = the search/prospector UI.
app.get("/", (req, res) => res.send(renderSearchPage()));

// Manual page = paste a Facebook URL → build a preview for a lead you found yourself.
app.get("/manual", (req, res) => res.send(renderManualPage()));

// Review & send page (the built previews).
app.get("/review", (req, res) => {
  const leads = listLeads("preview_built");
  const stats = counts().map((c) => `${c.status}: ${c.n}`).join(" · ");
  res.send(renderPage(leads, stats));
});

// Save edits to a draft
app.post("/save/:id", (req, res) => {
  const { email, subject, body } = req.body;
  updateDraft(req.params.id, { email, emailSubject: subject, emailBody: body });
  res.json({ ok: true });
});

// SEND — the only thing that emails. Requires your explicit click.
// Daily send cap keeps cold outreach under Gmail's radar (blank/0 = no cap). 24h rolling window.
const DAILY_SEND_CAP = parseInt(process.env.GMAIL_DAILY_CAP ?? "40", 10) || 0;
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

app.post("/send/:id", async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ ok: false, error: "Lead not found" });
  const { email, subject, body } = req.body;
  if (!isEmail(email)) return res.status(400).json({ ok: false, error: "Enter a valid recipient email first." });
  if (!subject || !body) return res.status(400).json({ ok: false, error: "Subject and body can't be empty." });
  // Throttle: don't let a session blast past a safe daily volume.
  if (DAILY_SEND_CAP && sentInLast24h() >= DAILY_SEND_CAP) {
    return res.status(429).json({
      ok: false,
      error: `Daily send cap reached (${DAILY_SEND_CAP}/24h). This protects your Gmail from spam throttling. ` +
             `Raise GMAIL_DAILY_CAP in .env to send more.`,
    });
  }
  try {
    await sendEmail({ to: email.trim(), subject, text: body });
    markSent(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/skip/:id", (req, res) => {
  markSkipped(req.params.id);
  res.json({ ok: true });
});

// Bind to loopback only: this dashboard can scrape (spend $) and SEND email with no auth,
// so it must never be reachable from other machines on the network.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🛰  Lead Machine dashboard → http://localhost:${PORT}\n`);
});

// Compact usage tracker that lives INSIDE the header (no longer a floating pill that
// covered buttons). `style` lets a page nudge placement (e.g. margin-left:auto).
function usageWidget(style = "") {
  return `<div id="usagePill" title="Total spend this month — Apify + AI" style="display:flex;align-items:center;gap:12px;background:rgba(20,255,185,.06);border:1px solid rgba(20,255,185,.28);border-radius:10px;padding:6px 12px;font:600 12px/1 system-ui,sans-serif;color:#cfd6e2;white-space:nowrap;${style}">
  <span style="color:#8b93a3;text-transform:uppercase;letter-spacing:.5px;font-size:10px">Used</span><b id="uTot" style="color:#14FFB9;font-size:13px">…</b>
  <span style="width:1px;height:14px;background:rgba(255,255,255,.14)"></span>
  <span style="color:#8b93a3">Apify</span><b id="uAp">…</b><span id="uApLim" style="color:#8b93a3;font-weight:500"></span>
  <span style="color:#8b93a3">AI</span><b id="uAi">~$0.00</b>
  <span style="width:1px;height:14px;background:rgba(255,255,255,.14)"></span>
  <span style="color:#8b93a3">🔍 <b id="uS" style="color:#cfd6e2">0</b> · ⚡ <b id="uB" style="color:#cfd6e2">0</b></span>
</div>
<script>(function(){var g=function(id){return document.getElementById(id)};async function u(){try{var r=await(await fetch('/api/usage')).json();if(!r.ok)return;
  g('uTot').textContent='$'+(r.total||0).toFixed(2);
  g('uAp').textContent=r.apify!=null?'$'+r.apify.toFixed(2):'—';
  g('uApLim').textContent=r.apifyLimit!=null?(' / $'+r.apifyLimit.toFixed(0)+(r.remaining!=null?' ('+'$'+r.remaining.toFixed(0)+' left)':'')):'';
  if(r.apifyLimit){var p=(r.apify||0)/r.apifyLimit;g('uAp').style.color=p>.85?'#e0a93b':'#cfd6e2';}
  g('uAi').textContent='~$'+(r.aiUsd||0).toFixed(2);
  g('uS').textContent=r.searches;g('uB').textContent=r.builds;
}catch(e){}}u();setInterval(u,30000);})();</script>`;
}

// ── HTML rendering (kept simple: server-rendered + a little fetch JS) ──
function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// License/registration badge (server-rendered) for the Review & CRM pages. Best-effort signal
// from the lead's own profile text + a one-click official-verify link. Inline-styled so it
// works on every page with no extra CSS.
function licenseBadgeHtml(l) {
  let lj = {};
  try { lj = l.lead_json ? JSON.parse(l.lead_json) : {}; } catch {}
  const sig = detectLicenseSignal(lj);
  const url = licenseSearchUrl(lj);
  const on = sig.status === "mentioned";
  const label = on ? `🪪 ${esc(sig.evidence || "licensed/registered")}` : "🪪 no license info";
  const bg = on ? "rgba(40,200,100,.14)" : "rgba(255,255,255,.06)";
  const color = on ? "#28c864" : "#7b8499";
  return `<span title="${on ? "What the business advertises — confirm with Verify" : "Nothing found in their profile — check the official search"}" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;background:${bg};color:${color}">${label}</span> <a href="${url}" target="_blank" rel="noopener" style="color:#14FFB9;font-size:12px;text-decoration:none">verify ↗</a>`;
}

function renderCard(l) {
  const noEmail = !l.email;
  return `
  <div class="card" id="card-${l.id}">
    <div class="left">
      <div class="biz">
        <h2>${esc(l.name)} <span class="tag">#${l.id}</span></h2>
        <p class="meta">${esc(l.category || "")} · ${esc(l.city || "")}, ${esc(l.state || "")} · ${esc(l.phone || "no phone")}</p>
        <p class="meta ${l.website ? "warn" : "good"}">${l.website ? "⚠️ website on file: " + esc(l.website) : "✅ no website found"}</p>
        <p class="meta">${licenseBadgeHtml(l)}</p>
      </div>
      <iframe src="/preview/${l.id}" loading="lazy"></iframe>
    </div>
    <div class="right">
      <label>To ${noEmail ? '<span class="warn">(no email scraped — add one)</span>' : ""}</label>
      <input id="to-${l.id}" value="${esc(l.email || "")}" placeholder="add recipient email">
      <label>Subject</label>
      <input id="subj-${l.id}" value="${esc(l.email_subject || "")}">
      <label>Body</label>
      <textarea id="body-${l.id}" rows="14">${esc(l.email_body || "")}</textarea>
      <div class="actions">
        <button class="send" onclick="send(${l.id})">✉️ SEND</button>
        <button class="save" onclick="save(${l.id})">💾 Save</button>
        <button class="rebuild" onclick="rebuild(${l.id})" title="Regenerate with the latest polished template + AI photos">🔄 Rebuild</button>
        <button class="skip" onclick="skip(${l.id})">Skip</button>
        <a class="open" href="/preview/${l.id}" target="_blank">Open preview ↗</a>
      </div>
      <div class="status" id="status-${l.id}"></div>
    </div>
  </div>`;
}

function renderPage(leads, stats) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lead Machine</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.2);--text:#e8eaf0;--muted:#6b7280}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body::before{content:"";position:fixed;inset:0;background:url(/mark.png) center 120px/360px no-repeat;opacity:.05;pointer-events:none;z-index:0}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px}
  header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .stats{color:var(--muted);font-size:13px}
  .empty{color:var(--muted);margin-top:40px;text-align:center;font-size:15px}
  .card{display:grid;grid-template-columns:1.1fr .9fr;gap:20px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:22px}
  .biz h2{font-size:18px}.tag{color:var(--muted);font-size:13px}
  .meta{color:var(--muted);font-size:13px;margin-top:3px}.good{color:#28c864}.warn{color:#e0a93b}
  iframe{width:100%;height:520px;border:1px solid var(--border);border-radius:8px;margin-top:12px;background:#fff}
  .right{display:flex;flex-direction:column;gap:6px}
  label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-top:6px}
  input,textarea{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:9px 11px;color:var(--text);font-family:inherit;font-size:13px;resize:vertical}
  .actions{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}
  button{border:none;border-radius:8px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:14px}
  .send{background:var(--gold);color:#000}.send:hover{background:#0fd49b}
  .save{background:rgba(255,255,255,.1);color:var(--text)}
  .rebuild{background:rgba(20,255,185,.14);color:var(--gold);border:1px solid var(--border)}
  .rebuild:hover{background:rgba(20,255,185,.25)}
  .skip{background:transparent;color:var(--muted);border:1px solid var(--border)}
  .open{color:var(--gold);font-size:13px;text-decoration:none;margin-left:auto}
  .status{font-size:13px;margin-top:8px;min-height:18px}
  .fade{opacity:.35;transition:opacity .4s}
</style></head><body>
<header><img src="/logo.png" alt="Avanzta Contractor Marketing Group" class="brandlogo"><a href="/" style="color:var(--gold);text-decoration:none;font-weight:600">← Search</a><a href="/manual" style="color:var(--gold);text-decoration:none;font-weight:600">➕ Manual</a><a href="/crm" style="color:var(--gold);text-decoration:none;font-weight:600">CRM</a><a href="/brain" style="color:var(--gold);text-decoration:none;font-weight:600">🧠 Brain</a><span class="stats">${esc(stats)}</span>${usageWidget("margin-left:auto")}</header>
${leads.length ? leads.map(renderCard).join("") : '<div class="empty">No previews built yet. Go to <a href="/" style="color:var(--gold)">Search</a>, find some leads, and click “Build preview”.</div>'}
<script>
async function post(url, data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function vals(id){return {email:document.getElementById('to-'+id).value,subject:document.getElementById('subj-'+id).value,body:document.getElementById('body-'+id).value}}
function setStatus(id,msg,color){const s=document.getElementById('status-'+id);s.textContent=msg;s.style.color=color||'#6b7280'}
async function save(id){await post('/save/'+id,vals(id));setStatus(id,'Saved ✓','#28c864')}
async function send(id){setStatus(id,'Sending…');const r=await post('/send/'+id,vals(id));if(r.ok){setStatus(id,'Sent ✅','#28c864');document.getElementById('card-'+id).classList.add('fade')}else{setStatus(id,'Error: '+r.error,'#e05b5b')}}
async function skip(id){await post('/skip/'+id);document.getElementById('card-'+id).classList.add('fade');setStatus(id,'Skipped','#6b7280')}
async function rebuild(id){setStatus(id,'⏳ Rebuilding (AI photos + before/after, ~30–45s)…','#e0a93b');const r=await post('/api/build/'+id,{});if(r.ok){var f=document.querySelector('#card-'+id+' iframe');if(f)f.src='/preview/'+id+'?t='+Date.now();setStatus(id,'✅ Rebuilt with the new template','#28c864')}else{setStatus(id,'Error: '+r.error,'#e05b5b')}}
</script></body></html>`;
}

// ── SEARCH / PROSPECTOR PAGE ──
function renderSearchPage() {
  const nicheButtons = NICHES.map(
    (n) => `<button type="button" class="chip" onclick="setNiche('${n.key}')">${esc(n.key)}</button>`
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lead Machine — Prospector</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body::before{content:"";position:fixed;inset:0;background:url(/mark.png) center 120px/360px no-repeat;opacity:.05;pointer-events:none;z-index:0}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1100px;margin:auto}
  header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .nav{margin-left:auto;display:flex;gap:16px;align-items:center;flex-wrap:wrap;row-gap:10px}.nav a{color:var(--gold);text-decoration:none;font-weight:600;font-size:14px}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:18px}
  .row{display:grid;grid-template-columns:1.4fr 1.4fr .7fr .9fr auto;gap:12px;align-items:end}
  label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);display:block;margin-bottom:5px}
  input,select{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .chip{background:rgba(20,255,185,.08);border:1px solid var(--border);color:var(--text);border-radius:20px;padding:6px 13px;font-size:12px;cursor:pointer}
  .chip:hover{background:rgba(20,255,185,.2)}
  .go{background:var(--gold);color:#000;border:none;border-radius:8px;padding:11px 22px;font-weight:700;cursor:pointer;font-size:15px;white-space:nowrap}
  .go:disabled{opacity:.5;cursor:wait}
  .rescan{background:transparent;border:1px solid var(--border);color:var(--gold);border-radius:8px;padding:11px 14px;cursor:pointer;font-size:15px}
  .rescan:hover{background:rgba(20,255,185,.12)}.rescan:disabled{opacity:.5;cursor:wait}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
  .stat{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
  .stat .n{font-size:28px;font-weight:800}.stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-top:3px}
  .good .n{color:#28c864}
  .lead{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
  .lead h3{font-size:16px}.lead .meta{color:var(--muted);font-size:13px;margin-top:4px}
  .badge{display:inline-block;background:rgba(20,255,185,.18);color:var(--gold);font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;margin-left:6px}
  .src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .build{background:rgba(20,255,185,.15);border:1px solid var(--border);color:var(--gold);border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer;font-size:13px}
  .build:hover{background:rgba(20,255,185,.28)}
  .save{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:var(--text);border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer;font-size:13px}
  .save:hover{background:rgba(255,255,255,.12)}.save.saved-on{background:rgba(40,200,100,.18);border-color:rgba(40,200,100,.4);color:#28c864}
  .hide{background:transparent;border:1px solid rgba(255,255,255,.14);color:var(--muted);border-radius:8px;padding:9px 12px;cursor:pointer;font-size:13px}
  .hide:hover{color:#e05b5b;border-color:#e05b5b}
  .muted{color:var(--muted)}.email{color:#28c864;font-size:13px}.noemail{color:#e0a93b;font-size:13px}
  #status{margin:10px 0;min-height:20px;font-size:14px}
  .memline{margin:4px 0 2px;font-size:13px;color:var(--muted)}.memline b{color:var(--gold)}
  .opts{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px;font-size:13px}
  .opt{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
  .opt input{width:auto;margin:0}
  .optsep{width:1px;height:16px;background:rgba(255,255,255,.14)}
  .estimate{margin-top:10px;font-size:13px;color:var(--muted)}
  .estimate b{color:var(--gold)}.estimate.big{color:#e0a93b}.estimate.big b{color:#e0a93b}
  .fresh-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;margin-top:6px}
  .fresh-active{background:rgba(40,200,100,.16);color:#28c864}
  .fresh-unknown{background:rgba(224,169,59,.16);color:#e0a93b}
  .lic-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .lic-yes{background:rgba(40,200,100,.14);color:#28c864}
  .lic-no{background:rgba(255,255,255,.06);color:var(--muted)}
  .lic-verify{color:var(--gold);font-size:12px;text-decoration:none;margin-left:6px}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--gold);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<header><img src="/logo.png" alt="Avanzta Contractor Marketing Group" class="brandlogo"><span class="muted" style="font-size:13px">Prospector</span>
  <div class="nav"><a href="/">Search</a><a href="/manual">➕ Manual</a><a href="/crm">CRM</a><a href="/brain">🧠 Brain</a><a href="/review">Review &amp; Send →</a>${usageWidget()}</div></header>

<div class="panel">
  <div class="row">
    <div><label>U.S. City <span class="muted" style="text-transform:none;letter-spacing:0">(comma-separate for several)</span></label><input id="city" placeholder="Knoxville, Maryville, Oak Ridge" value="Knoxville"></div>
    <div><label>State</label><input id="state" placeholder="TN" value="TN"></div>
    <div><label>Niche</label><input id="niche" placeholder="landscaping" value="landscaping"></div>
    <div><label>Source</label><select id="source">
      <option value="all">All (Google + FB + IG)</option>
      <option value="facebook">Facebook only</option>
      <option value="instagram">Instagram only</option>
      <option value="google">Google only</option>
    </select></div>
    <div style="display:flex;gap:8px">
      <button class="go" id="goBtn" onclick="runSearch(false)">Search</button>
      <button class="rescan" id="rescanBtn" onclick="runSearch(true)" title="Re-scan live with fresh data (uses Apify credits)">🔄</button>
    </div>
  </div>
  <div class="chips">${nicheButtons}</div>
  <div class="opts">
    <label class="opt"><input type="checkbox" id="allNiches" oninput="updateEstimate()"> <b>All trades</b> <span class="muted">(scan every niche)</span></label>
    <span class="optsep"></span>
    <label style="display:inline">Depth (per source)</label>
    <select id="limit" onchange="updateEstimate()" style="width:auto;display:inline-block;margin-left:6px">
      <option value="20">Quick (20)</option><option value="40">Standard (40)</option>
      <option value="60">Deep (60)</option><option value="100">Deeper (100)</option>
      <option value="150">Max (150)</option><option value="250">Firehose (250)</option>
    </select>
    <span class="optsep"></span>
    <span class="muted">${!freshnessConfig().enabled
      ? "⚪ activity filter off"
      : freshnessConfig().mode === "filter"
        ? `🟢 keeps only leads active since <b>${esc(cutoffLabel())}</b>`
        : `🏷️ tags activity since <b>${esc(cutoffLabel())}</b> <span style="opacity:.7">(label-only — not filtering yet; set FRESHNESS_MODE=filter to actually drop stale leads)</span>`}</span>
  </div>
  <div id="estimate" class="estimate"></div>
</div>
<script>
  var NICHE_KEYS = ${JSON.stringify(NICHES.map((n) => n.key))};
  var RATE_PER_1K = ${RATE_PER_1K};
</script>

<div id="memory" class="memline"></div>
<div id="status"></div>
<div id="statsWrap"></div>
<div id="results"></div>

<script>
function setNiche(n){document.getElementById('niche').value=n;updateEstimate()}
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function st(html){document.getElementById('status').innerHTML=html}

// "Knoxville, Maryville" → ["Knoxville","Maryville"]
function parseCities(){return document.getElementById('city').value.split(',').map(s=>s.trim()).filter(Boolean)}
function chosenSources(){const s=document.getElementById('source').value;return s==='all'?['google','facebook','instagram']:[s]}
function chosenNiches(){return document.getElementById('allNiches').checked?NICHE_KEYS.slice():[document.getElementById('niche').value.trim()].filter(Boolean)}

// Live "this will scan ≈ N places (≈ $X)" estimate. Multiplies cities × niches × sources × depth.
function updateEstimate(){
  const cities=parseCities().length||1, niches=chosenNiches().length||1, sources=chosenSources().length, depth=parseInt(document.getElementById('limit').value)||0;
  const places=cities*niches*sources*depth;
  const usd=(places/1000)*RATE_PER_1K;
  const el=document.getElementById('estimate');
  const big=places>1500;
  el.className='estimate'+(big?' big':'');
  el.innerHTML=(big?'⚠️ ':'')+'This scan ≈ <b>'+places.toLocaleString()+'</b> places'+
    ' &nbsp;·&nbsp; rough cost <b>~$'+usd.toFixed(2)+'</b>'+
    ' &nbsp;<span style="opacity:.7">('+cities+' city × '+niches+' niche × '+sources+' src × '+depth+' deep)</span>';
}

async function runSearch(force){
  const cities=parseCities();
  if(!cities.length){st('❌ Enter at least one city.');return}
  const niches=chosenNiches();
  if(!niches.length){st('❌ Enter a niche (or tick All trades).');return}
  const sources=chosenSources();
  const depth=parseInt(document.getElementById('limit').value);
  const multi=cities.length>1||niches.length>1;
  const places=cities.length*niches.length*sources.length*depth;

  // Confirm before a genuinely large (credit-spending) batch.
  if(multi&&places>1500&&!confirm('This will scan ≈ '+places.toLocaleString()+' places across '+cities.length+' city × '+niches.length+' niche. Rough cost ~$'+((places/1000)*RATE_PER_1K).toFixed(2)+'. Continue?')) return;

  const btn=document.getElementById('goBtn'),rb=document.getElementById('rescanBtn');btn.disabled=true;rb.disabled=true;
  document.getElementById('results').innerHTML='';document.getElementById('statsWrap').innerHTML='';

  let r;
  if(multi){
    st('<span class="spinner"></span> Scanning '+niches.length+' niche(s) × '+cities.length+' city(ies)… this can take a few minutes.');
    r=await post('/api/search-batch',{niches,cities,state:document.getElementById('state').value,sources,limit:depth,forceRefresh:!!force});
  }else{
    st('<span class="spinner"></span> '+(force?'Re-scanning ':'Searching ')+document.getElementById('source').value+'… (saved searches are instant; new ones take 30–90s)');
    r=await post('/api/search',{niche:niches[0],city:cities[0],state:document.getElementById('state').value,sources,limit:depth,forceRefresh:!!force});
  }
  btn.disabled=false;rb.disabled=false;
  if(!r.ok){st('❌ '+r.error);return}
  render(r.stats,r.prospects,multi?'batch':(r.cached?'cached':'fresh'));
  loadMemory();
}
async function loadMemory(){
  try{const m=await (await fetch('/api/memory')).json();
    if(m.ok&&m.total)document.getElementById('memory').innerHTML='🧠 <b>'+m.total+'</b> businesses remembered · <b>'+m.noSite+'</b> with no website · <b>'+m.withSite+'</b> already had one';
  }catch(e){}
}
loadMemory();
function render(s,prospects,mode){
  document.getElementById('statsWrap').innerHTML=
    '<div class="stats">'+
    stat(s.scanned||'—','Scanned')+stat(s.qualified,'No Website ✅','good')+stat(s.hasWebsite!=null?s.hasWebsite:'—','Has Website')+stat((s.bySource.google||0)+'/'+(s.bySource.facebook||0)+'/'+(s.bySource.instagram||0),'G / FB / IG')+
    '</div>';
  if(!prospects.length){st(mode==='fresh'||mode==='batch'?'No qualified (no-website) leads found. Try a higher Depth, more cities, or All trades.':'No saved leads here yet — hit Search to find some.');return}
  var msg = mode==='cached' ? '💾 Saved results — <b>$0 credits used</b>. Hit 🔄 to re-scan for fresh data.'
          : mode==='restored' ? '↩️ Restored your last search (no credits used).'
          : mode==='batch' ? 'Batch scan done across <b>'+(s.cells||'?')+'</b> niche×city combos. Found <b>'+prospects.length+'</b> qualified leads.'
          : 'Found <b>'+prospects.length+'</b> qualified leads. Save or Build the ones you want.';
  // Show WHY leads were dropped (transparency), with the real cutoff label.
  var since=s.sinceLabel?(' since '+s.sinceLabel):'';
  var parts=[];
  if(s.staleSeen)parts.push('<b>'+s.staleSeen+'</b> too old');
  if(s.unknownSeen)parts.push('<b>'+s.unknownSeen+'</b> undated');
  var hid = (s.inactive||parts.length) ? ' &nbsp;<span class="muted">· hid '+(s.inactive||0)+' inactive'+since+(parts.length?' ('+parts.join(', ')+')':'')+'</span>' : '';
  var merged = s.crossSourceMerged ? ' &nbsp;<span class="muted">· merged '+s.crossSourceMerged+' cross-source duplicate'+(s.crossSourceMerged===1?'':'s')+'</span>' : '';
  st(msg+' &nbsp;<span class="muted">('+prospects.length+' shown)</span>'+hid+merged);
  document.getElementById('results').innerHTML='<h3 style="margin:6px 0 12px">Qualified prospects <span class="muted" style="font-weight:400;font-size:13px">— no website</span></h3>'+prospects.map(card).join('');
}
function stat(n,l,cls){return '<div class="stat '+(cls||'')+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
function card(p){
  const email=p.email?'<span class="email">✉️ '+p.email+'</span>':'<span class="noemail">no email found</span>';
  const src=p.source==='facebook'?'Facebook':p.source==='instagram'?'Instagram':'Google';
  const saveBtn=p.saved
    ? '<button class="save saved-on" id="s-'+p.id+'" disabled>✅ Saved to CRM</button>'
    : '<button class="save" onclick="saveLead('+p.id+')" id="s-'+p.id+'">💾 Save</button>';
  const buildBtn=p.built
    ? '<a class="build" href="/preview/'+p.id+'" target="_blank">✅ Open preview ↗</a>'
    : '<button class="build" onclick="build('+p.id+')" id="b-'+p.id+'">⚡ Build preview</button>';
  // Freshness badge: green when we have a dated signal, amber when we don't — shows the
  // user WHY a lead qualified (e.g. "🟢 Active · Mar 2025 · FB post").
  const fresh = p.lastActive
    ? '<div><span class="fresh-badge fresh-active">🟢 Active · '+esc(p.lastActive)+(p.activeSignal?' · '+esc(p.activeSignal):'')+'</span></div>'
    : '<div><span class="fresh-badge fresh-unknown">🟡 no dated activity</span></div>';
  // License/registration signal (best-effort, from the business's own profile text) + a
  // one-click link to verify it on an official search. Never hides a lead — just informs.
  var lic=p.license||{};
  var licBadge = lic.status==='mentioned'
    ? '<span class="lic-badge lic-yes" title="What the business advertises — confirm with Verify">🪪 '+esc(lic.evidence||'licensed/registered')+'</span>'
    : '<span class="lic-badge lic-no" title="Nothing found in their profile text — check the official search">🪪 no license info</span>';
  var lic_line = '<div style="margin-top:6px">'+licBadge+(p.licenseUrl?' <a class="lic-verify" href="'+p.licenseUrl+'" target="_blank" rel="noopener">verify ↗</a>':'')+'</div>';
  return '<div class="lead" id="lead-'+p.id+'">'+
    '<div><h3>'+esc(p.name)+'<span class="badge">no website</span></h3>'+
    '<div class="meta">'+esc(p.category||'')+' · '+esc(p.city||'')+', '+esc(p.state||'')+' · '+esc(p.phone||'no phone')+'</div>'+
    '<div class="meta"><span class="src">'+src+'</span> &nbsp; '+email+'</div>'+fresh+lic_line+'</div>'+
    '<div style="display:flex;gap:8px;align-items:center">'+
      saveBtn+buildBtn+
      '<button class="hide" onclick="hideLead('+p.id+')" title="Mark off — won&#39;t show in future searches">✕</button>'+
    '</div>'+
    '</div>';
}
// On load, bring back the last search (no re-scraping) so navigating away keeps results.
async function restoreLast(){
  const r=await (await fetch('/api/last-search')).json();
  if(!r.ok||r.empty||!r.prospects||!r.prospects.length)return;
  const q=r.query||{};
  if(q.city)document.getElementById('city').value=q.city;
  if(q.state)document.getElementById('state').value=q.state;
  if(q.niche)document.getElementById('niche').value=q.niche;
  if(q.sources){const v=q.sources.length>1?'all':q.sources[0];document.getElementById('source').value=v;}
  if(q.limit)document.getElementById('limit').value=String(q.limit);
  render(r.stats,r.prospects,'restored');
}
restoreLast();
// Keep the cost estimate live as the user changes city/niche/source/depth.
['city','niche','source'].forEach(function(id){var el=document.getElementById(id);if(el){el.addEventListener('input',updateEstimate);el.addEventListener('change',updateEstimate);}});
updateEstimate();
async function saveLead(id){
  const b=document.getElementById('s-'+id);b.disabled=true;
  const r=await post('/api/crm/save/'+id,{});
  if(r.ok){b.textContent='✅ Saved to CRM';b.classList.add('saved-on')}else{b.disabled=false;b.textContent='⚠️ retry'}
}
async function hideLead(id){
  await post('/api/dismiss/'+id,{});
  const el=document.getElementById('lead-'+id);
  if(el){el.style.transition='opacity .3s';el.style.opacity='0';setTimeout(()=>el.remove(),300)}
}
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function build(id){
  const b=document.getElementById('b-'+id);b.disabled=true;b.innerHTML='<span class="spinner"></span> Building…';
  const r=await post('/api/build/'+id,{});
  if(r.ok){b.outerHTML='<a class="build" href="'+r.publicUrl+'" target="_blank">✅ Open preview ↗</a>';}
  else{b.disabled=false;b.textContent='⚠️ '+r.error}
}
</script></body></html>`;
}

// ── MANUAL PAGE: paste a Facebook URL → build a preview for a lead you found yourself ──
function renderManualPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lead Machine — Manual</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body::before{content:"";position:fixed;inset:0;background:url(/mark.png) center 120px/360px no-repeat;opacity:.05;pointer-events:none;z-index:0}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1000px;margin:auto}
  header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  .nav{margin-left:auto;display:flex;gap:16px;align-items:center;flex-wrap:wrap;row-gap:10px}.nav a{color:var(--gold);text-decoration:none;font-weight:600;font-size:14px}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:18px}
  h2{font-size:19px;margin-bottom:6px}
  .muted{color:var(--muted);font-size:14px;line-height:1.5}
  .urlrow{display:flex;gap:10px;margin-top:16px}
  input{flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:12px 14px;color:var(--text);font-size:14px}
  .go{background:var(--gold);color:#000;border:none;border-radius:8px;padding:12px 22px;font-weight:700;cursor:pointer;font-size:15px;white-space:nowrap}
  .go:disabled{opacity:.5;cursor:wait}
  #mstatus{margin-top:14px;min-height:20px;font-size:14px}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--gold);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .result{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .result h3{font-size:17px}.result .meta{color:var(--muted);font-size:13px;margin:4px 0}
  .result iframe{width:100%;height:480px;border:1px solid var(--border);border-radius:8px;background:#fff}
  .actions{display:flex;flex-direction:column;gap:10px;margin-top:12px}
  .actions a,.actions button{display:inline-block;text-align:center;border-radius:8px;padding:11px 16px;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer;border:none}
  .primary{background:var(--gold);color:#000}
  .ghost{background:rgba(20,255,185,.14);color:var(--gold);border:1px solid var(--border)}
  .email{color:#28c864}.noemail{color:#e0a93b}
  .hint{color:var(--muted);font-size:12px;margin-top:10px}
</style></head><body>
<header><img src="/logo.png" alt="Avanzta Contractor Marketing Group" class="brandlogo"><span class="muted" style="font-size:13px">Manual</span>
  <div class="nav"><a href="/">Search</a><a href="/manual">➕ Manual</a><a href="/crm">CRM</a><a href="/brain">🧠 Brain</a><a href="/review">Review &amp; Send →</a>${usageWidget()}</div></header>

<div class="panel">
  <h2>Build a preview from a Facebook page</h2>
  <p class="muted">Found a business on your own? Paste their <b>Facebook page URL</b> and we'll scrape it, build a Site Flash preview, and write the cold email — no search needed. (Skips the no-website filter, so it works for any page.)</p>
  <div class="urlrow">
    <input id="fbUrl" placeholder="https://www.facebook.com/their-business-page" autofocus>
    <button class="go" id="buildBtn" onclick="buildManual()">⚡ Build preview</button>
  </div>
  <div id="mstatus"></div>
  <div class="hint">Takes ~30–90s (Facebook scrape + AI photo curation + before/after). Uses a little Apify + AI credit.</div>
</div>

<div id="mresult"></div>

<script>
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function mst(html){document.getElementById('mstatus').innerHTML=html}
async function buildManual(){
  const url=document.getElementById('fbUrl').value.trim();
  if(!url){mst('<span style="color:#e0a93b">Paste a Facebook page URL first.</span>');return}
  const b=document.getElementById('buildBtn');b.disabled=true;
  document.getElementById('mresult').innerHTML='';
  mst('<span class="spinner"></span> Scraping the page and building the preview… this can take up to ~90s.');
  const r=await post('/api/manual',{url});
  b.disabled=false;
  if(!r.ok){mst('❌ '+esc(r.error));return}
  mst('✅ Built! Review it below, then edit &amp; send it.');
  const emailLine=r.email?'<span class="email">✉️ '+esc(r.email)+'</span>':'<span class="noemail">⚠️ no email found — add one in Review &amp; Send</span>';
  document.getElementById('mresult').innerHTML=
    '<div class="result">'+
      '<div><h3>'+esc(r.name||'Your Business')+'</h3>'+
        '<div class="meta">'+emailLine+'</div>'+
        '<iframe src="/preview/'+r.id+'?t='+encodeURIComponent(url.length+''+r.id)+'"></iframe></div>'+
      '<div><div class="meta">Preview is ready. Next:</div>'+
        '<div class="actions">'+
          '<a class="primary" href="/review">✏️ Edit email &amp; send →</a>'+
          '<a class="ghost" href="'+esc(r.publicUrl)+'" target="_blank">Open full preview ↗</a>'+
          '<button class="ghost" onclick="document.getElementById(\\'fbUrl\\').value=\\'\\';document.getElementById(\\'mresult\\').innerHTML=\\'\\';mst(\\'\\');document.getElementById(\\'fbUrl\\').focus()">➕ Build another</button>'+
        '</div>'+
        '<div class="hint">This lead is now in <b>Review &amp; Send</b> and your <b>CRM</b>-eligible list automatically.</div>'+
      '</div>'+
    '</div>';
}
document.getElementById('fbUrl').addEventListener('keydown',e=>{if(e.key==='Enter')buildManual()});
</script></body></html>`;
}

// ── CRM PAGE ──
const CRM_STAGES = ["New", "Contacted", "Interested", "Won", "Lost"];

// Human "how long ago" from a SQLite UTC datetime string (e.g. "2026-06-09 14:03:00").
function daysAgo(dt) {
  if (!dt) return "";
  const then = new Date(dt.replace(" ", "T") + "Z").getTime();
  if (isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function renderCrmRow(l, followup = false) {
  const built = l.status === "preview_built" || l.status === "sent";
  const opts = CRM_STAGES.map(
    (s) => `<option value="${s}"${l.crm_stage === s ? " selected" : ""}>${s}</option>`
  ).join("");
  const src = l.source === "facebook" ? "Facebook" : l.source === "instagram" ? "Instagram" : "Google";
  // In the follow-up tab, show how long since they were contacted (older = nudge to chase).
  const when = daysAgo(l.contacted_on);
  const aged = when && when !== "today" && when !== "yesterday";
  const followCell = followup
    ? `<td><span class="ago ${aged ? "stale" : ""}">⏰ ${esc(when || "—")}</span></td>`
    : "";
  return `<tr id="crm-${l.id}">
    <td><b>${esc(l.name)}</b><div class="sub">${esc(l.category || "")} · ${esc(l.city || "")}, ${esc(l.state || "")}</div><div class="sub" style="margin-top:5px">${licenseBadgeHtml(l)}</div></td>
    <td>${esc(l.phone || "—")}<div class="sub">${l.email ? esc(l.email) : '<span class="warn">no email</span>'}</div></td>
    <td><span class="src">${src}</span></td>
    ${followCell}
    <td><select class="stage" onchange="setStage(${l.id},this.value)">${opts}</select></td>
    <td><input class="notes" value="${esc(l.notes || "")}" placeholder="notes…" onchange="setNotes(${l.id},this.value)"></td>
    <td class="actions">
      ${built ? `<a href="/preview/${l.id}" target="_blank">Preview ↗</a>` : `<span class="sub">not built</span>`}
      <button class="rm" onclick="removeCrm(${l.id})">Remove</button>
    </td>
  </tr>`;
}

// Friendly "due in 3d / overdue 2d / due today" from a YYYY-MM-DD string.
function dueInfo(due) {
  if (!due) return { text: "no date", cls: "" };
  const d = new Date(due + "T00:00:00").getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today.getTime()) / 86400000);
  if (days < 0) return { text: `overdue ${-days}d`, cls: "od" };
  if (days === 0) return { text: "due today", cls: "soon" };
  if (days === 1) return { text: "due tomorrow", cls: "soon" };
  return { text: `due in ${days}d`, cls: "" };
}

function renderFollowupItem(f) {
  const di = dueInfo(f.due);
  const done = !!f.done;
  return `<div class="fu-item${done ? " fu-done" : ""}" id="fu-${f.id}">
    <div class="fu-main">
      <div class="fu-title">${esc(f.title)} ${f.due ? `<span class="fu-due ${di.cls}">📅 ${di.text}</span>` : ""}</div>
      ${f.note ? `<div class="fu-note">${esc(f.note)}</div>` : ""}
    </div>
    <div class="fu-actions">
      <button class="fu-btn" onclick="fuDone(${f.id},${done ? 0 : 1})">${done ? "↩︎ Undo" : "✓ Done"}</button>
      <button class="fu-btn fu-del" onclick="fuDel(${f.id})">Remove</button>
    </div>
  </div>`;
}

// ── The Brain: browse everything the machine has ever seen ──
// Three tabs: qualifying no-website businesses (the "400+"), everything scanned,
// and the detailed leads it actually surfaced. All client-side searchable.
function srcLabel(s) {
  return s === "facebook" ? "Facebook" : s === "instagram" ? "Instagram" : s === "google" ? "Google" : (s || "—");
}
function shortDate(s) {
  if (!s) return "—";
  const d = String(s).slice(0, 10); // YYYY-MM-DD
  return d || "—";
}
function renderCheckedRow(b) {
  const site = b.has_website
    ? `<span class="tag site">has site</span>`
    : `<span class="tag nosite">no site</span>`;
  return `<tr>
    <td><b>${esc(b.name || "—")}</b></td>
    <td>${esc(b.niche || "—")}</td>
    <td>${esc([b.city, b.state].filter(Boolean).join(", ") || "—")}</td>
    <td><span class="src">${esc(srcLabel(b.source))}</span></td>
    <td>${site}</td>
    <td class="sub">${esc(shortDate(b.checked_at))}</td>
  </tr>`;
}
function renderLeadRow(l) {
  const built = l.status === "preview_built" || l.status === "sent";
  return `<tr>
    <td><b>${esc(l.name || "—")}</b><div class="sub">${esc(l.category || "")}</div></td>
    <td>${esc([l.city, l.state].filter(Boolean).join(", ") || "—")}</td>
    <td>${esc(l.phone || "—")}<div class="sub">${l.email ? esc(l.email) : '<span class="warn">no email</span>'}</div></td>
    <td><span class="src">${esc(srcLabel(l.source))}</span></td>
    <td><span class="tag ${l.saved ? "site" : ""}">${esc(l.crm_stage || "New")}</span></td>
    <td class="actions">${built ? `<a href="/preview/${l.id}" target="_blank">Preview ↗</a>` : `<span class="sub">not built</span>`}</td>
  </tr>`;
}
function renderBrainPage(view = "nosite") {
  const tab = ["nosite", "all", "leads"].includes(view) ? view : "nosite";
  const noSite = listCheckedBusinesses({ noSiteOnly: true });
  const cs = checkedStats();
  const totalScanned = cs.total || 0;
  const leads = listAllLeads();

  let head, rowsHtml, count, hint;
  if (tab === "leads") {
    head = `<tr><th>Business</th><th>Location</th><th>Contact</th><th>Source</th><th>Stage</th><th></th></tr>`;
    rowsHtml = leads.map(renderLeadRow).join("");
    count = leads.length;
    hint = "Leads it actually surfaced to you — with contact details and previews.";
  } else if (tab === "all") {
    const all = listCheckedBusinesses();
    head = `<tr><th>Business</th><th>Niche</th><th>Location</th><th>Source</th><th>Website</th><th>Checked</th></tr>`;
    rowsHtml = all.map(renderCheckedRow).join("");
    count = all.length;
    hint = "Every business the brain has ever checked — including ones that already had a website.";
  } else {
    head = `<tr><th>Business</th><th>Niche</th><th>Location</th><th>Source</th><th>Website</th><th>Checked</th></tr>`;
    rowsHtml = noSite.map(renderCheckedRow).join("");
    count = noSite.length;
    hint = "Qualifying businesses with no website — the ones worth reaching out to.";
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Lead Machine — Brain</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body::before{content:"";position:fixed;inset:0;background:url(/mark.png) center 120px/360px no-repeat;opacity:.05;pointer-events:none;z-index:0}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1200px;margin:auto}
  header{display:flex;align-items:center;gap:16px;margin-bottom:8px}
  .nav{margin-left:auto;display:flex;gap:16px;align-items:center;flex-wrap:wrap;row-gap:10px}.nav a{color:var(--gold);text-decoration:none;font-weight:600;font-size:14px}
  .stats{color:var(--muted);font-size:13px;margin:6px 0 14px}
  .tabs{display:flex;gap:8px;margin:6px 0 14px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14px;color:var(--muted);background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:9px 16px}
  .tab:hover{color:var(--text)}
  .tab.active{color:#000;background:var(--gold);border-color:var(--gold)}
  .tab .pill{background:rgba(0,0,0,.18);border-radius:20px;padding:1px 8px;font-size:12px}
  .tab:not(.active) .pill{background:rgba(20,255,185,.16);color:var(--gold)}
  .search{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 14px;color:var(--text);font-size:15px;margin-bottom:14px}
  .search::placeholder{color:var(--muted)}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:12px 14px;border-bottom:1px solid var(--border)}
  td{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .sub{color:var(--muted);font-size:12px;margin-top:3px}.warn{color:#e0a93b}
  .src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .actions a{color:var(--gold);text-decoration:none;font-size:13px}
  .tag{font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(255,255,255,.06);color:var(--muted)}
  .tag.nosite{background:rgba(20,255,185,.16);color:var(--gold)}
  .tag.site{background:rgba(224,169,59,.16);color:#e0a93b}
  .empty{color:var(--muted);text-align:center;margin-top:50px;font-size:15px}
  #noMatch{display:none;color:var(--muted);text-align:center;margin-top:30px;font-size:14px}
</style></head><body>
<header><img src="/logo.png" alt="Avanzta Contractor Marketing Group" class="brandlogo"><span style="color:var(--muted);font-size:13px">🧠 Brain</span>
  <div class="nav"><a href="/">Search</a><a href="/manual">➕ Manual</a><a href="/crm">CRM</a><a href="/brain">🧠 Brain</a><a href="/review">Review &amp; Send →</a>${usageWidget()}</div></header>
<div class="tabs">
  <a class="tab ${tab === "nosite" ? "active" : ""}" href="/brain">No website <span class="pill">${noSite.length}</span></a>
  <a class="tab ${tab === "all" ? "active" : ""}" href="/brain?view=all">All scanned <span class="pill">${totalScanned}</span></a>
  <a class="tab ${tab === "leads" ? "active" : ""}" href="/brain?view=leads">Surfaced leads <span class="pill">${leads.length}</span></a>
</div>
<div class="stats">${esc(hint)} &nbsp;·&nbsp; <b>${count}</b> shown</div>
<input class="search" id="q" placeholder="🔍 Filter by name, niche, city, state…" oninput="filterRows()" autofocus>
${count
    ? `<table id="tbl"><thead>${head}</thead><tbody id="tb">${rowsHtml}</tbody></table><div id="noMatch">No businesses match your filter.</div>`
    : '<div class="empty">Nothing here yet.</div>'}
<script>
function filterRows(){
  var q=document.getElementById('q').value.toLowerCase().trim();
  var rows=document.querySelectorAll('#tb tr');var shown=0;
  rows.forEach(function(r){
    var hit=!q||r.textContent.toLowerCase().indexOf(q)>-1;
    r.style.display=hit?'':'none';if(hit)shown++;
  });
  var nm=document.getElementById('noMatch');if(nm)nm.style.display=shown?'none':'block';
}
</script>
</body></html>`;
}

function renderCrmPage(view = "all") {
  const followup = view === "followup";
  const allLeads = listCrm();
  const counts = crmCounts();
  const contactedCount = counts.find((c) => c.crm_stage === "Contacted")?.n || 0;
  const leads = followup ? allLeads.filter((l) => l.crm_stage === "Contacted") : allLeads;
  const total = leads.length;
  const byStage = CRM_STAGES.map((s) => `${s}: ${counts.find((c) => c.crm_stage === s)?.n || 0}`).join(" · ");
  const followups = followup ? listFollowups() : [];
  const openFollowups = followups.filter((f) => !f.done).length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lead Machine — CRM</title>
<style>
  :root{--gold:#14FFB9;--bg:#0a1124;--panel:#0f1a30;--border:rgba(20,255,185,.22);--text:#e8eaf0;--muted:#7b8499}
  *{box-sizing:border-box;margin:0;padding:0}
  .brandlogo{height:40px;width:auto;display:block}
  body::before{content:"";position:fixed;inset:0;background:url(/mark.png) center 120px/360px no-repeat;opacity:.05;pointer-events:none;z-index:0}
  body>*{position:relative;z-index:1}
  body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:1200px;margin:auto}
  header{display:flex;align-items:center;gap:16px;margin-bottom:8px}
  h1{color:var(--gold);font-size:24px;letter-spacing:1px}
  .nav{margin-left:auto;display:flex;gap:16px;align-items:center;flex-wrap:wrap;row-gap:10px}.nav a{color:var(--gold);text-decoration:none;font-weight:600;font-size:14px}
  .stats{color:var(--muted);font-size:13px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);padding:12px 14px;border-bottom:1px solid var(--border)}
  td{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .sub{color:var(--muted);font-size:12px;margin-top:3px}.warn{color:#e0a93b}
  .src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  select.stage,input.notes{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:7px 9px;color:var(--text);font-size:13px}
  input.notes{width:100%;min-width:160px}
  .actions{display:flex;gap:10px;align-items:center;white-space:nowrap}
  .actions a{color:var(--gold);text-decoration:none;font-size:13px}
  .rm{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
  .rm:hover{color:#e05b5b;border-color:#e05b5b}
  .empty{color:var(--muted);text-align:center;margin-top:50px;font-size:15px}
  .tabs{display:flex;gap:8px;margin:6px 0 16px}
  .tab{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-weight:700;font-size:14px;color:var(--muted);background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:9px 16px}
  .tab:hover{color:var(--text)}
  .tab.active{color:#000;background:var(--gold);border-color:var(--gold)}
  .tab .pill{background:rgba(0,0,0,.18);border-radius:20px;padding:1px 8px;font-size:12px}
  .tab:not(.active) .pill{background:rgba(20,255,185,.16);color:var(--gold)}
  .ago{font-size:13px;color:var(--muted);white-space:nowrap}
  .ago.stale{color:#e0a93b;font-weight:700}
  .fubox{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
  .fubox h3{font-size:15px;margin-bottom:10px}
  .fu-add{display:grid;grid-template-columns:1.4fr 1.6fr auto auto;gap:10px}
  .fu-add input{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px}
  .fu-add button{background:var(--gold);color:#000;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer;white-space:nowrap}
  .fu-list{display:flex;flex-direction:column;gap:8px;margin-bottom:22px}
  .fu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .fu-item.fu-done{opacity:.5}.fu-item.fu-done .fu-title{text-decoration:line-through}
  .fu-title{font-weight:700;font-size:14px}
  .fu-note{color:var(--muted);font-size:13px;margin-top:3px}
  .fu-due{font-size:12px;font-weight:700;color:var(--muted);margin-left:6px}
  .fu-due.soon{color:#e0a93b}.fu-due.od{color:#e05b5b}
  .fu-actions{display:flex;gap:8px;white-space:nowrap}
  .fu-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:var(--text);border-radius:7px;padding:7px 12px;cursor:pointer;font-size:13px;font-weight:600}
  .fu-del{color:var(--muted)}.fu-del:hover{color:#e05b5b;border-color:#e05b5b}
  .sechead{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:8px 0 10px;font-weight:700}
</style></head><body>
<header><img src="/logo.png" alt="Avanzta Contractor Marketing Group" class="brandlogo"><span style="color:var(--muted);font-size:13px">CRM</span>
  <div class="nav"><a href="/">Search</a><a href="/manual">➕ Manual</a><a href="/crm">CRM</a><a href="/brain">🧠 Brain</a><a href="/review">Review &amp; Send →</a>${usageWidget()}</div></header>
<div class="tabs">
  <a class="tab ${followup ? "" : "active"}" href="/crm">All leads <span class="pill">${allLeads.length}</span></a>
  <a class="tab ${followup ? "active" : ""}" href="/crm?view=followup">⏰ Follow-up <span class="pill">${contactedCount}</span></a>
</div>
<div class="stats">${
  followup
    ? `<b>${openFollowups}</b> personal follow-up${openFollowups === 1 ? "" : "s"} &nbsp;·&nbsp; <b>${contactedCount}</b> contacted lead${contactedCount === 1 ? "" : "s"}`
    : `<b>${total}</b> saved leads &nbsp;·&nbsp; ${esc(byStage)}`
}</div>
${
  followup
    ? `<div class="fubox">
        <h3>➕ Add your own follow-up</h3>
        <div class="fu-add">
          <input id="fuTitle" placeholder="Who / business (e.g. Joe's Roofing)">
          <input id="fuNote" placeholder="Note (optional) — e.g. called, wants a quote">
          <input id="fuDue" type="date" title="Follow up on">
          <button onclick="addFu()">Add</button>
        </div>
      </div>
      <div class="sechead">Your follow-ups${openFollowups ? ` — ${openFollowups} open` : ""}</div>
      <div class="fu-list" id="fuList">${
        followups.length
          ? followups.map(renderFollowupItem).join("")
          : '<div class="empty" style="margin:6px 0;text-align:left">No personal follow-ups yet — add one above.</div>'
      }</div>
      <div class="sechead">Contacted leads${contactedCount ? ` — ${contactedCount}` : ""}</div>`
    : ""
}
${
  total
    ? `<table><thead><tr><th>Business</th><th>Contact</th><th>Source</th>${
        followup ? "<th>Contacted</th>" : ""
      }<th>Stage</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${leads
        .map((l) => renderCrmRow(l, followup))
        .join("")}</tbody></table>`
    : followup
    ? '<div class="empty" style="margin-top:20px">No contacted leads yet.<br>Set a lead\'s stage to <b>Contacted</b> in <b>All leads</b> and it\'ll show here.</div>'
    : '<div class="empty">No saved leads yet.<br>Go to <a href="/" style="color:var(--gold)">Search</a>, find prospects, and click <b>💾 Save</b> to add them here.</div>'
}
<script>
const FOLLOWUP=${followup};
async function post(url,data){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});return r.json()}
function esc(s){return (s||'')}
function dropRow(id){const r=document.getElementById('crm-'+id);if(r){r.style.transition='opacity .3s';r.style.opacity='0';setTimeout(()=>r.remove(),300)}}
async function setStage(id,stage){await post('/api/crm/update/'+id,{stage});if(FOLLOWUP&&stage!=='Contacted')dropRow(id)}
async function setNotes(id,notes){await post('/api/crm/update/'+id,{notes})}
async function removeCrm(id){await post('/api/crm/remove/'+id,{});const r=document.getElementById('crm-'+id);if(r)r.remove()}
async function addFu(){
  const t=document.getElementById('fuTitle'),n=document.getElementById('fuNote'),d=document.getElementById('fuDue');
  if(!t.value.trim()){t.focus();return}
  const r=await post('/api/followup/add',{title:t.value,note:n.value,due:d.value});
  if(r.ok)location.reload();
}
async function fuDone(id,done){await post('/api/followup/update/'+id,{done:!!done});location.reload()}
async function fuDel(id){await post('/api/followup/remove/'+id,{});const r=document.getElementById('fu-'+id);if(r)r.remove()}
</script></body></html>`;
}
