// deploy-env.js — non-secret runtime defaults for the HOSTED instance (imported only
// by api/index.js, the Vercel entry — local `npm run dashboard` never loads this).
//
// The SECRETS (SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) must be set in
// Vercel Project Settings → Environment Variables — never in this file.
// ||= keeps real project env vars winning when they exist.
process.env.DATA_PROVIDER ||= "supabase";
process.env.SUPABASE_URL ||= "https://rhlecrahjwxfqewpzecp.supabase.co";
process.env.ADMIN_EMAILS ||= "jtrump1348@gmail.com,kylecantrell65@gmail.com";
// Credits are deliberately NOT cents: at 75/USD one credit is ~1.33c, so a customer
// cannot read our cost off the plan. A typical search lands at ~25 credits.
process.env.TOKENS_PER_USD ||= "75";
// Measured, not guessed: a 3-source scan really bills ~$7.50 per 1,000 places
// (each scraper carries its own startup cost). The old $4 undercharged by ~46%.
process.env.APIFY_RATE_PER_1K ||= "7.5";
