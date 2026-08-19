// template.js — buildSiteV2(data): the polished website builder.
// Modeled on high-end contractor lead-gen sites (Landscape Around You / Greenscape):
// fixed translucent nav → full-bleed hero → who-we-are → textured stats → image-card services →
// image-card process → auto-animating before/after slider → projects → Google reviews →
// service areas + map → split CTA with photo grid → rich footer.
//
// Pure function — returns a complete HTML string. No browser needed.

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function savePreviewV2(data, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildSiteV2(data), "utf8");
  return outPath;
}

// Per-trade palette: primary (brand), cta (warm action color), dark (near-black sections).
function paletteFor(niche = "") {
  const c = niche.toLowerCase();
  if (/(landscap|lawn|tree|hardscap|garden|sod|irrigation)/.test(c)) return { primary: "#2f7d32", light: "#7cc24f", cta: "#cf6b35", dark: "#0e120f" };
  if (/(detail|car wash|auto)/.test(c)) return { primary: "#c0282d", light: "#ff5a5f", cta: "#e0a02a", dark: "#0d0e10" };
  if (/(roof)/.test(c)) return { primary: "#1c4e80", light: "#5b9bd5", cta: "#e07b1a", dark: "#0c1118" };
  if (/(concrete|cement|mason|construct|remodel)/.test(c)) return { primary: "#b9601f", light: "#e8a24a", cta: "#2c6e8f", dark: "#13110e" };
  if (/(pressure|power wash|soft wash)/.test(c)) return { primary: "#0a8cb0", light: "#54c6e0", cta: "#e07b1a", dark: "#0a1418" };
  if (/(pest|extermin|termite)/.test(c)) return { primary: "#2f7d32", light: "#7cc24f", cta: "#cf6b35", dark: "#0e120f" };
  if (/(garage door)/.test(c)) return { primary: "#37618a", light: "#6ea0c8", cta: "#e07b1a", dark: "#0d1016" };
  if (/(fenc)/.test(c)) return { primary: "#8a5a2b", light: "#c79257", cta: "#3a7d4a", dark: "#15110c" };
  return { primary: "#1c5e8a", light: "#5b9bd5", cta: "#e07b1a", dark: "#0c1117" };
}

const digits = (p = "") => p.replace(/[^\d+]/g, "");

