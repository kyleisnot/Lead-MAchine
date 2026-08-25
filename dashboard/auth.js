// auth.js — authentication for the dashboard: login/signup pages, session cookie,
// and the middleware that resolves who is making each request.
//
// CONTRACT (server.js and admin.js build against exactly this):
//   authRouter                    — express Router serving GET/POST /login, /signup, /logout
//   requireUser(req, res, next)   — sets req.userId, req.userEmail, req.isAdmin.
//                                   sqlite mode: local user, isAdmin=true, never redirects.
//                                   supabase mode: verifies the session cookie; unauthenticated
//                                   HTML requests redirect to /login, /api/* get 401 JSON.
//   requireAdmin(req, res, next)  — after requireUser; 403 unless req.isAdmin.
//
// How the session works (supabase mode):
//   Sign-in happens server-side (`signInWithPassword`) and the resulting Supabase
//   session is stored in one httpOnly cookie, `lm_session`, holding
//   {access_token, refresh_token} as JSON. Every request verifies the access token —
//   locally (HS256 signature check) when SUPABASE_JWT_SECRET is set, otherwise with
//   `auth.getUser(token)`; verified tokens are cached in memory for 5 minutes so
//   we don't make a network call per request. When the access token has expired we
//   silently `refreshSession({refresh_token})` and re-write the cookie.
//   Cookies are parsed/serialized by hand — no extra dependency.
import express from "express";
import crypto from "node:crypto";
import { dataProvider, getSupabase, supabaseUrl } from "../lib/supabase.js";
import { THEME_INIT_SCRIPT, SHARED_CSS } from "./shell.js";

// ── config ──────────────────────────────────────────────────────────────────
const COOKIE = "lm_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, matches Supabase refresh-token life
const TOKEN_TTL_MS = 5 * 60 * 1000; // verified-token cache window
const TOKEN_CACHE_MAX = 1000;
const MIN_PASSWORD = 8;

// Paths that must stay reachable without a session.
// /auth/* is the Google OAuth handoff: the browser hits them while still signed out.
const PUBLIC_PATHS = new Set([
  "/login", "/signup", "/logout", "/logo.png", "/mark.png",
  "/auth/google", "/auth/callback", "/auth/session",
]);
function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith("/favicon");
}

const supabaseMode = () => dataProvider() === "supabase";

// ── small helpers ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pathOf(req) {
  const url = req.originalUrl || req.url || "/";
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

// True when the caller wants JSON rather than a redirect (all /api/* plus explicit
// JSON-only Accept headers, e.g. fetch() calls from the dashboard).
function wantsJson(req) {
  if (pathOf(req).startsWith("/api/")) return true;
  const accept = String(req.headers?.accept || "");
  return accept.includes("application/json") && !accept.includes("text/html");
}

// Cookie parsing by hand (no cookie-parser dependency).
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

function isSecureRequest(req) {
  if (req?.secure) return true;
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https";
}

// Public origin of THIS request ("https://host"), so the OAuth redirect comes back to
// whichever host the user is actually on (localhost in dev, the Vercel domain in prod).
function originOf(req) {
  const host = String(req?.headers?.host || "").split(",")[0].trim();
  return `${isSecureRequest(req) ? "https" : "http"}://${host}`;
}

function appendCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", value);
  else res.setHeader("Set-Cookie", (Array.isArray(prev) ? prev : [prev]).concat(value));
}

function writeSessionCookie(req, res, session) {
  if (!session?.access_token || res.headersSent) return;
  const payload = encodeURIComponent(JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token || "",
  }));
  const bits = [`${COOKIE}=${payload}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${COOKIE_MAX_AGE}`];
  if (isSecureRequest(req)) bits.push("Secure");
  appendCookie(res, bits.join("; "));
}

function clearSessionCookie(req, res) {
  if (res.headersSent) return;
  const bits = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (isSecureRequest(req)) bits.push("Secure");
  appendCookie(res, bits.join("; "));
}

