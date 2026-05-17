/**
 * newsDigestService.ts  v6.2
 *
 * Server-side: pure DB read/write only.
 * AI summarization is handled by the Perplexity cron script (news_digest_cron.py)
 * which calls finance_ticker_sentiment and POSTs results to /api/internal/news-digest-sync.
 *
 * Sentiment scoring: uses Claude haiku-4-5 LLM for semantic -1 to +1 scoring.
 * Falls back to rule-based scoring if LLM call fails.
 */

import Anthropic from "@anthropic-ai/sdk";
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

// ─── Sentiment scoring ────────────────────────────────────────────────────────
// Primary: LLM-based (Claude haiku-4-5) semantic scoring → -1.0 to +1.0
// Fallback: rule-based Bull/Bear keyword extraction (used if LLM fails)

// ── Rule-based fallback ───────────────────────────────────────────────────────
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
    const base   = 1.0 + Math.min(cited * 0.3, 1.5);
    const boost  = Math.min(countSignals(sec, signals) * 0.2, 0.8);
    return total + base + boost;
  }, 0);
}

function computeSentimentScoreRuleBased(content: string): {
  sentimentScore: number;
  bullishRatio:   number;
  articleCount:   number;
} {
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

// ── LLM-based scoring (primary) ───────────────────────────────────────────────
export async function computeSentimentScore(content: string, ticker: string): Promise<{
  sentimentScore: number;
  bullishRatio:   number;
  articleCount:   number;
  scoringMethod:  "llm" | "rule-based";
}> {
  // Article count via rule-based (doesn't need LLM)
  const issueCount   = (content.match(/\*\*Issue \d+/g) ?? []).length;
  const bullSections = [...content.matchAll(/\u{1F402}[^\u{1F402}\u{1F43B}]*/gsu)].map(m => m[0]);
  const articleCount = Math.max(issueCount, bullSections.length, 1);

  try {
    const client = new Anthropic();
    const prompt = `You are a financial sentiment analyst. Read the following stock news analysis for ${ticker} and provide a precise sentiment score.

Return ONLY a JSON object with these exact fields:
- score: a float from -1.0 (extremely bearish) to +1.0 (extremely bullish), use the full range with precision to 2 decimal places
- bullish_ratio: a float from 0.0 to 1.0 representing the proportion of bullish signals vs total signals
- reasoning: one sentence explaining the score

Guidelines:
- Earnings beat with raised guidance → score near +0.7 to +1.0
- Earnings miss with cut guidance → score near -0.7 to -1.0
- Mixed signals (beat but cautious outlook) → score near -0.1 to +0.3
- Analyst upgrade → +0.2 to +0.5 contribution; downgrade → -0.2 to -0.5
- Interpret negation carefully: "not as bad as feared" is mildly positive, not negative
- "concerns easing" is positive; "concerns remain" is negative

News content:
${content.slice(0, 3000)}

Respond with JSON only, no markdown fences.`;

    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 200,
      messages:   [{ role: "user", content: prompt }],
    });

    const responseText = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    // Strip markdown code fences if present
    const cleaned = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed  = JSON.parse(cleaned);

    const sentimentScore = Math.max(-1, Math.min(1, parseFloat(Number(parsed.score).toFixed(4))));
    const bullishRatio   = Math.max(0, Math.min(1, parseFloat(Number(parsed.bullish_ratio).toFixed(4))));

    if (isNaN(sentimentScore) || isNaN(bullishRatio)) throw new Error("Invalid LLM response values");

    return { sentimentScore, bullishRatio, articleCount, scoringMethod: "llm" };
  } catch (err: any) {
    console.warn(`[newsDigest] LLM sentiment failed for ${ticker}, using rule-based fallback:`, err.message);
    const fb = computeSentimentScoreRuleBased(content);
    return { ...fb, scoringMethod: "rule-based" };
  }
}

// ─── Save a single digest from cron data ─────────────────────────────────────

export async function saveDigestData(item: DigestSyncItem): Promise<DigestResult> {
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

    // Compute and store sentiment score from English original (LLM primary, rule-based fallback)
    const scoringText = item.summaryRaw || item.summaryText;
    if (scoringText) {
      try {
        const { sentimentScore, bullishRatio, articleCount, scoringMethod } =
          await computeSentimentScore(scoringText, item.ticker);
        (storage as any).upsertNewsSentiment(
          item.ticker, "US", item.digestDate,
          sentimentScore, bullishRatio, articleCount
        );
        console.log(`[newsDigest] saved ${item.ticker} (${item.digestDate}) — ${item.sources.length} sources, sentiment=${sentimentScore} (${scoringMethod})`);
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

// ─── Kept for UI "更新新聞彙總" button compat ─────────────────────────────────
export async function generateAllDigests(): Promise<{
  results:   DigestResult[];
  updatedAt: number;
}> {
  // No-op on the server side — actual generation is done by cron.
  console.log("[newsDigest] generateAllDigests called — actual generation is handled by cron.");
  return { results: [], updatedAt: Date.now() };
}
