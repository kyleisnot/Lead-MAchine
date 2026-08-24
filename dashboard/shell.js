// shell.js — the shared UI shell every dashboard page uses:
// light/dark theme init + toggle, the left sidebar nav, and the common component styles.
// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI SHELL — dual theme (Clean light / Refined dark) with a toggle,
// a left sidebar, and scannable tables. Injected into every page (see the
// `<head>` / `</style>` / header / footer wiring below) so all pages match.
// ─────────────────────────────────────────────────────────────────────────────

// Sets the theme on <html> BEFORE first paint (no flash). Stored choice wins;
// otherwise follows the OS. Defaults to dark (the app's original identity).
export const THEME_INIT_SCRIPT = `<script>(function(){try{var t=localStorage.getItem('lm-theme');if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>`;

// Runs at end of <body>: syncs the theme toggle + keeps the header's token counter fresh
// from /api/usage (which is per-user, so it shows THIS account's plan usage).
export const SHELL_TAIL_SCRIPT = `<script>
function lmSyncTheme(){var dark=document.documentElement.getAttribute('data-theme')!=='light';var b=document.getElementById('themeBtn');if(b){var ti=b.querySelector('.ti'),tl=b.querySelector('.tl');if(ti)ti.textContent=dark?'☀':'☾';if(tl)tl.textContent=dark?'Light mode':'Dark mode';}}
function lmToggleTheme(){var light=document.documentElement.getAttribute('data-theme')==='light';var next=light?'dark':'light';document.documentElement.setAttribute('data-theme',next);try{localStorage.setItem('lm-theme',next);}catch(e){}lmSyncTheme();}
lmSyncTheme();
(function(){async function u(){try{var r=await(await fetch('/api/usage')).json();if(!r.ok)return;var t=document.getElementById('sbTok'),s=document.getElementById('sbSearches'),w=document.getElementById('sbBarWrap'),bar=document.getElementById('sbBar');
if(r.allotment){if(t)t.textContent=(Number(r.tokens)||0).toLocaleString()+' / '+Number(r.allotment).toLocaleString();if(s)s.textContent='resets '+(r.resetsOn||'')+' · '+(r.searches||0)+' searches';if(w&&bar){var pct=Math.min(100,Math.round((Number(r.tokens)||0)/Number(r.allotment)*100));w.style.display='block';bar.style.width=pct+'%';w.className='tokbar'+(pct>=85?' warn':'');}}
else{if(t)t.textContent=(Number(r.tokens)||0).toLocaleString()+' tokens';if(s)s.textContent=(r.searches||0)+' searches';if(w)w.style.display='none';}}catch(e){}}u();setInterval(u,30000);})();
</script>`;

function navIcon(key) {
  const s = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">';
  if (key === "search") return s + '<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.2-4.2"></path></svg>';
  if (key === "crm") return s + '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18M9 4v16"></path></svg>';
  if (key === "brain") return s + '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6V17a2 2 0 0 0 2 2h1"></path><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6V17a2 2 0 0 1-2 2h-1"></path><path d="M12 4v15"></path></svg>';
  if (key === "demo") return s + '<circle cx="12" cy="12" r="9"></circle><path d="M10 8.5l6 3.5-6 3.5z"></path></svg>';
  if (key === "admin") return s + '<path d="M12 3l7 4v5c0 4.4-3 8.4-7 9-4-.6-7-4.6-7-9V7z"></path><path d="M9.5 12l2 2 3.5-3.5"></path></svg>';
  return s + "</svg>";
}

// The left rail + opening <main>. Pages close it with `</main></div>` (in SHELL footer).
// opts.isAdmin adds the Admin link (only render it for admin users).
export function sidebar(active, { isAdmin = false } = {}) {
  const link = (href, key, label) =>
    `<a class="navlink${active === key ? " active" : ""}" href="${href}"><span class="ic">${navIcon(key)}</span><span class="lbl">${label}</span></a>`;
  return `<div class="app"><nav class="side">
  <div class="brand"><img src="/logo.png" alt="Avanzta"></div>
  ${link("/", "search", "Search")}
  ${link("/crm", "crm", "CRM")}
  ${link("/brain", "brain", "Brain")}
  ${isAdmin ? link("/demo", "demo", "Demo") : ""}
  ${isAdmin ? link("/admin", "admin", "Admin") : ""}
  <div class="grow"></div>
  <div class="foot">
    <button class="themebtn" id="themeBtn" onclick="lmToggleTheme()" aria-label="Toggle light or dark mode"><span class="ti">&#9788;</span><span class="tl">Light mode</span></button>
  </div>
</nav><main class="main">`;
}

