/**
 * newsDigestService.ts  v6.1
 *
 * Server-side: pure DB read/write only.
 * AI summarization is handled by the Perplexity cron script (news_digest_cron.py)
 * which calls finance_ticker_sentiment and POSTs results to /api/internal/news-digest-sync.
 *
 * The "更新新聞彙總" button in the UI still exists but now triggers the cron endpoint
 * via the same internal sync route (or can be disabled).
 */

import { storage } from "./storage";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DigestSourceInput {
  sourceName:   string;
  articleTitle: string;
  articleUrl:   string;
  publishedAt:  string;
  sourceDomain: string;
}

export interface DigestSyncItem {
  ticker:         string;
  digestDate:     string;       // "YYYY-MM-DD" in ET
  generatedAt:    number;       // unix ms
  priceClose:     number | null;
  priceChangePct: number | null;
  summaryText:    string;
  sentimentLabel: "positive" | "negative" | "neutral";
  sources:        DigestSourceInput[];
}

export interface DigestResult {
  ticker:  string;
  success: boolean;
  error?:  string;
}

// ─── Save a single digest from cron data ─────────────────────────────────────

export function saveDigestData(item: DigestSyncItem): DigestResult {
  try {
    const digest = storage.upsertDigest({
      ticker:         item.ticker,
      digestDate:     item.digestDate,
      generatedAt:    item.generatedAt,
      priceClose:     item.priceClose,
      priceChangePct: item.priceChangePct,
      summaryText:    item.summaryText,
      aiTakeaway:     "",   // kept for DB schema compatibility
      sentimentLabel: item.sentimentLabel,
      sourceCount:    item.sources.length,
      status:         "ok",
    });
    storage.replaceSourcesForDigest(digest.id, item.sources);
    console.log(`[newsDigest] saved ${item.ticker} (${item.digestDate}) — ${item.sources.length} sources`);
    return { ticker: item.ticker, success: true };
  } catch (e: any) {
    console.error(`[newsDigest] save error for ${item.ticker}:`, e.message);
    return { ticker: item.ticker, success: false, error: e.message };
  }
}

// ─── Kept for UI "更新新聞彙總" button compat ────────────────────────────────
// Returns a message directing user to wait for the cron run.

export async function generateAllDigests(): Promise<{
  results:   DigestResult[];
  updatedAt: number;
}> {
  // No-op on the server side — actual generation is done by cron.
  // Return empty results so the UI doesn't break.
  console.log("[newsDigest] generateAllDigests called — actual generation is handled by cron.");
  return { results: [], updatedAt: Date.now() };
}