// ── demo workspace (admin-only impersonation) ───────────────────────────────
// The operator demos the REAL product against a dedicated, fully seeded account.
// `lm_demo` is a marker cookie ONLY — it grants nothing by itself. requireUser
// swaps in the demo account's user id exclusively for an ALREADY-AUTHENTICATED
// ADMIN, so a non-admin holding the cookie is completely unaffected, and the
// cookie is ignored entirely until the demo account actually exists.
const DEMO_COOKIE = "lm_demo";
const DEMO_COOKIE_MAX_AGE = 60 * 60 * 12; // 12h — a meeting, not a residence
const DEMO_ID_TTL_MS = 10 * 60 * 1000; // how long we trust the cached demo user id

export function demoEmail() {
  const e = String(process.env.DEMO_EMAIL || "").trim();
  return (e || "demo-workspace@leadmachine.internal").toLowerCase();
}

// id lookup is one query per 10 minutes, not one per request.
let demoIdCache = { email: "", id: null, expires: 0 };

export function rememberDemoUserId(id) {
  demoIdCache = { email: demoEmail(), id: id ? String(id) : null, expires: Date.now() + DEMO_ID_TTL_MS };
}

export function forgetDemoUserId() {
  demoIdCache = { email: "", id: null, expires: 0 };
}

// The demo account's user id, or null when that account doesn't exist yet.
export async function demoUserId() {
  const email = demoEmail();
  const now = Date.now();
  if (demoIdCache.email === email && demoIdCache.expires > now) return demoIdCache.id;
  let id = null;
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.from("profiles").select("id,email").eq("email", email).limit(1);
    if (!error && data && data[0] && data[0].id) id = String(data[0].id);
  } catch {
    id = null; // no Supabase / bad keys → behave as "no demo account"
  }
  demoIdCache = { email, id, expires: now + DEMO_ID_TTL_MS };
  return id;
}

export function writeDemoCookie(req, res) {
  if (res.headersSent) return;
  const bits = [`${DEMO_COOKIE}=1`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${DEMO_COOKIE_MAX_AGE}`];
  if (isSecureRequest(req)) bits.push("Secure");
  appendCookie(res, bits.join("; "));
}

export function clearDemoCookie(req, res) {
  if (res.headersSent) return;
  const bits = [`${DEMO_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (isSecureRequest(req)) bits.push("Secure");
  appendCookie(res, bits.join("; "));
}

// ── admin list ──────────────────────────────────────────────────────────────
// Read from the env on every call so a process-level override always wins.
function isAdminEmail(email) {
  if (!email) return false;
  const list = String(process.env.ADMIN_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email).trim().toLowerCase());
}

// ── verified-token cache ────────────────────────────────────────────────────
const tokenCache = new Map(); // access_token -> { userId, userEmail, isAdmin, expires }

function cacheGet(token) {
  const hit = tokenCache.get(token);
  if (!hit) return null;
  if (hit.expires <= Date.now()) { tokenCache.delete(token); return null; }
  // isAdmin is recomputed: ADMIN_EMAILS can change without a restart.
  return { userId: hit.userId, userEmail: hit.userEmail, isAdmin: isAdminEmail(hit.userEmail) };
}

function cachePut(token, user) {
  if (!token || !user?.userId) return;
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.expires <= now) tokenCache.delete(k);
    if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value);
  }
  tokenCache.set(token, { ...user, expires: Date.now() + TOKEN_TTL_MS });
}

function userFrom(u) {
  if (!u?.id) return null;
  const userEmail = u.email || "";
  return { userId: u.id, userEmail, isAdmin: isAdminEmail(userEmail) };
}

