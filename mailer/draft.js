// draft.js — generates the cold-outreach email draft for a lead.
// You review/edit every draft in the dashboard before it sends, so this is just a strong starting point.
//
// The footer includes a clear opt-out + a physical mailing address, which US commercial email
// (CAN-SPAM) requires. Set these in .env: SENDER_NAME, SENDER_BUSINESS, SENDER_ADDRESS.
import "dotenv/config";

const SENDER_NAME = process.env.SENDER_NAME || "Kyle";
const SENDER_BUSINESS = process.env.SENDER_BUSINESS || "Avanzta Contractor Marketing Group";
const SENDER_ADDRESS = process.env.SENDER_ADDRESS || ""; // e.g. "123 Main St, Knoxville, TN 37902"

export function draftEmail(lead, previewUrl) {
  const first = (lead.city ? `in ${lead.city}` : "in your area").trim();
  const biz = lead.name || "your business";

  const subject = `Quick website mockup I made for ${biz}`;

  // CAN-SPAM footer: honest reason for contact, a clear opt-out, sender identity + address.
  const footer = [
    "—",
    `You're getting this because I came across ${biz} ${first} while looking up local businesses. ` +
      `If you'd rather not hear from me, just reply "unsubscribe" and I won't reach out again.`,
    [SENDER_BUSINESS, SENDER_ADDRESS].filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n");

  const body = `Hi ${biz} team,

I came across ${biz} ${first} and noticed you don't have a website yet (or it's hard to find online). A lot of your potential customers search Google before they call — and right now they may be landing on competitors instead.

So I went ahead and built you a free preview of what a modern website for ${biz} could look like:

${previewUrl}

No strings attached — if you like it, I can have it live for you quickly. If not, no worries at all.

Either way, I hope it's useful!

Best,
${SENDER_NAME}

${footer}`;

  return { subject, body };
}
