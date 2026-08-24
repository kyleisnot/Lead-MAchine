// deploy-env.js — non-secret runtime defaults for the HOSTED instance (imported only
// by api/index.js, the Vercel entry — local `npm run dashboard` never loads this).
//
// The SECRETS (SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) must be set in
// Vercel Project Settings → Environment Variables — never in this file.
// ||= keeps real project env vars winning when they exist.
process.env.DATA_PROVIDER ||= "supabase";
process.env.SUPABASE_URL ||= "https://rhlecrahjwxfqewpzecp.supabase.co";
process.env.ADMIN_EMAILS ||= "jtrump1348@gmail.com";
process.env.TOKENS_PER_USD ||= "100";
