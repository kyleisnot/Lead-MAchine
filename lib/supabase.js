// supabase.js — the Supabase client, used ONLY when DATA_PROVIDER=supabase.
//
// It's guarded and lazy: the app keeps running on SQLite with no Supabase package
// installed and no keys set. The @supabase/supabase-js import is dynamic, so it's an
// optional dependency until you actually flip DATA_PROVIDER=supabase.
import "dotenv/config";

export function dataProvider() {
  return (process.env.DATA_PROVIDER || "sqlite").toLowerCase();
}

// True when we're configured to talk to a real Supabase project.
export function supabaseEnabled() {
  return (
    dataProvider() === "supabase" &&
    !!process.env.SUPABASE_URL &&
    !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
  );
}

let _client = null;

// A server-side admin client (service-role key bypasses RLS — we scope by user_id in code).
// Falls back to the anon key if that's all that's set (RLS then applies on the caller's JWT).
export async function getSupabase() {
  if (!supabaseEnabled()) {
    throw new Error(
      "Supabase is not configured. Set DATA_PROVIDER=supabase, SUPABASE_URL and a key in .env, " +
        "then run: npm install @supabase/supabase-js"
    );
  }
  if (_client) return _client;
  const { createClient } = await import("@supabase/supabase-js"); // optional dep, loaded on demand
  _client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return _client;
}
