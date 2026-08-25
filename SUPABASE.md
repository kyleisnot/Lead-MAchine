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
