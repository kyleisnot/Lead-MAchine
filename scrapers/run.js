// run.js — CLI front-end for the SAME engine the dashboard uses (lib/pipeline.js).
// Finds in-niche, no-website, recently-active leads and stores them. Previews are built
// on demand in the dashboard, so this just fills the pipeline.
//
// Usage:
//   node scrapers/run.js --city "Knoxville" --state "TN" --all-niches              (every target trade)
//   node scrapers/run.js --niche roofing --city "Knoxville" --state "TN"           (one trade)
//   node scrapers/run.js --niche fencing --city "Knoxville, Maryville" --state TN  (several cities)
//   node scrapers/run.js -c "fence contractor" -l "Maryville, TN" --limit 60       (custom phrase)
//   flags: --limit N (depth per source) · --sources google,facebook,instagram · --fresh (ignore cache)

import { discoverMany } from "../lib/pipeline.js";
import { NICHES } from "../lib/niches.js";
import { freshnessConfig, cutoffLabel } from "../lib/freshness.js";
import { spendCapState } from "../lib/spend.js";
import "dotenv/config";

const PORT = process.env.PORT || 4000;

function parseArgs(argv) {
  const a = { limit: 40, allNiches: false, sources: ["google", "facebook"], forceRefresh: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--category" || k === "-c") (a.category = v), i++;
    else if (k === "--niche") (a.niche = v), i++;
    else if (k === "--all-niches") a.allNiches = true;
    else if (k === "--city") (a.city = v), i++;
    else if (k === "--state") (a.state = v), i++;
    else if (k === "--location" || k === "-l") {
      const [city, state] = (v || "").split(",").map((s) => s.trim());
      a.city = city;
      a.state = state;
      i++;
    } else if (k === "--limit") (a.limit = parseInt(v, 10)), i++;
    else if (k === "--sources") (a.sources = v.split(",").map((s) => s.trim()).filter(Boolean)), i++;
    else if (k === "--fresh") a.forceRefresh = true;
  }
  return a;
}

// "Knoxville, Maryville" → ["Knoxville","Maryville"]
function splitCities(str = "") {
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

// Decide which niche KEYS to scan. (discoverMany takes niche keys/phrases.)
function resolveNiches(args) {
  if (args.allNiches) return NICHES.map((n) => n.key);
  if (args.niche) {
    const n = NICHES.find((x) => x.key === args.niche.toLowerCase());
    if (!n) {
      console.error(`Unknown niche "${args.niche}". Valid: ${NICHES.map((x) => x.key).join(", ")}`);
      process.exit(1);
    }
    return [n.key];
  }
  if (args.category) return [args.category]; // custom phrase passes straight through
  return [];
}

async function main() {
  const args = parseArgs(process.argv);
  const niches = resolveNiches(args);
  const cities = splitCities(args.city || "");
  if (!cities.length || niches.length === 0) {
    console.error(
      'Usage:\n' +
        '  node scrapers/run.js --city "Knoxville" --state "TN" --all-niches\n' +
        '  node scrapers/run.js --niche roofing --city "Knoxville" --state "TN"\n' +
        '  node scrapers/run.js -c "fence contractor" -l "Maryville, TN" --limit 60\n\n' +
        `Target niches: ${NICHES.map((n) => n.key).join(", ")}`
    );
    process.exit(1);
  }

  // Respect the same monthly Apify spend cap as the dashboard.
  const cap = await spendCapState();
  if (cap.blocked) {
    console.error(`\n⛔ Spend cap reached: $${cap.spent.toFixed(2)} / $${cap.cap.toFixed(0)} of Apify this month.`);
    console.error(`   Raise APIFY_MONTHLY_CAP in .env to keep scanning.\n`);
    process.exit(1);
  }

  const fc = freshnessConfig();
  console.log(`\n🔎 Scanning ${niches.length} niche(s) × ${cities.length} city(ies) · depth ${args.limit} · sources ${args.sources.join("+")}`);
  if (fc.enabled) console.log(`🟢 Keeping only leads active since ${cutoffLabel()} (${fc.mode} mode).`);

  const { prospects, stats } = await discoverMany({
    niches,
    cities,
    state: args.state,
    sources: args.sources,
    limit: args.limit,
    forceRefresh: args.forceRefresh,
    onProgress: (done, total, label) => {
      if (label !== "done") console.log(`  · [${done + 1}/${total}] ${label}…`);
    },
  });

  console.log(`\n📊 Scanned ${stats.scanned} businesses across ${stats.runs} run(s).`);
  console.log(`🎯 ${prospects.length} qualify (in-niche + no website + active).`);
  console.log(`   dropped ${stats.hasWebsite} with a website, ${stats.offNiche} off-niche.`);
  if (stats.staleSeen || stats.unknownSeen) {
    console.log(`   freshness: hid ${stats.staleSeen} too old, ${stats.unknownSeen} undated.`);
  }
  console.log(`   sources: ${stats.bySource.google} Google · ${stats.bySource.facebook} FB · ${stats.bySource.instagram} IG`);

  if (prospects.length === 0) {
    console.log("\nNo qualified leads this run. Try a higher --limit, more cities, or --all-niches.\n");
    return;
  }

  console.log(`\n🎉 Done. Qualified leads are saved. Open the dashboard to review & build previews:`);
  console.log(`   npm run dashboard   →   http://localhost:${PORT}\n`);
}

main().catch((e) => {
  console.error("Pipeline error:", e.message);
  process.exit(1);
});
