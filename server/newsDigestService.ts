/**
 * newsDigestService.ts
 * Fetches news for a US stock ticker via Perplexity Search API,
 * generates AI summary via Claude, and stores results in DB.
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";

const anthropic = new Anthropic();

// Today's date in ET (US Eastern Time)
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

interface RawSource {
  sourceName: string;
  articleTitle: string;
  articleUrl: string;
  publishedAt: string;
  sourceDomain: string;
}

interface DigestResult {
  ticker: string;
  success: boolean;
  error?: string;
}

/** Extract domain from URL */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Extract source name from domain */
function domainToSourceName(domain: string): string {
  const map: Record<string, string> = {
    "reuters.com": "Reuters",
    "cnbc.com": "CNBC",
    "bloomberg.com": "Bloomberg",
    "wsj.com": "WSJ",
    "ft.com": "FT",
    "marketwatch.com": "MarketWatch",
    "barrons.com": "Barron's",
    "yahoo.com": "Yahoo Finance",
    "finance.yahoo.com": "Yahoo Finance",
    "seekingalpha.com": "Seeking Alpha",
    "thestreet.com": "TheStreet",
    "benzinga.com": "Benzinga",
    "fool.com": "Motley Fool",
    "investopedia.com": "Investopedia",
    "techcrunch.com": "TechCrunch",
    "theinformation.com": "The Information",
    "spacenews.com": "SpaceNews",
    "spaceflightnow.com": "SpaceflightNow",
  };
  for (const [key, val] of Object.entries(map)) {
    if (domain.includes(key)) return val;
  }
  return domain.split(".")[0] || domain;
}

/**
 * Fetch news for a ticker using Perplexity Search via Claude's web_search tool
 * or fall back to a structured prompt that asks Claude to summarize from its knowledge.
 */
async function fetchAndSummarize(
  ticker: string,
  companyName: string,
  priceClose?: number,
  priceChangePct?: number
): Promise<{
  summaryText: string;
  aiTakeaway: string;
  sentimentLabel: string;
  sources: RawSource[];
}> {
  const dateStr = todayET();
  const priceInfo = priceClose
    ? `今日收盤價: $${priceClose.toFixed(2)}，漲跌幅: ${priceChangePct != null ? (priceChangePct >= 0 ? "+" : "") + priceChangePct.toFixed(2) + "%" : "N/A"}`
    : "";

  const prompt = `請針對美股 ${ticker}（${companyName}）產生 ${dateStr} 的每日新聞彙總。
${priceInfo}

請執行以下任務：
1. 搜尋今日或最近 24 小時內關於 ${ticker} 的重要新聞
2. 整合新聞重點，產生 150-250 字的繁體中文摘要（著重於影響股價或公司基本面的關鍵訊息）
3. 產生一段 50-80 字的「AI 判讀重點」，說明新聞背後的市場意涵
4. 判斷整體新聞情緒：positive、negative 或 neutral
5. 列出你引用的新聞來源（標題、網址、發布時間）

請以下列 JSON 格式回覆（不要加其他文字）：
{
  "summaryText": "...",
  "aiTakeaway": "...",
  "sentimentLabel": "positive|negative|neutral",
  "sources": [
    {
      "articleTitle": "...",
      "articleUrl": "...",
      "publishedAt": "YYYY-MM-DD HH:mm"
    }
  ]
}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const textContent = message.content.find((c: any) => c.type === "text");
  const raw = textContent ? (textContent as any).text : "";

  // Parse JSON from response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");

  const parsed = JSON.parse(jsonMatch[0]);

  const sources: RawSource[] = (parsed.sources ?? []).map((s: any) => {
    const domain = extractDomain(s.articleUrl ?? "");
    return {
      sourceName: domainToSourceName(domain),
      articleTitle: s.articleTitle ?? "",
      articleUrl: s.articleUrl ?? "",
      publishedAt: s.publishedAt ?? "",
      sourceDomain: domain,
    };
  });

  return {
    summaryText: parsed.summaryText ?? "",
    aiTakeaway: parsed.aiTakeaway ?? "",
    sentimentLabel: ["positive", "negative", "neutral"].includes(parsed.sentimentLabel)
      ? parsed.sentimentLabel
      : "neutral",
    sources,
  };
}

/** Process a single ticker and write to DB */
export async function generateDigestForTicker(
  ticker: string,
  companyName: string,
  priceClose?: number,
  priceChangePct?: number
): Promise<DigestResult> {
  const digestDate = todayET();
  try {
    const { summaryText, aiTakeaway, sentimentLabel, sources } =
      await fetchAndSummarize(ticker, companyName, priceClose, priceChangePct);

    const digest = storage.upsertDigest({
      ticker,
      digestDate,
      generatedAt: Date.now(),
      priceClose: priceClose ?? null,
      priceChangePct: priceChangePct ?? null,
      summaryText,
      aiTakeaway,
      sentimentLabel,
      sourceCount: sources.length,
      status: "ok",
    });

    storage.replaceSourcesForDigest(digest.id, sources);

    console.log(`[newsDigest] ${ticker} OK — ${sources.length} sources`);
    return { ticker, success: true };
  } catch (e: any) {
    console.error(`[newsDigest] ${ticker} ERROR:`, e.message);
    // Write error status so UI can show per-card error
    try {
      storage.upsertDigest({
        ticker,
        digestDate,
        generatedAt: Date.now(),
        priceClose: priceClose ?? null,
        priceChangePct: priceChangePct ?? null,
        summaryText: "",
        aiTakeaway: "",
        sentimentLabel: "neutral",
        sourceCount: 0,
        status: "error",
      });
    } catch {}
    return { ticker, success: false, error: e.message };
  }
}

/** Process all US watchlist tickers sequentially */
export async function generateAllDigests(): Promise<{
  results: DigestResult[];
  updatedAt: number;
}> {
  const watchlistItems = await storage.getWatchlist();
  const usItems = watchlistItems.filter((w) => w.market === "US");

  const results: DigestResult[] = [];
  for (const item of usItems) {
    const result = await generateDigestForTicker(item.symbol, item.name);
    results.push(result);
    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 1500));
  }

  return { results, updatedAt: Date.now() };
}