// ── local (offline) access-token verification ───────────────────────────────
// A Supabase access token is a plain HS256 JWT signed with the project's JWT
// secret. When SUPABASE_JWT_SECRET is set we check the signature ourselves, which
// turns the per-request `auth.getUser()` round-trip into a few microseconds of
// HMAC — the difference between a fast page and a cold serverless page.
//
// It is strictly an optimisation: ANY problem (no secret, wrong alg, bad
// signature, expired, malformed) returns null and the caller falls back to the
// network path, so a stale or mistyped secret can never lock a user out.
const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function verifyAccessTokenLocally(token) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret || !token) return null;
  try {
    const [head, body, sig] = String(token).split(".");
    if (!head || !body || !sig) return null;

    const header = JSON.parse(b64urlDecode(head).toString("utf8"));
    if (header?.alg !== "HS256") return null; // never accept "none" or an asymmetric alg here

    const expected = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest();
    const given = b64urlDecode(sig);
    if (given.length !== expected.length) return null; // timingSafeEqual demands equal lengths
    if (!crypto.timingSafeEqual(given, expected)) return null;

    const payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (!payload?.sub) return null;
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;

    return { userId: String(payload.sub), userEmail: payload.email || "" };
  } catch {
    return null;
  }
}

// ── session resolution ──────────────────────────────────────────────────────
// One in-flight refresh per refresh_token, so parallel requests from the same
// browser don't race each other into rotating the token several times over.
const refreshing = new Map();

async function refreshOnce(sb, refresh_token) {
  if (refreshing.has(refresh_token)) return refreshing.get(refresh_token);
  const p = sb.auth.refreshSession({ refresh_token })
    .then((r) => (r?.error ? null : r?.data || null))
    .catch(() => null)
    .finally(() => { setTimeout(() => refreshing.delete(refresh_token), 1000).unref?.(); });
  refreshing.set(refresh_token, p);
  return p;
}

// Returns {userId, userEmail, isAdmin} or null. Re-writes the cookie when the
// session had to be refreshed.
async function resolveSession(req, res) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;

  let session = null;
  try { session = JSON.parse(raw); } catch { return null; }
  const access = session?.access_token || "";
  const refresh = session?.refresh_token || "";
  if (!access && !refresh) return null;

  const cached = access ? cacheGet(access) : null;
  if (cached) return cached;

  // Fast path: verify the signature in-process, before we even build a client.
  if (access) {
    const local = verifyAccessTokenLocally(access);
    if (local) {
      const user = { ...local, isAdmin: isAdminEmail(local.userEmail) };
      cachePut(access, user);
      return user;
    }
  }

  let sb;
  try { sb = await getSupabase(); } catch { return null; }

  if (access) {
    try {
      const { data, error } = await sb.auth.getUser(access);
      const user = error ? null : userFrom(data?.user);
      if (user) { cachePut(access, user); return user; }
    } catch { /* fall through to refresh */ }
  }

  if (!refresh) return null;
  const data = await refreshOnce(sb, refresh);
  const newSession = data?.session;
  const user = userFrom(data?.user || newSession?.user);
  if (!newSession?.access_token || !user) return null;
  if (access) tokenCache.delete(access);
  cachePut(newSession.access_token, user);
  writeSessionCookie(req, res, newSession);
  return user;
}

