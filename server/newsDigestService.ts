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
  summaryText:    string;       // translated (zh-TW) for UI display
  summaryRaw?:    string;       // English original for sentiment scoring
  sentimentLabel: "positive" | "negative" | "neutral";
  sources:        DigestSourceInput[];
}

export interface DigestResult {
  ticker:  string;
  success: boolean;
  error?:  string;
}

// ─── Sentiment scoring (structured Bull/Bear extraction) ────────────────────
// Mirrors the Python compute_sentiment_score() in news_digest_cron.py.
// Parses 🐂/🐻 sections from finance_ticker_sentiment content and produces
// a -1.0 to +1.0 score based on citation count + signal word weighting.

const BULL_SIGNALS = [
  /beat\b/i, /exceed/i, /surpass/i, /raise[sd]?\s+guidance/i, /raised\s+\w+\s+guidance/i,
  /record\s+\w*(revenue|sales|profit|earnings)/i, /upgrad/i, /strong\s+(growth|demand|beat)/i,
  /exceptional/i, /outperform/i, /accelerat/i, /expand/i, /momentum/i,
  /bullish/i, /positive\s+catalyst/i, /upside/i, /conviction/i, /growth\s+driver/i,
];

const BEAR_SIGNALS = [
  /downgrad/i, /miss/i, /cut\s+(price\s+)?target/i, /concern/i, /\brisk\b/i, /headwind/i,
  /decline/i, /disappoint/i, /compress/i, /slowdown/i, /cautious/i, /warning/i,
  /pressure/i, /uncertainty/i, /bearish/i, /selling/i, /downside/i,
];

function countSignals(text: string, patterns: RegExp[]): number {
  return patterns.filter(p => p.test(text)).length;
}

function sectionWeight(sections: string[], signals: RegExp[]): number {
  return sections.reduce((total, sec) => {
    const cited  = (sec.match(/\[\d+\]/g) ?? []).length;
    const base   = 1.0 + Math.min(cited * 0.3, 1.5);   // 1.0 – 2.5
    const boost  = Math.min(countSignals(sec, signals) * 0.2, 0.8); // 0 – 0.8
    return total + base + boost;
  }, 0);
}

export function computeSentimentScore(content: string): {
  sentimentScore: number;
  bullishRatio:   number;
  articleCount:   number;
} {
  // Match each 🐂 / 🐻 section up until the next emoji of either type
  const bullSections = [...content.matchAll(/\u{1F402}[^\u{1F402}\u{1F43B}]*/gsu)].map(m => m[0]);
  const bearSections = [...content.matchAll(/\u{1F43B}[^\u{1F402}\u{1F43B}]*/gsu)].map(m => m[0]);

  const issueCount   = (content.match(/\*\*Issue \d+/g) ?? []).length;
  const articleCount = Math.max(issueCount, bullSections.length, 1);

  const bullW = sectionWeight(bullSections, BULL_SIGNALS);
  const bearW = sectionWeight(bearSections, BEAR_SIGNALS);
  const total = bullW + bearW;

  const raw            = total < 0.01 ? 0 : (bullW - bearW) / total;
  const sentimentScore = Math.max(-1, Math.min(1, parseFloat((raw * 1.2).toFixed(4))));
  const bullishRatio   = total > 0 ? parseFloat((bullW / total).toFixed(4)) : 0.5;

  return { sentimentScore, bullishRatio, articleCount };
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

    // Compute and store sentiment score from English original
    // Falls back to summaryText if summaryRaw not provided
    const scoringText = item.summaryRaw || item.summaryText;
    if (scoringText) {
      try {
        const { sentimentScore, bullishRatio, articleCount } = computeSentimentScore(scoringText);
        (storage as any).upsertNewsSentiment(
          item.ticker, "US", item.digestDate,
          sentimentScore, bullishRatio, articleCount
        );
        console.log(`[newsDigest] saved ${item.ticker} (${item.digestDate}) — ${item.sources.length} sources, sentiment=${sentimentScore}`);
      } catch (se: any) {
        console.warn(`[newsDigest] sentiment score failed for ${item.ticker}:`, se.message);
        console.log(`[newsDigest] saved ${item.ticker} (${item.digestDate}) — ${item.sources.length} sources`);
      }
    } else {
      console.log(`[newsDigest] saved ${item.ticker} (${item.digestDate}) — ${item.sources.length} sources`);
    }

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
