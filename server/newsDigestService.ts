/**
 * newsDigestService.ts  v6.0
 *
 * Replaced Claude API with Perplexity Finance `finance_ticker_sentiment`.
 * Zero LLM API cost — uses the same external-tool CLI as stockService.ts.
 *
 * Data flow:
 *   finance_ticker_sentiment → parse bulls/bears + sources → DB
 *
 * Schedule:
 *   scheduleNewsDigestRefresh() — runs daily at UTC 13:00 (CST 21:00)
 *   for all US watchlist stocks, 2s gap between calls (rate limit buffer).
 */

import { execSync } from "child_process";
import { storage } from "./storage";

// ─── external-tool helper ────────────────────────────────────────────────────

function callExternalTool(sourceId: string, toolName: string, args: Record<string, any>): any {
  const params  = JSON.stringify({ source_id: sourceId, tool_name: toolName, arguments: args });
  const escaped = params.replace(/'/g, "'\\''");
  const raw     = execSync(`external-tool call '${escaped}'`, { timeout: 40_000 }).toString();
  return JSON.parse(raw);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedSource {
  sourceName:   string;
  articleTitle: string;
  articleUrl:   string;
  publishedAt:  string;
  sourceDomain: string;
}

interface DigestResult {
  ticker:  string;
  success: boolean;
  error?:  string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Today's date in ET (US Eastern Time) */
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Extract domain from URL */
function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

/** Map domain to friendly source name */
function domainToSourceName(domain: string): string {
  const map: Record<string, string> = {
    "reuters.com":        "Reuters",
    "cnbc.com":           "CNBC",
    "bloomberg.com":      "Bloomberg",
    "wsj.com":            "WSJ",
    "ft.com":             "FT",
    "marketwatch.com":    "MarketWatch",
    "barrons.com":        "Barron's",
    "yahoo.com":          "Yahoo Finance",
    "finance.yahoo.com":  "Yahoo Finance",
    "seekingalpha.com":   "Seeking Alpha",
    "thestreet.com":      "TheStreet",
    "benzinga.com":       "Benzinga",
    "fool.com":           "Motley Fool",
    "simplywall.st":      "Simply Wall St",
    "marketbeat.com":     "MarketBeat",
    "marketscreener.com": "MarketScreener",
    "investors.com":      "Investor's Business Daily",
    "financhill.com":     "Financhill",
    "ainvest.com":        "AInvest",
  };
  for (const [key, val] of Object.entries(map)) {
    if (domain.includes(key)) return val;
  }
  const seg = domain.split(".")[0] ?? domain;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Parse the sources block from finance_ticker_sentiment content.
 *
 * Format example:
 *   [0] Article Title (2026-05-01T09:56:08) - https://example.com/article
 */
function parseSources(content: string): ParsedSource[] {
  const lines   = content.split("\n");
  const sources: ParsedSource[] = [];

  // Match lines like: [0] Title (date) - url
  const sourceRegex = /^\[(\d+)\]\s+(.+?)\s+\((\d{4}-\d{2}-\d{2})[^)]*\)\s+-\s+(https?:\/\/\S+)/;

  for (const line of lines) {
    const m = line.match(sourceRegex);
    if (!m) continue;
    const title  = m[2].trim();
    const date   = m[3];           // YYYY-MM-DD
    const url    = m[4].trim();
    const domain = extractDomain(url);
    sources.push({
      sourceName:   domainToSourceName(domain),
      articleTitle: title,
      articleUrl:   url,
      publishedAt:  date,
      sourceDomain: domain,
    });
  }
  return sources;
}

/**
 * Derive sentiment from the bulls/bears text.
 * Counts explicit bull 🐂 and bear 🐻 sections; more bears → negative.
 * Falls back to keyword scanning.
 */
function deriveSentiment(content: string): "positive" | "negative" | "neutral" {
  const bullCount = (content.match(/🐂|Bull Case/gi) ?? []).length;
  const bearCount = (content.match(/🐻|Bear Case/gi) ?? []).length;
  if (bullCount > bearCount) return "positive";
  if (bearCount > bullCount) return "negative";
  return "neutral";
}

/**
 * Extract just the analysis body (before the Sources: block).
 * Keeps markdown formatting for display.
 */
function extractSummaryText(content: string): string {
  // Cut at the Sources block (starts with "[0]" or "**Sources:**" or "Sources:")
  const sourceBlockIndex = content.search(/\n\*?\*?Sources:\*?\*?\n|\n\[0\]/);
  const body = sourceBlockIndex > 0 ? content.slice(0, sourceBlockIndex) : content;
  return body.trim();
}

// ─── Main: generate digest for one ticker ────────────────────────────────────

export async function generateDigestForTicker(
  ticker:         string,
  companyName:    string,
  priceClose?:    number,
  priceChangePct?: number
): Promise<DigestResult> {
  const digestDate = todayET();

  try {
    console.log(`[newsDigest] ${ticker}: calling finance_ticker_sentiment…`);

    const result  = callExternalTool("finance", "finance_ticker_sentiment", {
      ticker_symbol: ticker,
      query:         `${ticker} ${companyName} latest news and analysis`,
      action:        `Fetching daily news sentiment for ${ticker}`,
    });

    const content = (result?.content ?? "") as string;
    if (!content) throw new Error("Empty response from finance_ticker_sentiment");

    const summaryText     = extractSummaryText(content);
    const sentimentLabel  = deriveSentiment(content);
    const sources         = parseSources(content);

    console.log(`[newsDigest] ${ticker}: ${sources.length} sources, sentiment=${sentimentLabel}`);

    // Persist digest
    const digest = storage.upsertDigest({
      ticker,
      digestDate,
      generatedAt:    Date.now(),
      priceClose:     priceClose     ?? null,
      priceChangePct: priceChangePct ?? null,
      summaryText,
      aiTakeaway:     "",   // kept for DB schema compatibility
      sentimentLabel,
      sourceCount:    sources.length,
      status:         "ok",
    });

    storage.replaceSourcesForDigest(digest.id, sources);
    console.log(`[newsDigest] ${ticker} OK — ${sources.length} sources saved`);
    return { ticker, success: true };

  } catch (e: any) {
    console.error(`[newsDigest] ${ticker} ERROR:`, e.message);
    try {
      storage.upsertDigest({
        ticker,
        digestDate,
        generatedAt:    Date.now(),
        priceClose:     priceClose     ?? null,
        priceChangePct: priceChangePct ?? null,
        summaryText:    "",
        aiTakeaway:     "",
        sentimentLabel: "neutral",
        sourceCount:    0,
        status:         "error",
      });
    } catch { /* */ }
    return { ticker, success: false, error: e.message };
  }
}

// ─── Batch: all US watchlist stocks ──────────────────────────────────────────

export async function generateAllDigests(): Promise<{
  results:   DigestResult[];
  updatedAt: number;
}> {
  const watchlistItems = await storage.getWatchlist();
  const usItems        = watchlistItems.filter((w) => w.market === "US");

  const results: DigestResult[] = [];
  for (const item of usItems) {
    const result = await generateDigestForTicker(item.symbol, item.name);
    results.push(result);
    // 2s gap between calls — finance_ticker_sentiment has its own rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  return { results, updatedAt: Date.now() };
}

// ─── Daily scheduler (UTC 13:00 = CST 21:00) ─────────────────────────────────

export function scheduleNewsDigestRefresh(): void {
  function msUntilNextRun(): number {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(13, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleNext(): void {
    const ms = msUntilNextRun();
    console.log(`[newsDigest] Next auto-refresh in ${(ms / 3600000).toFixed(1)}h (UTC 13:00)`);
    setTimeout(async () => {
      console.log("[newsDigest] Starting daily auto-refresh…");
      try {
        const { results } = await generateAllDigests();
        const ok  = results.filter((r) => r.success).length;
        const err = results.filter((r) => !r.success).length;
        console.log(`[newsDigest] Daily refresh done — ${ok} OK, ${err} errors`);
      } catch (e: any) {
        console.error("[newsDigest] Daily refresh failed:", e.message);
      }
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