// ── pages ───────────────────────────────────────────────────────────────────
// Auth-specific styling. Appended AFTER SHARED_CSS so it wins; every colour is a
// shell CSS variable, so both themes are handled for free. The one literal colour
// is the logo chip, which matches `.side .brand` in shell.js (the mark needs a dark
// backing in light mode too).
const AUTH_CSS = `
.authwrap{min-height:100vh;display:flex;justify-content:center;padding:40px 20px;box-sizing:border-box}
/* margin:auto (not align-items:center) so a short viewport scrolls instead of clipping the card. */
.authcard{margin:auto;width:100%;max-width:392px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:32px 30px 28px;box-sizing:border-box}
.authcard .brand{display:inline-flex;align-items:center;background:#10151d;border-radius:9px;padding:9px 12px;margin:0 0 22px}
.authcard .brand img{height:24px;width:auto;display:block}
.authcard h1{font-size:21px;font-weight:800;letter-spacing:.2px;color:var(--text);margin:0 0 6px}
.authcard .sub{font-size:13px;color:var(--muted);line-height:1.55;margin:0 0 22px}
.authcard .err{font-size:13px;color:var(--danger);line-height:1.5;margin:0 0 16px}
.authcard form{display:block;margin:0}
.authcard .field{margin:0 0 16px}
.authcard label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;font-weight:600;color:var(--muted);margin:0 0 7px}
.authcard input{width:100%;box-sizing:border-box;border-radius:9px;padding:11px 13px;font-size:14px;font-family:inherit}
.authcard .hint{font-size:12px;color:var(--faint);margin:7px 0 0}
.authcard .go{width:100%;border-radius:9px;font-weight:700;font-family:inherit;cursor:pointer;margin-top:4px}
.authcard .alt{font-size:13px;color:var(--muted);text-align:center;margin:20px 0 0}
.authcard .alt a{color:var(--accent);font-weight:600;text-decoration:none}
.authcard .alt a:hover{text-decoration:underline}
/* "Continue with Google" — a surface-coloured button so the 4-colour mark reads in
   both themes; the divider below it separates it from the email form. */
.authcard .gbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;
  border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);color:var(--text);
  padding:11px 13px;font-size:14px;font-weight:600;font-family:inherit;text-decoration:none;cursor:pointer}
.authcard .gbtn:hover{background:var(--surface2)}
.authcard .gbtn svg{width:18px;height:18px;flex:none;display:block}
.authcard .orsep{display:flex;align-items:center;gap:12px;margin:18px 0}
.authcard .orsep::before,.authcard .orsep::after{content:"";flex:1;height:1px;background:var(--border)}
.authcard .orsep span{font-size:11px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--faint)}
`;

// Google's 4-colour "G", inline so there is no external request and no build step.
const GOOGLE_G_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">` +
  `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>` +
  `<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>` +
  `<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>` +
  `<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

const GOOGLE_BLOCK = `  <a class="gbtn" href="/auth/google">${GOOGLE_G_SVG}<span>Continue with Google</span></a>
  <div class="orsep"><span>or</span></div>`;

// One template for both pages — `mode` is "login" or "signup".
function authPage({ mode, email = "", error = "" }) {
  const signup = mode === "signup";
  const title = signup ? "Create account" : "Sign in";
  const sub = signup
    ? "Set up an account to start finding and tracking leads."
    : "Enter your email and password to open your dashboard.";
  const action = signup ? "/signup" : "/login";
  const button = signup ? "Create account" : "Sign in";
  const alt = signup
    ? 'Already have an account? <a href="/login">Sign in</a>'
    : 'No account? <a href="/signup">Create one</a>';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Lead Machine</title>
<link rel="icon" href="/mark.png">
${THEME_INIT_SCRIPT}
<style>${SHARED_CSS}${AUTH_CSS}</style>
</head><body>
<div class="authwrap"><div class="authcard">
  <div class="brand"><img src="/logo.png" alt="Avanzta"></div>
  <h1>${title}</h1>
  <p class="sub">${sub}</p>
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
${GOOGLE_BLOCK}
  <form method="post" action="${action}" novalidate>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" spellcheck="false"
             autocapitalize="off" value="${esc(email)}" ${email ? "" : "autofocus"} required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password"
             autocomplete="${signup ? "new-password" : "current-password"}" ${email ? "autofocus" : ""} required>
      ${signup ? `<p class="hint">At least ${MIN_PASSWORD} characters.</p>` : ""}
    </div>
    <button class="go" type="submit">${button}</button>
  </form>
  <p class="alt">${alt}</p>
</div></div>
</body></html>`;
}

function sendPage(res, status, opts) {
  res.status(status).type("html").send(authPage(opts));
}