// All shared styling (both themes + layout + components). Appended to each page's
// <style> so it overrides the page's original rules. Uses the app's existing CSS
// variable names (--bg, --panel, --border, --text, --muted, --gold) so every
// existing `var(--…)` reference is re-themed at once.
export const SHARED_CSS = `
:root{--bg:#f6f7f9;--panel:#ffffff;--surface:#ffffff;--surface2:#f9fafb;--text:#1a1d24;--muted:#5b6472;--faint:#98a0ab;--border:#e6e8ec;--border-strong:#d6dae0;--gold:#0c8f50;--accent:#0c8f50;--accent-ink:#0a7a44;--accent-weak:#e7f5ee;--on-accent:#ffffff;--danger:#d92d20;--warn:#b25e09;--warn-weak:#f8efe2;--sidebar:#ffffff;--sidebar-border:#e6e8ec}
:root[data-theme="dark"]{--bg:#0d1117;--panel:#161b22;--surface:#161b22;--surface2:#1b212b;--text:#e6edf3;--muted:#8b949e;--faint:#6e7681;--border:#262c36;--border-strong:#333b45;--gold:#2ee6a6;--accent:#2ee6a6;--accent-ink:#2ee6a6;--accent-weak:rgba(46,230,166,.12);--on-accent:#04241a;--danger:#f85149;--warn:#e0a93b;--warn-weak:rgba(224,169,59,.14);--sidebar:#0f141b;--sidebar-border:#20262f}
html,body{background:var(--bg);color:var(--text)}
body{margin:0!important;padding:0!important;max-width:none!important;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body::before{display:none!important;content:none!important}
a{color:var(--accent)}
.app{display:flex;min-height:100vh;align-items:stretch}
.side{width:212px;flex:none;background:var(--sidebar);border-right:1px solid var(--sidebar-border);position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:16px 12px;gap:4px}
.side .brand{display:inline-flex;align-items:center;background:#10151d;border-radius:9px;padding:9px 12px;margin:2px 2px 14px}.side .brand img{height:24px;width:auto;display:block}
.navlink{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px;color:var(--muted);font-weight:600;font-size:14px;text-decoration:none}
.navlink .ic{display:inline-flex;color:currentColor}
.navlink:hover{background:var(--surface2);color:var(--text)}
.navlink.active{background:var(--accent-weak);color:var(--accent-ink)}
.side .grow{flex:1}
.side .foot{border-top:1px solid var(--sidebar-border);padding-top:12px;display:flex;flex-direction:column;gap:10px}
.themebtn{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:9px;border:1px solid var(--border-strong);background:var(--surface);color:var(--muted);font-weight:600;font-size:13px;cursor:pointer}
.themebtn:hover{color:var(--text)}
.main{flex:1;min-width:0;padding:24px 30px;max-width:1180px}
.pagehead{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.pagehead h1{font-size:22px;font-weight:800;letter-spacing:.2px;color:var(--text)}
.pagehead .spacer{flex:1}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:12px}
input,select,textarea{background:var(--surface);border:1px solid var(--border-strong);color:var(--text)}
input::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
label{color:var(--muted)}
.go,.build{background:var(--accent);color:var(--on-accent);border:none}
.go:hover{filter:brightness(.96)}
.rescan{background:transparent;border:1px solid var(--border-strong);color:var(--muted)}.rescan:hover{color:var(--text)}
.chip{background:var(--surface2);border:1px solid var(--border);color:var(--text)}.chip:hover{border-color:var(--accent);color:var(--accent-ink)}
.stat{background:var(--panel);border:1px solid var(--border)}
.stat .n{color:var(--text)}.stat .l{color:var(--muted)}
.stat.good .n,.good .n{color:var(--accent)}
.lead{background:var(--panel);border:1px solid var(--border)}.lead:hover{border-color:var(--border-strong)}
.lead h3{color:var(--text)}.lead .meta,.meta{color:var(--muted)}
.badge{background:var(--accent-weak);color:var(--accent-ink)}
.src{color:var(--faint)}.muted{color:var(--muted)}.email{color:var(--accent)}.noemail{color:var(--warn)}
.save{background:transparent;border:1px solid var(--border-strong);color:var(--text)}.save:hover{background:var(--surface2)}
.save.saved-on{background:var(--accent-weak);border-color:transparent;color:var(--accent-ink)}
.hide{background:transparent;border:1px solid var(--border);color:var(--faint)}.hide:hover{color:var(--danger);border-color:var(--danger)}
.memline{color:var(--muted)}.memline b{color:var(--accent-ink)}
.optsep{background:var(--border-strong)}
.estimate{color:var(--muted)}.estimate b{color:var(--accent-ink)}.estimate.big,.estimate.big b{color:var(--warn)}
.fresh-active{background:var(--accent-weak);color:var(--accent-ink)}.fresh-unknown{background:var(--warn-weak);color:var(--warn)}
.lic-yes{background:var(--accent-weak);color:var(--accent-ink)}.lic-no{background:var(--surface2);color:var(--muted)}.lic-verify{color:var(--accent)}
.spinner{border-color:var(--accent);border-top-color:transparent}
#status{color:var(--text)}
table{background:var(--surface);border:1px solid var(--border)}
th{color:var(--muted);border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:2}
td{border-bottom:1px solid var(--border);color:var(--text)}
tbody tr:nth-child(even){background:var(--surface2)}
tbody tr:hover{background:var(--accent-weak)}
.sub{color:var(--muted)}.warn{color:var(--warn)}
.actions a{color:var(--accent)}
.rm{background:transparent;border:1px solid var(--border);color:var(--muted)}.rm:hover{color:var(--danger);border-color:var(--danger)}
select.stage,input.notes{background:var(--surface);border:1px solid var(--border-strong);color:var(--text)}
.empty{color:var(--muted)}
.tab{color:var(--muted);background:var(--surface);border:1px solid var(--border)}.tab:hover{color:var(--text)}
.tab.active{color:var(--accent-ink);background:var(--accent-weak);border-color:transparent}
.tab .pill{background:var(--surface2);color:var(--muted)}.tab.active .pill{background:var(--surface);color:var(--accent-ink)}
.search,.search-box{background:var(--surface);border:1px solid var(--border-strong);color:var(--text)}
.tag{background:var(--surface2);color:var(--muted)}.tag.nosite{background:var(--accent-weak);color:var(--accent-ink)}.tag.site{background:var(--warn-weak);color:var(--warn)}
.ago{color:var(--muted)}.ago.stale{color:var(--warn)}
.fubox{background:var(--panel);border:1px solid var(--border)}
.fu-add button{background:var(--accent);color:var(--on-accent);border:none}
.fu-item{background:var(--panel);border:1px solid var(--border)}
.fu-title{color:var(--text)}.fu-note{color:var(--muted)}.fu-due{color:var(--muted)}.fu-due.soon{color:var(--warn)}.fu-due.od{color:var(--danger)}
.fu-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text)}.fu-del{color:var(--muted)}.fu-del:hover{color:var(--danger);border-color:var(--danger)}
.sechead{color:var(--muted)}
.panel{padding:26px 28px}
.row{gap:18px;row-gap:20px}
.row label,.opts label{margin-bottom:8px;font-size:11px}
input,select{padding:11px 13px}
.go{padding:12px 26px;font-size:15px}
.rescan{padding:12px 15px}
.chiplabel,.optslabel{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:600}
.chiplabel{margin:22px 0 10px}
.optslabel{margin:24px 0 12px;padding-top:20px;border-top:1px solid var(--border)}
.chips{margin-top:0;gap:9px}
.chip{padding:7px 14px}
.opts{margin-top:0}
#estimate{margin-top:16px}
.pagehead{flex-wrap:wrap;gap:12px 14px}
.statbox{display:flex;align-items:center;gap:16px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 16px}
.statbox .cell{display:flex;flex-direction:column;gap:1px;line-height:1.25}
.statbox .k{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600}
.statbox .v{font-size:17px;font-weight:800;color:var(--text)}
.statbox .s2{font-size:11px;color:var(--faint)}
.statbox .sep{width:1px;height:34px;background:var(--border)}
.tokbar{width:130px;height:5px;background:var(--border);border-radius:3px;margin-top:7px;overflow:hidden;display:none}
.tokbar-fill{height:100%;background:var(--accent);width:0%;transition:width .3s}
.tokbar.warn .tokbar-fill{background:var(--warn)}
.titlewrap h1{margin:0}
.pagesub{font-size:13px;color:var(--muted);font-weight:400;margin-top:3px}
.explain{background:var(--panel);border:1px solid var(--border);border-radius:12px;margin-bottom:16px;overflow:hidden}
.explain>summary{list-style:none;cursor:pointer;padding:15px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.explain>summary::-webkit-details-marker{display:none}
.explain>summary::after{content:"⌄";margin-left:auto;color:var(--muted);font-size:18px;line-height:1}
.explain[open]>summary::after{content:"⌃"}
.ex-ttl{font-weight:700;color:var(--text);font-size:15px}
.ex-sub{color:var(--muted);font-size:13px}
.ex-body{padding:0 18px 16px}
.ex-item{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--border)}
.ex-num{flex:none;width:24px;height:24px;border-radius:50%;background:var(--accent-weak);color:var(--accent-ink);display:grid;place-items:center;font-weight:800;font-size:13px}
.ex-item b{color:var(--text);font-size:14px}
.ex-item p{color:var(--muted);font-size:13px;margin-top:4px;line-height:1.55}
.ex-foot{color:var(--muted);font-size:13px;margin-top:4px;padding-top:12px;border-top:1px solid var(--border);line-height:1.55}
.ex-foot b,.ex-item p b{color:var(--accent-ink)}
@media(max-width:860px){.side{width:60px;padding:14px 8px}.side .brand{display:none}.navlink .lbl,.themebtn .tl{display:none}.themebtn{justify-content:center}.main{padding:18px 16px}}
@media(max-width:700px){.row{grid-template-columns:1fr 1fr}.statbox{width:100%}}
`;

