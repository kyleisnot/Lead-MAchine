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
// The flat price of a "Guaranteed 5 companies" search. It is a PRICE, not a cost model:
// the scan runs as long as it needs to (inside its own caps), and the customer sees one
// number up front. When the caps stop it short of 5 they pay the standard per-place rate
// for what was actually scanned instead, so an unlucky run never costs them the premium.
process.env.GUARANTEED_FIVE_TOKENS ||= "60";
// Bounds the slowest part of a scan. Measured: an uncapped run hit 235s of the 300s
// serverless limit on a SMALL result set, and the pass grows with lead yield — so the
// best-performing searches were the likeliest to time out. 8 keeps it ~255s worst case.
process.env.DEEP_CHECK_MAX ||= "8";
