// spend.js — Apify monthly spend lookup + the hard cap guardrail.
//
// APIFY_MONTHLY_CAP (.env): when this month's Apify spend reaches this USD number,
// new live searches are blocked in the dashboard. Blank/0 = no cap.

import "dotenv/config";

const CAP = parseFloat(process.env.APIFY_MONTHLY_CAP || "0") || 0;
export const RATE_PER_1K = parseFloat(process.env.APIFY_RATE_PER_1K || "4") || 4;

// This month's Apify spend in USD (null if it can't be read).
export async function apifySpend() {
  const t = process.env.APIFY_TOKEN;
  if (!t) return null;
  try {
    // Token in the Authorization header (not the URL query string) so it never lands in logs.
    const mu = await fetch("https://api.apify.com/v2/users/me/usage/monthly", {
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json());
    const d = mu.data || {};
    return d.totalUsageCreditsUsdAfterVolumeDiscount ?? d.totalUsageCreditsUsdBeforeVolumeDiscount ?? null;
  } catch {
    return null;
  }
}

// Should a new search be blocked? Returns { blocked, spent, cap }.
// Fail-open: if spend can't be read, we don't block (never strand the user).
export async function spendCapState() {
  if (!CAP) return { blocked: false, spent: null, cap: 0 };
  const spent = await apifySpend();
  if (spent == null) return { blocked: false, spent: null, cap: CAP };
  return { blocked: spent >= CAP, spent, cap: CAP };
}

// Rough $ estimate for a scan of N places (UI-only, clearly labeled as approximate).
export function estimateUsd(places) {
  return (places / 1000) * RATE_PER_1K;
}