// ── routes ──────────────────────────────────────────────────────────────────
export const authRouter = express.Router();

// Body parsers are per-route: authRouter is mounted app-wide, so a router-level
// .use() would parse bodies for every request in the app.
const formBody = [express.urlencoded({ extended: false }), express.json()];

const readField = (body, key) => String(body?.[key] ?? "").trim();
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const ERR_GENERIC = "Something went wrong. Try again.";
const ERR_UNAVAILABLE = "Sign-in is not available right now. Check the Supabase configuration.";
const ERR_CREDENTIALS = "That email and password do not match.";

// GET /login — redirect away in sqlite mode (dev is login-free) and for users
// who already hold a valid session.
authRouter.get("/login", async (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  const user = await resolveSession(req, res).catch(() => null);
  if (user) return res.redirect("/");
  sendPage(res, 200, { mode: "login" });
});

authRouter.get("/signup", async (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  const user = await resolveSession(req, res).catch(() => null);
  if (user) return res.redirect("/");
  sendPage(res, 200, { mode: "signup" });
});

authRouter.post("/login", formBody, async (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  const email = readField(req.body, "email");
  const password = String(req.body?.password ?? "");
  if (!email || !password) {
    return sendPage(res, 400, { mode: "login", email, error: "Enter your email and password." });
  }

  let sb;
  try { sb = await getSupabase(); }
  catch { return sendPage(res, 503, { mode: "login", email, error: ERR_UNAVAILABLE }); }

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data?.session) {
      return sendPage(res, 401, { mode: "login", email, error: ERR_CREDENTIALS });
    }
    writeSessionCookie(req, res, data.session);
    const user = userFrom(data.user || data.session.user);
    if (user) cachePut(data.session.access_token, user);
    return res.redirect("/");
  } catch {
    return sendPage(res, 500, { mode: "login", email, error: ERR_GENERIC });
  }
});

// Does this Supabase error mean "that email is already taken"?
function isEmailTaken(error) {
  if (!error) return false;
  const code = String(error.code || "").toLowerCase();
  const msg = String(error.message || "").toLowerCase();
  return code === "email_exists" || code === "user_already_exists" ||
    (msg.includes("already") && (msg.includes("registered") || msg.includes("exists")));
}

// POST /signup — creates the user server-side with email_confirm:true (no SMTP
// needed), then signs them in. The profiles row is created by a DB trigger.
authRouter.post("/signup", formBody, async (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  const email = readField(req.body, "email");
  const password = String(req.body?.password ?? "");
  const fail = (status, error) => sendPage(res, status, { mode: "signup", email, error });

  if (!email || !password) return fail(400, "Enter an email address and a password.");
  if (!looksLikeEmail(email)) return fail(400, "Enter a valid email address.");
  if (password.length < MIN_PASSWORD) {
    return fail(400, `Use a password with at least ${MIN_PASSWORD} characters.`);
  }

  let sb;
  try { sb = await getSupabase(); } catch { return fail(503, ERR_UNAVAILABLE); }

  try {
    const { error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) {
      if (isEmailTaken(error)) {
        return fail(409, "That email already has an account. Sign in instead.");
      }
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("password")) {
        return fail(400, `Use a password with at least ${MIN_PASSWORD} characters.`);
      }
      if (msg.includes("email")) return fail(400, "Enter a valid email address.");
      return fail(400, ERR_GENERIC);
    }

    const { data, error: signInError } = await sb.auth.signInWithPassword({ email, password });
    if (signInError || !data?.session) {
      // Account exists but the sign-in leg failed — send them to the login page.
      return sendPage(res, 200, {
        mode: "login", email, error: "Your account is ready. Sign in to continue.",
      });
    }
    writeSessionCookie(req, res, data.session);
    const user = userFrom(data.user || data.session.user);
    if (user) cachePut(data.session.access_token, user);
    return res.redirect("/");
  } catch {
    return fail(500, ERR_GENERIC);
  }
});

