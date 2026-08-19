// publicUrl.js — the URL a recipient will open for a preview.
// If PUBLIC_BASE_URL is set (your Cloudflare Pages domain), links point there.
// Otherwise falls back to localhost (fine for your own review, not for recipients).

import "dotenv/config";

export function publicPreviewUrl(id) {
  // Cloudflare Pages serves "123.html" at the clean URL "/123" (and 308-redirects
  // the .html form to it), so we link the clean form directly — no redirect hop.
  const base = process.env.PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${id}`;
  const port = process.env.PORT || 4000;
  return `http://localhost:${port}/preview/${id}`;
}
