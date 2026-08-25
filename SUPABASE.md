# Connecting Supabase (multi-user)

Lead Machine runs two ways:

| Mode | `DATA_PROVIDER` | Data | Users |
|---|---|---|---|
| **Local** (today) | `sqlite` | `data/leads.db` file | one |
| **Hosted** | `supabase` | Supabase Postgres | many, each isolated |

The schema, per-user security, and provider switch are already in the codebase. Turning
on multi-user = creating a Supabase project and flipping a few env values.

## Connect a Supabase project

1. **Create the project** at https://supabase.com (free tier is fine to start).
2. **Load the schema:** open **SQL Editor**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates every table with `user_id`, row-level security (so users only ever see their own leads), and a `profiles` table holding each user's tier + monthly token allotment.
3. **Get your keys:** Project Settings → API. Copy the **Project URL**, the **anon** key, and the **service_role** key.
4. **Set env** in `.env`:
   ```
   DATA_PROVIDER=supabase
   SUPABASE_URL=https://<your-project>.supabase.co
   SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   ```
5. **Install the client:**
   ```
   npm install @supabase/supabase-js
   ```
6. Restart. The app now reads/writes Supabase, and every user only sees their own data.

> ⚠️ The `service_role` key bypasses row-level security — it must stay server-side only, never in any HTML/JS sent to the browser.

## What's built (all wired and verified)

- **Schema + RLS** (`supabase/schema.sql`), the `profiles`/tier/allotment model, and the `DATA_PROVIDER` switch.
- **Auth** (`dashboard/auth.js`): signup/login/logout, httpOnly session cookie with silent refresh; signup auto-creates a trial profile (500 tokens) via the DB trigger; `ADMIN_EMAILS` grants the admin role.
- **User-scoped data layer** (`data/store.js`): every read/write takes a userId; sqlite provider for local dev, supabase provider for production (verified isolated per user, over HTTP and at the store level).
- **Per-user token metering**: searches log estimated cost against the user; `/api/usage` reports their tokens vs. their profile's allotment; searches soft-block when spent.
- **Admin panel** (`/admin`): all users with usage/leads/tier, inline tier + allotment editing, operator Apify spend.

Local dev stays login-free: `DATA_PROVIDER=sqlite npm run dashboard`.

## Google sign-in setup

The "Continue with Google" button on `/login` and `/signup` uses Supabase's hosted OAuth.
Three places have to line up — Google, the Supabase provider, and Supabase's redirect allow-list.

