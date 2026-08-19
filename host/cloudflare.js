// cloudflare.js — publishes the data/previews folder to Cloudflare Pages so every
// preview has a public link (e.g. https://lead-machine-previews.pages.dev/123.html).
//
// One Pages project holds all previews; we redeploy the folder after each scrape run.
// Needs in .env:  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_PAGES_PROJECT

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREVIEWS_DIR = join(__dirname, "..", "data", "previews");
const WRANGLER = join(__dirname, "..", "node_modules", ".bin", "wrangler");

const PROJECT = process.env.CF_PAGES_PROJECT || "lead-machine-previews";

export function cloudflareConfigured() {
  return !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
}

export function pagesBaseUrl() {
  return `https://${PROJECT}.pages.dev`;
}

function run(args) {
  return execFileSync(WRANGLER, args, {
    env: process.env, // wrangler reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from here
    stdio: "pipe",
    encoding: "utf8",
  });
}

function ensureProject() {
  try {
    run(["pages", "project", "create", PROJECT, "--production-branch=main"]);
    console.log(`[cf] created Pages project "${PROJECT}"`);
  } catch (e) {
    // Already exists → fine. Anything else, surface it.
    const msg = (e.stderr || e.stdout || e.message || "").toString();
    if (!/already exists|already in use/i.test(msg)) {
      // not fatal for create; deploy will reveal real problems
      if (msg.trim()) console.log(`[cf] project create note: ${msg.trim().split("\n")[0]}`);
    }
  }
}

/** Deploy all previews. Returns the public base URL. */
export function deployPreviews() {
  if (!cloudflareConfigured()) {
    throw new Error(
      "Cloudflare not configured — set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env (see SETUP.md)."
    );
  }
  if (!existsSync(PREVIEWS_DIR)) throw new Error("No previews to deploy yet.");

  ensureProject();
  console.log(`[cf] deploying previews → ${pagesBaseUrl()} …`);
  const out = run([
    "pages",
    "deploy",
    PREVIEWS_DIR,
    `--project-name=${PROJECT}`,
    "--branch=main",
    "--commit-dirty=true",
  ]);
  const line = out.split("\n").find((l) => l.includes(".pages.dev")) || "";
  console.log(`[cf] ✅ deployed. ${line.trim()}`);
  console.log(`[cf] previews live at ${pagesBaseUrl()}/<id>.html`);
  return pagesBaseUrl();
}

// ── Debounced background deploy ──
// Building many previews fires many requests; redeploying the whole folder on each one is slow
// and wasteful. Coalesce a burst of builds into a SINGLE deploy a few seconds after the last one.
// The preview's public URL is deterministic, so callers can return it immediately and let this
// publish in the background.
let _timer = null;
let _pending = false;
let _running = false;

export function scheduleDeploy(delayMs = 8000) {
  if (!cloudflareConfigured()) return;
  _pending = true;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_fire, delayMs);
}

function _fire() {
  _timer = null;
  if (_running) { _pending = true; return; } // a deploy is mid-flight → re-arm after it finishes
  _running = true;
  _pending = false;
  try {
    deployPreviews();
  } catch (e) {
    console.log(`[cf] background deploy failed: ${e.message}`);
  } finally {
    _running = false;
    if (_pending) scheduleDeploy(2000); // builds arrived during the deploy → deploy once more
  }
}

// CLI: `npm run deploy`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    deployPreviews();
  } catch (e) {
    console.error("Deploy failed:", e.message);
    process.exit(1);
  }
}
