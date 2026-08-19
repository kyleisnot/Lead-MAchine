# Lead Machine — Setup

A pipeline that finds businesses **without a website**, auto-builds a **Site Flash** preview for
each one, drafts a cold email, and lets **you** review + approve every send.

```
scrape (Apify) → filter (no website) → build preview (Site Flash) → draft email
      → YOU review in dashboard → click SEND → emails from your Gmail → logged
```

---

## 1. Install (already done if you got this far)

```bash
cd ~/Desktop/lead-machine
npm install --cache /tmp/npm-cache-lm     # clean cache avoids a permissions bug
npx playwright install chromium
```

## 2. Add your keys

```bash
cp .env.example .env
```

Open `.env` and fill in:
- **APIFY_TOKEN** — from https://console.apify.com/account/integrations
- **SENDER_EMAIL** — the Gmail you'll send from

## 3. Authorize Gmail (one time, free)

1. Go to https://console.cloud.google.com/ → create a project (any name).
2. **APIs & Services → Library →** search "Gmail API" → **Enable**.
3. **APIs & Services → OAuth consent screen →** External → fill app name + your email →
   add yourself as a **Test user** (your Gmail).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID →**
   Application type = **Desktop app**.
5. Click **Download JSON**, save it as:  `secrets/credentials.json`
6. Run:
   ```bash
   npm run auth
   ```
   Your browser opens → approve → done. (Creates `secrets/token.json`.)

> Free. Limit ~500 emails/day on a normal Gmail.

## 4. Set up Cloudflare Pages (free preview hosting)

So recipients can open the preview link, previews auto-publish to Cloudflare Pages (free, permanent links).

1. Make a free account at https://dash.cloudflare.com/ (no card needed).
2. **My Profile → API Tokens → Create Token →** use the **"Cloudflare Pages: Edit"** template → Create → copy the token.
3. Find your **Account ID**: dashboard → **Workers & Pages** → right sidebar "Account ID".
4. Put both in `.env`:
   ```
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   ```
5. That's it. Previews publish automatically at the end of each scrape run, and the
   email links point to `https://lead-machine-previews.pages.dev/<id>.html`.
   (To publish manually anytime: `npm run deploy`.)

## 5. Run it

```bash
# Try it with zero credits first — seeds a fake lead:
node scrapers/seed-demo.js
npm run dashboard          # → http://localhost:4000

# Real scrape:
node scrapers/run.js --category "barber shops" --city "Knoxville" --state "TN" --limit 40
npm run dashboard
```

In the dashboard: review each preview, edit the email if you want, hit **SEND** (or **Skip**).
Nothing emails until you click SEND.

---

## ⚠️ One thing to decide: where previews are hosted

Right now the email links to `http://localhost:4000/preview/123`. **That works for YOU**, but a
recipient can't open localhost. Before doing real outreach, pick how previews go public:

- **Cloudflare Tunnel / ngrok** — quickest; exposes your localhost at a public URL.
- **Netlify / Cloudflare Pages / S3** — upload each preview html, get a stable public link.
- **Your own domain** — host previews at e.g. `preview.yoursite.com/joes-pizza`.

Tell Claude which you want and it'll wire it in (set `PUBLIC_BASE_URL` in `.env`).

---

## Project map

| File | Job |
|---|---|
| `scrapers/maps.js` | Google Maps scrape via Apify |
| `scrapers/normalize.js` | raw Apify data → standard "lead" shape |
| `scrapers/filter.js` | "no real website?" qualifier |
| `scrapers/run.js` | the whole pipeline (scrape→filter→build→draft→store) |
| `builder/builder.js` | drives your Site Flash html headlessly → finished preview |
| `builder/mapper.js` | lead → Site Flash fields |
| `builder/siteflash.html` | **your builder** (copy of siteflash-v10) |
| `data/db.js` | SQLite: dedup + status tracking |
| `dashboard/server.js` | review + approve + send UI |
| `mailer/mailer.js` + `auth.js` | Gmail send + one-time auth |
| `mailer/draft.js` | the cold-email template |

## Phases
- **Phase 1 (done):** Google Maps → filter → build → dashboard → Gmail send.
- **Phase 2:** add Facebook + Instagram scrapers (more photos + emails).
- **Phase 3:** follow-ups, cross-run dedup polish, CAN-SPAM unsubscribe footer.