// ── Google sign-in (hosted Supabase OAuth, implicit flow) ───────────────────
// The three legs:
//   GET  /auth/google   → bounce to Supabase's authorize endpoint
//   GET  /auth/callback → Supabase lands here with the session in the URL *fragment*
//                         (never sent to a server), so a tiny inline script reads it…
//   POST /auth/session  → …and hands it to us same-origin. We re-verify the access
//                         token with getUser() and only then write the httpOnly cookie.
// New Google users get their trial profile from the same DB trigger as email signups.

const ERR_GOOGLE = "Google sign-in did not complete. Try again.";

// The handoff page. No external scripts; error text is set with textContent, never HTML.
function callbackPage() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Signing you in · Lead Machine</title>
<link rel="icon" href="/mark.png">
${THEME_INIT_SCRIPT}
<style>${SHARED_CSS}${AUTH_CSS}</style>
</head><body>
<div class="authwrap"><div class="authcard">
  <div class="brand"><img src="/logo.png" alt="Avanzta"></div>
  <h1 id="hd">Signing you in…</h1>
  <p class="sub" id="sb">Finishing your Google sign-in. This only takes a moment.</p>
  <p class="err" role="alert" id="er" hidden></p>
  <p class="alt" id="bk" hidden><a href="/login">Back to sign in</a></p>
  <noscript><p class="err">JavaScript is required to finish signing in.</p>
  <p class="alt"><a href="/login">Back to sign in</a></p></noscript>
