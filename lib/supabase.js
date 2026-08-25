// supabase.js — the Supabase client, used ONLY when DATA_PROVIDER=supabase.
//
// It's guarded and lazy: the app keeps running on SQLite with no Supabase package
// installed and no keys set. The @supabase/supabase-js import is dynamic, so it's an
// optional dependency until you actually flip DATA_PROVIDER=supabase.
import "dotenv/config";

export function dataProvider() {
  return (process.env.DATA_PROVIDER || "sqlite").toLowerCase();
}

// First non-empty env var among several accepted names (trimmed — a pasted trailing
// space must not break auth). Alternate names cover the Vercel/Supabase integration
// and template conventions, so keys "just work" however they were added.
function env(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}
// Exported: auth.js needs the project URL to build the hosted OAuth authorize link.
// Same env lookup as everything else here, so alternate key names keep working.
export function supabaseUrl() {
  return env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
}
const anonKey = () => env("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_KEY", "SUPABASE_PUBLISHABLE_KEY");
const serviceKey = () => env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_SECRET_KEY");

// True when we're configured to talk to a real Supabase project.
export function supabaseEnabled() {
  return dataProvider() === "supabase" && !!supabaseUrl() && !!(serviceKey() || anonKey());
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
  _client = createClient(supabaseUrl(), serviceKey() || anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
