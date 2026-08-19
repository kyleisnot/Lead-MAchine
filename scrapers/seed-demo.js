// seed-demo.js — inserts ONE fake lead and builds its preview, so you can test the
// dashboard without using any Apify/Gmail credits. Run: node scrapers/seed-demo.js

import { insertLead, listLeads, attachPreview } from "../data/db.js";
import { mapLeadToSiteData } from "../builder/mapper.js";
import { savePreview, closeBuilder } from "../builder/builder.js";
import { draftEmail } from "../mailer/draft.js";
import { publicPreviewUrl } from "../lib/publicUrl.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const demo = {
  source: "demo",
  externalId: "demo-joes-pizza",
  name: "Joe's Pizza",
  category: "Pizzeria",
  city: "Knoxville",
  state: "TN",
  phone: "(865) 555-0199",
  email: "kylecantrell65@gmail.com", // sends to yourself when you test SEND
  website: "", // no website → qualifies
  about: "Hand-tossed, wood-fired pizza made fresh daily by a family that loves what they do. Serving Knoxville for 15 years.",
  images: [],
  fbUrl: "#",
  igUrl: "#",
  serviceAreas: ["Knoxville", "Maryville", "Farragut"],
};

insertLead(demo);
const row = listLeads().find((r) => r.external_id === demo.externalId);
const siteData = mapLeadToSiteData(demo);
const previewPath = join(__dirname, "..", "data", "previews", `${row.id}.html`);

savePreview(siteData, previewPath)
  .then(async () => {
    const { subject, body } = draftEmail(demo, publicPreviewUrl(row.id));
    attachPreview(row.id, { siteData, previewPath, emailSubject: subject, emailBody: body });
    await closeBuilder();
    console.log(`✅ Demo lead #${row.id} ready. Run:  npm run dashboard`);
  })
  .catch(async (e) => {
    console.error(e);
    await closeBuilder();
    process.exit(1);
  });