</div></div>
<script>
(function(){
  var FALLBACK = ${JSON.stringify(ERR_GOOGLE)};
  function fail(msg){
    var hd=document.getElementById('hd'), sb=document.getElementById('sb'),
        er=document.getElementById('er'), bk=document.getElementById('bk');
    hd.textContent='Could not sign you in';
    sb.hidden=true;
    er.textContent=(msg&&String(msg).trim())?String(msg).trim():FALLBACK;
    er.hidden=false; bk.hidden=false;
  }
  try{
    var hp=new URLSearchParams((location.hash||'').replace(/^#/,''));
    var qp=new URLSearchParams(location.search||'');
    var err=qp.get('error_description')||qp.get('error')||hp.get('error_description')||hp.get('error');
    if(err){ fail(err); return; }
    var at=hp.get('access_token')||'';
    var rt=hp.get('refresh_token')||'';
    if(!at){ fail(''); return; }
    fetch('/auth/session',{
      method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({access_token:at,refresh_token:rt})
    }).then(function(r){
        return r.json().catch(function(){ return {}; })
                .then(function(j){ return {status:r.status, body:j}; });
      })
      .then(function(x){
        if(x.body&&x.body.ok){
          try{ history.replaceState(null,'',location.pathname); }catch(e){}
          location.replace('/');
          return;
        }
        // A 401 only means the token didn't check out — the API's terse
        // "Sign in required" would read oddly here, so use our own wording.
        // Anything else (e.g. a 503 config problem) is worth showing verbatim.
        fail(x.status===401 ? '' : (x.body&&x.body.error));
      }).catch(function(){ fail(''); });
  }catch(e){ fail(''); }
})();
</script>
</body></html>`;
}

// GET /auth/google — hand off to Supabase's hosted Google flow.
authRouter.get("/auth/google", (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  const base = String(supabaseUrl() || "").replace(/\/+$/, "");
  if (!base) return sendPage(res, 503, { mode: "login", error: ERR_UNAVAILABLE });
  const redirectTo = `${originOf(req)}/auth/callback`;
  return res.redirect(
    302,
    `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`
  );
});

// GET /auth/callback — the fragment lands in the browser; the page above forwards it.
authRouter.get("/auth/callback", (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  res.status(200).type("html").send(callbackPage());
});

// POST /auth/session — never trust the posted tokens: verify server-side first.
authRouter.post("/auth/session", express.json(), async (req, res) => {
  if (!supabaseMode()) return res.redirect("/");
  const deny = () => res.status(401).json({ ok: false, error: "Sign in required" });

  const access_token = String(req.body?.access_token ?? "").trim();
  const refresh_token = String(req.body?.refresh_token ?? "").trim();
  if (!access_token) return deny();

  let sb;
  try { sb = await getSupabase(); }
  catch { return res.status(503).json({ ok: false, error: ERR_UNAVAILABLE }); }

  try {
    const { data, error } = await sb.auth.getUser(access_token);
    const user = error ? null : userFrom(data?.user);
    if (!user) return deny();
    writeSessionCookie(req, res, { access_token, refresh_token });
    cachePut(access_token, user);
    return res.json({ ok: true });
  } catch {
    // Network/config failure — still a clean JSON answer, never a crash.
    return deny();
  }
});

async function logout(req, res) {
  if (!supabaseMode()) return res.redirect("/");
  const raw = readCookie(req, COOKIE);
  let access = "";
  if (raw) { try { access = JSON.parse(raw)?.access_token || ""; } catch { /* ignore */ } }
  if (access) {
    tokenCache.delete(access);
    // Best effort: revoke this session's refresh token server-side too. Scope
    // "local" so signing out in one browser doesn't sign the user out everywhere.
    try { const sb = await getSupabase(); await sb.auth.admin.signOut(access, "local"); } catch { /* ignore */ }
  }
  clearSessionCookie(req, res);
  return res.redirect("/login");
}

authRouter.post("/logout", logout);
authRouter.get("/logout", logout);

// ── middleware ──────────────────────────────────────────────────────────────
function denyUnauthenticated(req, res) {
  if (wantsJson(req)) return res.status(401).json({ ok: false, error: "Sign in required" });
  return res.redirect(302, "/login");
}

export function requireUser(req, res, next) {
  // Local dev stays single-user and login-free.
  if (!supabaseMode()) {
    req.userId = "local";
    req.userEmail = "local@dev";
    req.isAdmin = true;
    req.realUserId = "local";
    req.isDemo = false;
    return next();
  }

  const pathname = pathOf(req);
  resolveSession(req, res).then(
    (user) => {
      if (!user) return isPublicPath(pathname) ? next() : denyUnauthenticated(req, res);

      req.userId = user.userId;
      req.userEmail = user.userEmail;
      req.isAdmin = user.isAdmin;
      req.realUserId = user.userId;
      req.isDemo = false;

      // Demo workspace: an admin carrying the lm_demo cookie reads and writes the
      // demo account's data instead of their own. isAdmin stays true so they can
      // still reach /demo and exit. Anyone else's cookie is simply ignored.
      if (!user.isAdmin || readCookie(req, DEMO_COOKIE) !== "1") return next();
      return demoUserId().then(
        (demoId) => {
          if (demoId) {
            req.userId = demoId;
            req.isDemo = true;
          }
          next();
        },
        () => next() // lookup failed → carry on as the real user, never a dead page
      );
    },
    () => (isPublicPath(pathname) ? next() : denyUnauthenticated(req, res))
  );
}

export function requireAdmin(req, res, next) {
  if (req.isAdmin) return next();
  if (wantsJson(req)) return res.status(403).json({ ok: false, error: "Admins only" });
  return res.status(403).type("html").send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admins only · Lead Machine</title>${THEME_INIT_SCRIPT}
<style>${SHARED_CSS}${AUTH_CSS}</style></head><body>
<div class="authwrap"><div class="authcard">
  <div class="brand"><img src="/logo.png" alt="Avanzta"></div>
  <h1>Admins only</h1>
  <p class="sub">This account does not have access to the admin area.</p>
  <p class="alt"><a href="/">Back to search</a></p>
</div></div></body></html>`);
}