1. **Google Cloud OAuth client.** In the [Google Cloud console](https://console.cloud.google.com/apis/credentials) → **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type **Web application**. Add this **Authorized redirect URI** (Supabase's endpoint, not the app's):
   ```
   https://rhlecrahjwxfqewpzecp.supabase.co/auth/v1/callback
   ```
   Fill in the OAuth consent screen if prompted, then copy the **Client ID** and **Client secret**.
2. **Enable the provider in Supabase.** Dashboard → **Authentication → Providers → Google** → toggle on, paste the client ID and secret, save.
3. **Allow the app's callback URLs.** Dashboard → **Authentication → URL Configuration → Redirect URLs**, add both:
   ```
   https://lead-machine-app-ts-advisors.vercel.app/auth/callback
   http://localhost:4000/auth/callback
   ```
   Supabase refuses any `redirect_to` that isn't on this list, so a missing entry is the usual cause of a failed sign-in.

No extra env vars are needed — the app builds the authorize URL from `SUPABASE_URL`. First-time Google
users get the same trial profile as email signups (created by the DB trigger).

**How it flows:** `/auth/google` → Supabase authorize → Google → Supabase → `/auth/callback`, which
receives the session in the URL *fragment* and POSTs it to `/auth/session`. That route re-verifies the
access token with `auth.getUser()` before writing the usual `lm_session` httpOnly cookie — the tokens
are never trusted just because they were posted.

## Demo workspace

For client meetings, `/demo` carries two panels that drop the operator into the *real* app signed in as
another account. Supabase mode only (SQLite is single-user, so there is no second account to present as;
every route below degrades to the same friendly notice there).

- **Practice demo — staged data.** A dedicated account preloaded with a believable pipeline, reset to
  identical state before every meeting. Rehearsal.
- **Live demo for a prospect.** The prospect's *own real account*, created on the spot. Every search run
  in the meeting saves real leads into it, and the operator hands over a sign-in link at the end.

| Route | Does |
|---|---|
| `POST /demo/enter` | Creates the demo account if it's missing, seeds it if it's empty, sets the `lm_demo` cookie, redirects to `/` |
| `POST /demo/prospect` | Form field `email`: finds-or-creates *that* account, sets `lm_demo` to its uuid, redirects to `/` |
| `POST /demo/exit` | Clears the cookie |
| `POST /demo/api/reset` | Deletes every staged demo row and lays the seed down again → `{ok, seeded:{…}}` (or `{ok:false, step, error}`) |
| `POST /demo/api/claim-link` | Prospect demos only → `{ok, link, email}`: a sign-in link for the account being presented |

- **The account.** `DEMO_EMAIL` (default `demo-workspace@leadmachine.internal`), created server-side with
  a random 32-char password that is thrown away — it is only ever reached by impersonation, never by
  signing in. Its profile is set to `starter` / 2,500 tokens. Reset never deletes the auth user or its
  profile row, only its data.
- **Impersonation.** `lm_demo` is a marker cookie with no authority of its own: `requireUser` swaps
  `req.userId` to the target account **only** for an already-authenticated admin (`ADMIN_EMAILS`), and only
  once that account exists. The value is either `1` (the staged demo account) or a **uuid** (a prospect's
  account); anything else is ignored, as is a uuid with no `profiles` row and — deliberately — any uuid
  whose `profiles.email` is on `ADMIN_EMAILS`, so a typo can never put an operator inside a colleague's
  dashboard. Verified uuids are cached ~5 minutes. Non-admins holding the cookie are unaffected,
  `req.realUserId` keeps the real admin's id, and `req.isDemo` marks the request as impersonated.
- **The seed** (deterministic; only dates are relative): 36 no-website leads across Knoxville /
  Chattanooga / Nashville TN in landscaping, roofing and pressure washing · 12 saved into the CRM across
  all five stages · 3 manual follow-ups (one overdue, one due today, one in 3 days) · 14 metered searches
  totalling $12.40 (1,240 of 2,500 tokens) · 3 cached searches keyed exactly as `lib/pipeline.js` keys
  them, so the saved-demo chips replay for free · a `last_search` app_state row, so the Search page shows
  restored results the instant the operator lands · 120 remembered businesses (36 no site, 84 with one).
- **Adding to it.** The seed lives in `dashboard/demo.js` (`DEMO_BUSINESSES`, `SAVED_PLAN`, `FOLLOWUPS`,
  `USAGE_COSTS`). Keep it free of `Math.random`/`Date.now` for identity — same data every reset is the
  point.

### Prospect demos

The pitch is "the leads we just found are already in your account". The operator types the prospect's
email into the **Live demo for a prospect** card and presents from inside that person's real dashboard.

1. **`POST /demo/prospect`** validates the address and refuses two of them outright: anything on
   `ADMIN_EMAILS` (a typo would otherwise hand the operator a live session in a colleague's account) and
   `DEMO_EMAIL` (that's the Practice demo). Then it finds-or-creates the account — `profiles`-by-email
   first, else `auth.admin.createUser` with a random 32-char password and `email_confirm: true`, adopting
   an existing auth user if the email is already taken — waits for the signup trigger to write the
   profile, and points `lm_demo` at the new uuid.
2. **Nothing is seeded.** The account starts empty on the trigger's defaults (`trial` / 500 tokens); the
   searches run live in the meeting are the data. Live scans therefore need `APIFY_TOKEN` — without it
   the search page shows its usual "needs an Apify key" notice, so rehearse on the Practice demo.
3. **`POST /demo/api/claim-link`** (the "Get their sign-in link" button) calls
   `auth.admin.generateLink({type:"recovery"})` with `redirectTo` = this request's origin + `/auth/callback`,
   and returns `properties.action_link`. That is the same fragment handoff Google sign-in uses, so one
   click puts the prospect in their own dashboard with the meeting's leads already there. It is refused
   unless the request is actually impersonating a prospect — the staged account never mints one, because
   that link would be a standing credential for the rehearsal workspace.
4. **Ending the meeting.** `POST /demo/exit` clears the cookie, exactly as for the staged demo. The
   prospect's account is left alone: it is a genuine signup they keep, and it is never reset or wiped.
