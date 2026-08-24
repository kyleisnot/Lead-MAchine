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
// Contract:
//   export const demoRouter — express Router, every route guarded by
//                             requireUser + requireAdmin (same as admin.js).
//   GET /demo               — the presentation page
//   GET /demo/api/saved     — { ok, saved:[{key,niche,city,state,sources,limit,…}], keys:[…] }
import express from "express";
import { requireUser, requireAdmin } from "./auth.js";
import * as store from "../data/store.js";
import { RATE_PER_1K } from "../lib/spend.js";
import { THEME_INIT_SCRIPT, SHELL_TAIL_SCRIPT, SHARED_CSS, sidebar } from "./shell.js";

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

demoRouter.get("/demo", requireUser, requireAdmin, (req, res) => {
  res.type("html").send(renderDemoPage(req));
});

// ── page ─────────────────────────────────────────────────────────────────────

function renderDemoPage(req) {
  return `<!doctype html><html lang="en"><head>${THEME_INIT_SCRIPT}<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lead Machine — Demo</title><link rel="icon" href="/mark.png">
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
  @media(max-width:820px){
    .dform{grid-template-columns:1fr 1fr;gap:12px}
    .dgo{grid-column:1/-1;width:100%}
    .dhead h1{font-size:30px}
    .dstats{grid-template-columns:1fr}
    .dstat .n{font-size:44px}
  }
${SHARED_CSS}</style></head><body>
${sidebar("demo", { isAdmin: true })}
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