export function buildSiteV2(d) {
  const P = paletteFor(d.niche);
  const tel = digits(d.phone);
  const ph = `linear-gradient(135deg, ${P.dark} 0%, ${P.primary} 160%)`;
  const bgImg = (u) => (u ? `url('${u}') center/cover no-repeat` : ph);
  const rating = d.rating != null ? Number(d.rating).toFixed(1) : "5.0";
  const reviews = d.reviews != null ? d.reviews : null;
  const areas = (d.serviceAreas || []).filter(Boolean);
  const gallery = d.galleryURLs || [];
  const heroBg = d.heroURL
    ? `linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.72)), url('${d.heroURL}') center/cover no-repeat`
    : ph;

  // photos to scatter through the page
  const pool = [d.heroURL, ...gallery].filter(Boolean);
  const pic = (i) => pool[i % (pool.length || 1)] || null;

  // ── SERVICES (image-overlay cards) ──
  const services = (d.services || []).map(
    (s, i) => `
    <article class="scard" style="background:${bgImg(s.imgURL || pic(i))}">
      <div class="scard-grad"></div>
      <div class="scard-body"><h3>${esc(s.name)}</h3>
        <p>Professional ${esc(s.name.toLowerCase())} done right — quality craftsmanship on every project.</p>
        <a href="#contact" class="scard-link">Learn More →</a></div>
    </article>`
  ).join("");

  // ── STATS ──
  const stats = [
    ["15+", "Years Experience"], ["200+", "Projects Completed"], ["100%", "Client Satisfaction"],
    [`${rating}★`, "Google Rating"], [`${(d.services || []).length || 6}`, "Core Services"], ["24/7", "Support"],
  ].map(([n, l]) => `<div class="stat"><span class="sn">${esc(n)}</span><span class="sl">${esc(l)}</span></div>`).join("");

  // ── PROCESS (image-bg cards) ──
  const steps = [
    ["Request Free Estimate", "Call or fill out our form. We assess the scope and discuss your vision — completely free, no obligation.", "Get Started →"],
    ["We Review Your Project", "We put together a detailed proposal — materials, timeline, and pricing — tailored to your property. No surprises.", "See the Plan →"],
    ["We Get to Work", "Our crew executes your project with professional craftsmanship — clean jobsite, on-time delivery, results that exceed expectations.", "View Our Work →"],
  ].map((s, i) => `
    <article class="pcard" style="background:${bgImg(pic(i + 1))}">
      <div class="pcard-grad"></div>
      <div class="pcard-body"><span class="pstep">Step ${i + 1}</span>
        <h3>${esc(s[0])}</h3><p>${esc(s[1])}</p><a href="#contact" class="pcard-link">${esc(s[2])}</a></div>
    </article>`).join("");

  // ── CHECKLIST ──
  const checks = [
    ["Free Estimates", "No obligation, honest assessment, fair pricing."],
    ["Fast Response", "We respond to every inquiry within 24 hours."],
    ["Attention to Detail", "Clean, professional work that improves curb appeal."],
    ["Strong Communication", "You'll always know what's happening on your project."],
  ].map((c) => `<li><span class="ck">✓</span><div><b>${esc(c[0])}</b> — ${esc(c[1])}</div></li>`).join("");

  // ── BEFORE / AFTER (auto-animating slider) ──
  const beforeAfter = d.beforeURL && d.afterURL ? `
  <section class="section alt ba-sec"><div class="wrap ba-row">
    <div class="ba" id="ba">
      <img class="ba-img ba-before" src="${d.beforeURL}" alt="Before" draggable="false">
      <img class="ba-img ba-after" src="${d.afterURL}" alt="After" draggable="false">
      <div class="ba-line" id="baLine"><div class="ba-knob">◀&#8201;▶</div></div>
      <span class="ba-tag ba-bl">Before</span><span class="ba-tag ba-ar">After</span>
    </div>
    <div class="ba-copy">
      <p class="eyebrow">See the Difference</p>
      <h2>Before &amp; After</h2>
      <p class="body">Slide to see the transformation. At ${esc(d.name)}, we take pride in delivering results that speak for themselves — every job done with care, quality, and an eye for detail. This is the kind of difference you can expect.</p>
      ${d.baSynthetic ? `<p class="body" style="font-size:13px;opacity:.7;margin-top:-10px">*Illustrative example of typical results.</p>` : ""}
      <a href="#contact" class="btn btn-p">Get Your Free Quote</a>
    </div>
  </div></section>` : "";

  // ── PROJECTS / GALLERY ──
  const projects = gallery.length ? `
  <section class="section alt" id="projects"><div class="wrap center">
    <p class="eyebrow">Our Work</p><h2>Recent Projects</h2>
    <div class="grid">${gallery.slice(0, 8).map((u) => `<div class="gitem" style="background:${bgImg(u)}"></div>`).join("")}</div>
  </div></section>` : "";

  // ── REVIEWS ──
  const testi = [
    [`${d.name} did an amazing job — professional, on time, and the results completely transformed the property.`, "Michael R.", "2 weeks ago"],
    ["Great communication from start to finish and fair pricing. The crew was respectful and the quality is exceptional. Highly recommend.", "Sarah J.", "1 month ago"],
    ["Best in the area. They were reliable, did quality work, and the before and after is unbelievable. We'll definitely use them again.", "David W.", "3 weeks ago"],
  ].map((t) => `
    <div class="rcard"><div class="ravatar">${esc(t[1][0])}</div>
      <div class="rhead"><b>${esc(t[1])}</b><span>${esc(t[2])} · ${esc(d.cityState)}</span></div>
      <div class="rstars">★★★★★</div><p>“${esc(t[0])}”</p></div>`).join("");

  // ── SERVICE AREAS (+ map) ──
  const mapQ = encodeURIComponent((areas[0] || d.cityState || "").trim());
  const areaTabs = areas.map((a, i) =>
    `<button class="atab${i === 0 ? " on" : ""}" data-q="${encodeURIComponent(a)}" onclick="setArea(this)">${esc(a)}</button>`).join("");
  const areasSec = areas.length ? `
  <section class="section dark areas" id="areas"><div class="wrap center">
    <p class="eyebrow light">Where We Work</p>
    <h2 class="onlight">We Serve <span class="hl">${esc(areas[0])}</span> &amp; Surrounding Areas</h2>
    <p class="lead">Professional ${esc(d.niche.toLowerCase())} services across the region. Click your city to explore.</p>
    <div class="atabs">${areaTabs}</div>
    <div class="map"><iframe id="amap" src="https://www.google.com/maps?q=${mapQ}&z=11&output=embed" loading="lazy"></iframe></div>
  </div></section>` : "";

  // ── CTA photo grid ──
  const ctaPics = (pool.length ? pool : [null, null, null, null]).slice(0, 4);
  while (ctaPics.length < 4) ctaPics.push(ctaPics[ctaPics.length - 1] || null);
  const ctaGrid = ctaPics.map((u) => `<div class="cgi" style="background:${bgImg(u)}"></div>`).join("");

  const social = [];
  if (d.fbUrl && d.fbUrl !== "#") social.push(`<a href="${esc(d.fbUrl)}" target="_blank" aria-label="Facebook">f</a>`);
  if (d.igUrl && d.igUrl !== "#") social.push(`<a href="${esc(d.igUrl)}" target="_blank" aria-label="Instagram">⌾</a>`);

  const brand = d.logoURL
    ? `<img src="${d.logoURL}" alt="${esc(d.name)}">`
    : `<span class="mark">${esc((d.name[0] || "B").toUpperCase())}</span>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.name)} — ${esc(d.niche)} in ${esc(d.cityState)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--p:${P.primary};--pl:${P.light};--cta:${P.cta};--dark:${P.dark};--ink:#15181c;--muted:#5d6571;--line:#e7eaef;--alt:#f5f7fa}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
body{font-family:'Barlow',system-ui,sans-serif;color:var(--ink);line-height:1.6;background:#fff;overflow-x:hidden}
img{max-width:100%;display:block}a{text-decoration:none;color:inherit}
h1,h2,h3{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;line-height:.98;letter-spacing:.5px}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.section{padding:84px 0}.alt{background:var(--alt)}.center{text-align:center}
.eyebrow{color:var(--p);font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:13px;margin-bottom:10px}
.eyebrow.light{color:var(--pl)}
h2{font-size:46px;margin-bottom:30px}.onlight{color:#fff}.hl{color:var(--pl)}
.lead{color:var(--muted);font-size:17px;max-width:640px;margin:0 auto 26px}
.dark .lead{color:rgba(255,255,255,.72)}
.btn{display:inline-flex;align-items:center;gap:8px;font-family:'Barlow';font-weight:700;text-transform:uppercase;letter-spacing:1px;font-size:14px;padding:15px 28px;border-radius:8px;transition:.16s;cursor:pointer;border:none}
.btn-cta{background:var(--cta);color:#fff}.btn-cta:hover{filter:brightness(.92);transform:translateY(-2px)}
.btn-p{background:var(--p);color:#fff}.btn-p:hover{filter:brightness(.92)}
.btn-out{background:transparent;border:2px solid currentColor}
.btn-wout{background:transparent;border:2px solid rgba(255,255,255,.8);color:#fff}.btn-wout:hover{background:#fff;color:var(--ink)}

/* NAV */
.nav{position:fixed;top:0;left:0;right:0;z-index:90;transition:.25s;padding:16px 0}
.nav.scrolled{background:rgba(13,15,16,.92);backdrop-filter:blur(8px);box-shadow:0 4px 22px rgba(0,0,0,.3);padding:10px 0}
.nav .wrap{display:flex;align-items:center;gap:24px}
.logo{display:flex;align-items:center;gap:11px;color:#fff;font-family:'Anton';font-size:21px;letter-spacing:1px}
.logo img{height:46px;width:auto}
.logo .mark{width:40px;height:40px;border-radius:9px;background:var(--p);display:grid;place-items:center;font-size:20px}
.menu{display:flex;gap:26px;margin:0 auto}
.menu a{color:#fff;font-weight:600;font-size:14px;letter-spacing:1px;text-transform:uppercase;opacity:.92}
.menu a:hover{color:var(--pl);opacity:1}
.nav .rgt{display:flex;align-items:center;gap:18px}
.nav .ph{color:#fff;font-weight:700;font-family:'Barlow'}
@media(max-width:960px){.menu{display:none}.logo span{display:none}}
@media(max-width:560px){.nav .ph{display:none}}

/* HERO */
.hero{min-height:100vh;background:${heroBg};display:flex;align-items:center;color:#fff;text-align:center;position:relative}
.hero .wrap{max-width:900px}
.hero h1{font-size:clamp(46px,8vw,92px);margin-bottom:14px;text-shadow:0 4px 30px rgba(0,0,0,.5)}
.hero .tag{color:var(--pl);font-weight:700;letter-spacing:3px;text-transform:uppercase;font-size:15px;margin-bottom:26px}
.hero .sub{font-size:19px;opacity:.92;max-width:600px;margin:0 auto 28px}
.scroll{position:absolute;bottom:26px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.7);font-size:12px;letter-spacing:3px;text-transform:uppercase}
.scroll i{display:block;margin-top:6px;animation:bob 1.6s infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(7px)}}

/* WHO WE ARE */
.about{display:grid;grid-template-columns:1fr 1.05fr;gap:54px;align-items:center}
.about-img{position:relative;border-radius:16px;overflow:hidden;aspect-ratio:4/5;box-shadow:0 20px 50px rgba(0,0,0,.16)}
.about-img .ph{position:absolute;inset:0;background-size:cover;background-position:center}
.gbadge{position:absolute;left:18px;bottom:18px;background:var(--p);color:#fff;border-radius:12px;padding:14px 20px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.gbadge b{font-family:'Anton';font-size:30px;display:block;line-height:1}.gbadge span{font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
.about h2{font-size:52px}
.about p.body{color:var(--muted);font-size:17px;margin:6px 0 18px}
.checks{list-style:none;display:grid;gap:13px;margin-bottom:26px}
.checks li{display:flex;gap:13px;align-items:flex-start}
.ck{flex:none;width:26px;height:26px;border-radius:50%;background:var(--p);color:#fff;display:grid;place-items:center;font-size:14px;font-weight:700}
.checks b{color:var(--ink)}.checks div{color:var(--muted);font-size:15px}
.about .btns{display:flex;gap:14px;flex-wrap:wrap}.btn-out{color:var(--p)}
@media(max-width:860px){.about{grid-template-columns:1fr;gap:32px}.about-img{aspect-ratio:16/11}}

/* STATS */
.stats{background:var(--dark);position:relative;padding:48px 0}
.stats::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:42px 42px;opacity:.6}
.stats .wrap{position:relative;display:grid;grid-template-columns:repeat(6,1fr);gap:18px;text-align:center}
.sn{font-family:'Anton';font-size:44px;color:#fff;display:block;line-height:1}
.sl{color:rgba(255,255,255,.62);font-size:12px;letter-spacing:1.5px;text-transform:uppercase}
@media(max-width:860px){.stats .wrap{grid-template-columns:repeat(3,1fr);gap:26px}.sn{font-size:34px}}
@media(max-width:480px){.stats .wrap{grid-template-columns:repeat(2,1fr)}}

/* SERVICE CARDS */
.scards{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.scard{position:relative;height:330px;border-radius:14px;overflow:hidden;display:flex;align-items:flex-end}
.scard-grad{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 30%,rgba(0,0,0,.85))}
.scard-body{position:relative;padding:22px;color:#fff}
.scard-body h3{font-size:24px;margin-bottom:7px}
.scard-body p{font-size:13.5px;opacity:.88;margin-bottom:9px}
.scard-link{color:var(--pl);font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px}
@media(max-width:900px){.scards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:520px){.scards{grid-template-columns:1fr}}

/* PROCESS */
.dark{background:var(--dark);color:#fff}
.pcards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.pcard{position:relative;min-height:380px;border-radius:14px;overflow:hidden;display:flex;align-items:flex-end}
.pcard-grad{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),rgba(0,0,0,.86))}
.pcard-body{position:relative;padding:26px;color:#fff;text-align:left}
.pstep{display:inline-block;background:var(--p);color:#fff;font-weight:700;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px;border-radius:6px;margin-bottom:12px}
.pcard-body h3{font-size:26px;margin-bottom:9px}.pcard-body p{font-size:14.5px;opacity:.88;margin-bottom:12px}
.pcard-link{color:var(--pl);font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px}
@media(max-width:820px){.pcards{grid-template-columns:1fr}}

/* BEFORE/AFTER (two-column: slider left, copy right) */
.ba-row{display:grid;grid-template-columns:1.05fr .95fr;gap:54px;align-items:center}
.ba-copy h2{font-size:52px}
.ba-copy .body{color:var(--muted);font-size:17px;margin:6px 0 24px}
@media(max-width:860px){.ba-row{grid-template-columns:1fr;gap:30px}}
.ba{position:relative;width:100%;aspect-ratio:4/3;border-radius:16px;overflow:hidden;user-select:none;touch-action:none;cursor:ew-resize;box-shadow:0 18px 46px rgba(0,0,0,.18)}
.ba-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none}
.ba-after{clip-path:inset(0 0 0 50%)}
.ba-line{position:absolute;top:0;bottom:0;left:50%;width:3px;background:#fff;transform:translateX(-50%);box-shadow:0 0 10px rgba(0,0,0,.5)}
.ba-knob{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);min-width:54px;height:42px;padding:0 10px;border-radius:24px;background:#fff;color:var(--ink);display:grid;place-items:center;font-size:13px;font-weight:700;box-shadow:0 3px 12px rgba(0,0,0,.4);letter-spacing:1px}
.ba-tag{position:absolute;bottom:14px;background:rgba(255,255,255,.92);color:#15181c;font-weight:700;font-size:13px;padding:6px 16px;border-radius:8px}
.ba-bl{left:14px}.ba-ar{right:14px}

/* PROJECTS GRID */
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.gitem{height:210px;border-radius:12px;background-size:cover;background-position:center}
@media(max-width:860px){.grid{grid-template-columns:repeat(2,1fr)}}

/* REVIEWS */
.reviews-top{display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:34px}
.gword span{font-family:'Barlow';font-weight:800;font-size:26px}
.g1{color:#4285F4}.g2{color:#EA4335}.g3{color:#FBBC05}.g4{color:#4285F4}.g5{color:#34A853}.g6{color:#EA4335}
.big-rate{font-family:'Anton';font-size:60px;color:#fff;line-height:1}
.big-stars{color:#ffc83d;font-size:24px;letter-spacing:3px}
.rsub{color:rgba(255,255,255,.6);font-size:14px}
.rcards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;text-align:left}
.rcard{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:24px}
.ravatar{width:46px;height:46px;border-radius:50%;background:var(--p);color:#fff;display:grid;place-items:center;font-weight:700;font-size:18px;float:left;margin-right:14px}
.rhead b{display:block;color:#fff}.rhead span{color:rgba(255,255,255,.55);font-size:13px}
.rstars{clear:both;color:#ffc83d;margin:12px 0 8px;letter-spacing:2px}
.rcard p{color:rgba(255,255,255,.82);font-size:15px}
@media(max-width:820px){.rcards{grid-template-columns:1fr}}

/* AREAS */
.areas .atabs{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:6px 0 26px}
.atab{background:transparent;border:none;color:rgba(255,255,255,.6);font-family:'Barlow';font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-size:13px;padding:8px 14px;border-radius:6px;cursor:pointer;border-bottom:2px solid transparent}
.atab.on,.atab:hover{color:#fff;border-bottom-color:var(--pl)}
.map{max-width:1000px;margin:0 auto;border-radius:14px;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.4)}
.map iframe{width:100%;height:440px;border:0;display:block;filter:grayscale(.1)}

/* FINAL CTA */
.fcta{background:var(--dark);color:#fff;overflow:hidden}
.fcta .grid2{display:grid;grid-template-columns:1fr 1fr}
.fcta .left{padding:80px 5vw 80px max(24px,calc((100vw - 1180px)/2 + 24px))}
.fcta h2{font-size:52px;color:#fff;margin-bottom:18px}
.fcta .pts{list-style:none;margin:18px 0 26px}.fcta .pts li{margin:8px 0;color:rgba(255,255,255,.85)}.fcta .pts li::before{content:"●";color:var(--pl);margin-right:10px;font-size:11px}
.fcta .btns{display:flex;gap:14px;flex-wrap:wrap}
.cgrid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
.cgi{background-size:cover;background-position:center;min-height:230px}
@media(max-width:860px){.fcta .grid2{grid-template-columns:1fr}.fcta .left{padding:60px 24px}.cgrid{grid-template-rows:auto}}

/* FOOTER */
footer{background:#0a0c0b;color:rgba(255,255,255,.72);padding:56px 0 26px}
footer .cols{display:grid;grid-template-columns:1.6fr 1fr 1fr 1.2fr;gap:34px}
footer h4{color:#fff;font-family:'Anton';letter-spacing:1px;font-size:17px;margin-bottom:14px}
footer a,footer p,footer li{color:rgba(255,255,255,.66);font-size:14.5px;margin-bottom:8px;list-style:none}
footer a:hover{color:#fff}
.fsoc{display:flex;gap:10px;margin-top:14px}.fsoc a{width:38px;height:38px;border-radius:8px;background:rgba(255,255,255,.08);display:grid;place-items:center;color:#fff;font-weight:700}
.fbar{border-top:1px solid rgba(255,255,255,.12);margin-top:32px;padding-top:18px;text-align:center;font-size:13px;color:rgba(255,255,255,.5)}
@media(max-width:780px){footer .cols{grid-template-columns:1fr 1fr;gap:24px}}
</style></head><body>

<!-- NAV -->
<nav class="nav" id="nav"><div class="wrap">
  <a href="#home" class="logo">${brand}<span>${esc(d.name)}</span></a>
  <div class="menu"><a href="#home">Home</a><a href="#services">Services</a><a href="#projects">Projects</a><a href="#about">About</a><a href="#contact">Contact</a></div>
  <div class="rgt">${d.phone ? `<a href="tel:${tel}" class="ph">📞 ${esc(d.phone)}</a>` : ""}<a href="#contact" class="btn btn-cta">Free Estimate</a></div>
</div></nav>

<!-- HERO -->
<header class="hero" id="home"><div class="wrap">
  <h1>${esc(d.name)}</h1>
  <p class="tag">${esc(d.cityState)} • ${esc(d.niche)}</p>
  <p class="sub">${esc(d.desc)}</p>
  <a href="#contact" class="btn btn-wout">Get a Free Estimate</a>
</div><div class="scroll">Scroll<i>⌄</i></div></header>

<!-- WHO WE ARE -->
<section class="section" id="about"><div class="wrap about">
  <div class="about-img"><div class="ph" style="background:${bgImg(pic(2))}"></div>
    <div class="gbadge"><b>${rating}★</b><span>Google Rated</span></div></div>
  <div><p class="eyebrow">Who We Are</p>
    <h2>Transforming ${esc(d.cityState)}'s Outdoor Spaces</h2>
    <p class="body">${esc(d.aboutText)}</p>
    <ul class="checks">${checks}</ul>
    <div class="btns"><a href="#contact" class="btn btn-p">Get Your Free Quote</a><a href="#projects" class="btn btn-out">See Our Work</a></div>
  </div>
</div></section>

<!-- STATS -->
<section class="stats"><div class="wrap">${stats}</div></section>

<!-- SERVICES -->
<section class="section" id="services"><div class="wrap center">
  <p class="eyebrow">What We Do</p><h2>Our Services</h2>
  <p class="lead">From concept to completion — professional craftsmanship on every project across ${esc(d.cityState)}.</p>
  <div class="scards">${services}</div>
</div></section>

<!-- PROCESS -->
<section class="section dark"><div class="wrap center">
  <p class="eyebrow light">How It Works</p><h2 class="onlight">Simple 3-Step Process</h2>
  <p class="lead">Getting started has never been easier.</p>
  <div class="pcards">${steps}</div>
</div></section>

${beforeAfter}
${projects}

<!-- REVIEWS -->
<section class="section dark"><div class="wrap center">
  <p class="eyebrow light">What Clients Say</p><h2 class="onlight">Google Reviews</h2>
  <div class="reviews-top">
    <div class="gword"><span class="g1">G</span><span class="g2">o</span><span class="g3">o</span><span class="g4">g</span><span class="g5">l</span><span class="g6">e</span></div>
    <div class="big-rate">${rating}</div><div class="big-stars">★★★★★</div>
    <div class="rsub">Based on Google Reviews${reviews ? ` · ${reviews} reviews` : ""} · ${esc(d.cityState)}</div>
  </div>
  <div class="rcards">${testi}</div>
</div></section>

${areasSec}

<!-- FINAL CTA -->
<section class="fcta" id="contact"><div class="grid2">
  <div class="left">
    <p class="eyebrow light">Start Your Project</p>
    <h2>Ready to Get Started?</h2>
    <p style="color:rgba(255,255,255,.8);font-size:17px;max-width:460px">${esc(d.desc)}</p>
    <ul class="pts"><li>Free on-site estimate — no commitment</li><li>Transparent pricing, no hidden fees</li><li>${rating}-star Google rated · Licensed &amp; insured</li></ul>
    <div class="btns">${d.phone ? `<a href="tel:${tel}" class="btn btn-cta">📞 Call ${esc(d.phone)}</a>` : ""}${d.email ? `<a href="mailto:${esc(d.email)}" class="btn btn-wout">✉️ Get Free Estimate →</a>` : ""}</div>
  </div>
  <div class="cgrid">${ctaGrid}</div>
</div></section>

<!-- FOOTER -->
<footer><div class="wrap">
  <div class="cols">
    <div><div class="logo" style="margin-bottom:12px">${brand}<span>${esc(d.name)}</span></div>
      <p>Professional ${esc(d.niche.toLowerCase())} serving ${esc(d.cityState)} and the surrounding areas with quality craftsmanship and attention to detail.</p>
      ${social.length ? `<div class="fsoc">${social.join("")}</div>` : ""}</div>
    <div><h4>Services</h4><ul>${(d.services || []).map((s) => `<li><a href="#services">${esc(s.name)}</a></li>`).join("")}</ul></div>
    <div><h4>Service Areas</h4><ul>${(areas.length ? areas : [d.cityState]).slice(0, 8).map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>
    <div><h4>Contact</h4>${d.phone ? `<p>📞 <a href="tel:${tel}">${esc(d.phone)}</a></p>` : ""}${d.email ? `<p>✉️ <a href="mailto:${esc(d.email)}">${esc(d.email)}</a></p>` : ""}<p>📍 ${esc(d.cityState)} &amp; Surrounding Areas</p></div>
  </div>
  <div class="fbar">© ${new Date().getFullYear()} ${esc(d.name)}. All rights reserved. · ${esc(d.niche)} · ${esc(d.cityState)}</div>
</div></footer>

<script>
// nav shrink on scroll
var nav=document.getElementById('nav');
addEventListener('scroll',function(){nav.classList.toggle('scrolled',scrollY>60);});
// service-area map switch
function setArea(b){document.querySelectorAll('.atab').forEach(function(t){t.classList.remove('on');});b.classList.add('on');document.getElementById('amap').src='https://www.google.com/maps?q='+b.dataset.q+'&z=11&output=embed';}
// before/after slider (auto-animates on load, then draggable)
(function(){
  var s=document.getElementById('ba'); if(!s) return;
  var after=s.querySelector('.ba-after'), line=document.getElementById('baLine'), auto=true, dir=1, pos=50, raf;
  function set(p){p=Math.max(2,Math.min(98,p));pos=p;after.style.clipPath='inset(0 0 0 '+p+'%)';line.style.left=p+'%';}
  function pct(e){var r=s.getBoundingClientRect();return (((e.touches?e.touches[0].clientX:e.clientX)-r.left)/r.width)*100;}
  function loop(){if(!auto)return;pos+=dir*0.45;if(pos>=80)dir=-1;if(pos<=20)dir=1;set(pos);raf=requestAnimationFrame(loop);}
  loop(); setTimeout(function(){auto=false;cancelAnimationFrame(raf);set(50);},5200);
  function stop(){auto=false;cancelAnimationFrame(raf);}
  var drag=false;
  s.addEventListener('mousedown',function(e){drag=true;stop();set(pct(e));e.preventDefault();});
  addEventListener('mousemove',function(e){if(drag)set(pct(e));});
  addEventListener('mouseup',function(){drag=false;});
  s.addEventListener('touchstart',function(e){drag=true;stop();set(pct(e));},{passive:true});
  s.addEventListener('touchmove',function(e){if(drag)set(pct(e));},{passive:true});
  addEventListener('touchend',function(){drag=false;});
})();
</script>
</body></html>`;
}
