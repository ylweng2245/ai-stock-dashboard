/**
 * newsDigestService.ts
 * Step 1: Fetch real news articles from Finnhub (free API, no credit card).
 * Step 2: Feed article content to Claude for Chinese summarization + sentiment.
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";

const anthropic = new Anthropic();

// Finnhub API key from env
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY ?? "";

// Today's date in ET (US Eastern Time)
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Unix timestamps for a date range
function unixRange(daysBack: number): { from: number; to: number } {
  const to = Math.floor(Date.now() / 1000);
  const from = to - daysBack * 86400;
  return { from, to };
}

interface RawSource {
  sourceName: string;
  articleTitle: string;
  articleUrl: string;
  publishedAt: string;
  sourceDomain: string;
}

interface FinnhubArticle {
  headline: string;
  summary: string;
  url: string;
  source: string;
  datetime: number; // unix timestamp
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

/** Map domain to friendly source name */
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
    "businessinsider.com": "Business Insider",
    "fortune.com": "Fortune",
    "forbes.com": "Forbes",
  };
  for (const [key, val] of Object.entries(map)) {
    if (domain.includes(key)) return val;
  }
  // Capitalize first segment
  const seg = domain.split(".")[0] ?? domain;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Fetch company news from Finnhub.
 * Tries last 24h first; if fewer than 2 articles, expands to 3 days.
 */
async function fetchFinnhubNews(ticker: string): Promise<FinnhubArticle[]> {
  if (!FINNHUB_API_KEY) {
    throw new Error("FINNHUB_API_KEY 環境變數未設定");
  }

  async function query(daysBack: number): Promise<FinnhubArticle[]> {
    const { from, to } = unixRange(daysBack);
    const fromDate = new Date(from * 1000).toISOString().slice(0, 10);
    const toDate = new Date(to * 1000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${toDate}&token=${FINNHUB_API_KEY}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = await res.json() as FinnhubArticle[];
    // Sort newest first, keep top 10
    return data
      .filter((a) => a.headline && a.url)
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 10);
  }

  let articles = await query(1); // last 24h
  if (articles.length < 2) {
    articles = await query(3); // expand to 3 days
  }
  return articles;
}

/**
 * Build a context string from Finnhub articles and send to Claude for summarization.
 */
async function summarizeWithClaude(
  ticker: string,
  companyName: string,
  articles: FinnhubArticle[],
  priceClose?: number,
  priceChangePct?: number
): Promise<{
  summaryText: string;
  aiTakeaway: string;
  sentimentLabel: string;
  sources: RawSource[];
}> {
  const dateStr = todayET();
  const priceInfo = priceClose != null
    ? `今日收盤價: $${priceClose.toFixed(2)}，漲跌幅: ${priceChangePct != null ? (priceChangePct >= 0 ? "" : "") + priceChangePct.toFixed(2) + "%" : "N/A"}`
    : "";

  // Build article context
  const articleContext = articles.map((a, i) => {
    const dt = new Date(a.datetime * 1000).toISOString().replace("T", " ").slice(0, 16);
    return `[${i + 1}] 來源: ${a.source} | 時間: ${dt}\n標題: ${a.headline}\n摘要: ${a.summary ?? "（無摘要）"}\n網址: ${a.url}`;
  }).join("\n\n");

  const noNewsContext = `目前 Finnhub 在近期查無 ${ticker} 的新聞文章。`;

  const prompt = `你是一位專業的美股財經分析師，請根據以下提供的新聞資料，為 ${ticker}（${companyName}）產生 ${dateStr} 的每日新聞彙總。
${priceInfo ? `\n股價資訊：${priceInfo}\n` : ""}
=== 新聞資料 ===
${articles.length > 0 ? articleContext : noNewsContext}
=== 結束 ===

請完成以下任務：
1. 整合以上新聞重點，產生 150-250 字的繁體中文摘要（著重於影響股價或公司基本面的關鍵訊息）
2. 產生一段 50-80 字的「AI 判讀重點」，說明新聞背後的市場意涵與投資參考
3. 根據新聞整體傾向判斷情緒：positive、negative 或 neutral
4. 列出你實際引用的新聞來源（從上方資料中選取，不要捏造）

若近期無新聞，summaryText 請說明「近期無重大新聞，市場平靜」，sources 回傳空陣列。

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

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude 回覆格式錯誤：無 JSON");

  const parsed = JSON.parse(jsonMatch[0]);

  // Build sources from Finnhub article data (don't trust Claude-invented URLs)
  const sources: RawSource[] = (parsed.sources ?? []).map((s: any) => {
    // Try to match back to a real Finnhub article by URL or title
    const matched = articles.find(
      (a) => a.url === s.articleUrl || a.headline === s.articleTitle
    );
    const url = matched?.url ?? s.articleUrl ?? "";
    const domain = extractDomain(url);
    const dt = matched
      ? new Date(matched.datetime * 1000).toISOString().replace("T", " ").slice(0, 16)
      : (s.publishedAt ?? "");
    return {
      sourceName: matched ? domainToSourceName(extractDomain(matched.url)) : domainToSourceName(domain),
      articleTitle: matched?.headline ?? s.articleTitle ?? "",
      articleUrl: url,
      publishedAt: dt,
      sourceDomain: domain,
    };
  }).filter((s: RawSource) => s.articleUrl); // drop entries with no URL

  return {
    summaryText: parsed.summaryText ?? "",
    aiTakeaway: parsed.aiTakeaway ?? "",
    sentimentLabel: ["positive", "negative", "neutral"].includes(parsed.sentimentLabel)
      ? parsed.sentimentLabel
      : "neutral",
    sources,
  };
}

/** Process a single ticker: Finnhub → Claude → DB */
export async function generateDigestForTicker(
  ticker: string,
  companyName: string,
  priceClose?: number,
  priceChangePct?: number
): Promise<DigestResult> {
  const digestDate = todayET();
  try {
    // Step 1: fetch real news
    const articles = await fetchFinnhubNews(ticker);
    console.log(`[newsDigest] ${ticker} — Finnhub: ${articles.length} articles`);

    // Step 2: summarize with Claude
    const { summaryText, aiTakeaway, sentimentLabel, sources } =
      await summarizeWithClaude(ticker, companyName, articles, priceClose, priceChangePct);

    // Step 3: persist to DB
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

    console.log(`[newsDigest] ${ticker} OK — ${sources.length} sources saved`);
    return { ticker, success: true };
  } catch (e: any) {
    console.error(`[newsDigest] ${ticker} ERROR:`, e.message);
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
    // Avoid Finnhub rate limit (60 req/min free plan)
    await new Promise((r) => setTimeout(r, 1200));
  }

  return { results, updatedAt: Date.now() };
}
