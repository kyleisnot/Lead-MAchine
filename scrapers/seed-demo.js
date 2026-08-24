// seed-demo.js — inserts ONE fake lead so you can click around the dashboard (Search
// restore, CRM, Brain) without spending any Apify credits. Local/SQLite only: it writes
// as the single "local" user. Run: node scrapers/seed-demo.js

import * as store from "../data/store.js";
import { dataProvider } from "../lib/supabase.js";

const USER = "local";

const demo = {
  source: "demo",
  externalId: "demo-joes-pizza",
  name: "Joe's Pizza",
  category: "Pizzeria",
  city: "Knoxville",
  state: "TN",
  phone: "(865) 555-0199",
  email: "kylecantrell65@gmail.com",
  website: "", // no website → qualifies
  about: "Hand-tossed, wood-fired pizza made fresh daily by a family that loves what they do. Serving Knoxville for 15 years.",
  images: [],
  fbUrl: "#",
  igUrl: "#",
  serviceAreas: ["Knoxville", "Maryville", "Farragut"],
};

if (dataProvider() === "supabase") {
  console.error("seed-demo is for local sqlite mode. Set DATA_PROVIDER=sqlite to use it.");
  process.exit(1);
}

const id = await store.upsertLeadReturningId(USER, demo);
// Also remember it in the brain, so the Brain page isn't empty on a fresh install.
await store.recordChecked(USER, [
  {
    source: demo.source,
    external_id: demo.externalId,
    name: demo.name,
    has_website: 0,
    niche: "pizzeria",
    city: demo.city,
    state: demo.state,
  },
]);

console.log(`✅ Demo lead #${id} ready. Run:  npm run dashboard`);
