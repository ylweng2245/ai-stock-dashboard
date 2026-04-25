/**
 * newsDigestService.ts  v5.2
 * Step 1: Fetch real news from Finnhub + Marketaux (parallel, deduplicated, max 5).
 * Step 2: Feed articles to Claude for zh-TW summary + sentiment (no aiTakeaway).
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";

const anthropic = new Anthropic();

const FINNHUB_API_KEY   = process.env.FINNHUB_API_KEY   ?? "";
const MARKETAUX_API_KEY = process.env.MARKETAUX_API_KEY ?? "";

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

interface MarketauxArticle {
  title: string;
  description: string;
  url: string;
  source: string;
  published_at: string; // ISO 8601
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
  const seg = domain.split(".")[0] ?? domain;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

// ─── Finnhub ────────────────────────────────────────────────────────────────

async function fetchFinnhubNews(ticker: string): Promise<FinnhubArticle[]> {
  if (!FINNHUB_API_KEY) {
    throw new Error("FINNHUB_API_KEY 環境變數未設定");
  }

  async function query(daysBack: number): Promise<FinnhubArticle[]> {
    const { from, to } = unixRange(daysBack);
    const fromDate = new Date(from * 1000).toISOString().slice(0, 10);
    const toDate   = new Date(to   * 1000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${toDate}&token=${FINNHUB_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = await res.json() as FinnhubArticle[];
    return data
      .filter((a) => a.headline && a.url)
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 10);
  }

  let articles = await query(1);
  if (articles.length < 2) articles = await query(3);
  return articles;
}

// ─── Marketaux ──────────────────────────────────────────────────────────────

async function fetchMarketauxNews(ticker: string): Promise<FinnhubArticle[]> {
  if (!MARKETAUX_API_KEY) return [];
  try {
    const url =
      `https://api.marketaux.com/v1/news/all` +
      `?symbols=${encodeURIComponent(ticker)}` +
      `&filter_entities=true` +
      `&language=en` +
      `&api_token=${MARKETAUX_API_KEY}` +
      `&limit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      console.warn(`fetchMarketauxNews ${ticker}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json() as { data?: MarketauxArticle[] };
    return (data.data ?? [])
      .filter((a) => a.title && a.url)
      .map((a) => ({
        headline: a.title,
        summary:  a.description ?? "",
        url:      a.url,
        source:   a.source ?? "Marketaux",
        datetime: Math.floor(new Date(a.published_at).getTime() / 1000),
      }));
  } catch (e: any) {
    console.warn(`fetchMarketauxNews ${ticker}: ${e.message}`);
    return [];
  }
}

// ─── Dedup + limit ──────────────────────────────────────────────────────────

/**
 * Merge articles from multiple sources, remove duplicates
 * (identical URL or first-40-char headline match), sort newest first,
 * keep at most maxCount.
 */
function deduplicateAndLimit(articles: FinnhubArticle[], maxCount: number): FinnhubArticle[] {
  const seen   = new Set<string>();
  const result: FinnhubArticle[] = [];
  const sorted = [...articles].sort((a, b) => b.datetime - a.datetime);

  for (const article of sorted) {
    if (result.length >= maxCount) break;

    if (seen.has(article.url)) continue;
    seen.add(article.url);

    const headlineKey = article.headline
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .slice(0, 40)
      .trim();
    if (headlineKey && seen.has(headlineKey)) continue;
    if (headlineKey) seen.add(headlineKey);

    result.push(article);
  }
  return result;
}

// ─── Claude summarization ───────────────────────────────────────────────────

async function summarizeWithClaude(
  ticker: string,
  companyName: string,
  articles: FinnhubArticle[],
  priceClose?: number,
  priceChangePct?: number
): Promise<{
  summaryText: string;
  sentimentLabel: string;
  sources: RawSource[];
}> {
  const dateStr   = todayET();
  const priceInfo = priceClose != null
    ? `$${priceClose.toFixed(2)}，漲跌幅: ${priceChangePct != null ? priceChangePct.toFixed(2) + "%" : "N/A"}`
    : "";

  const articleContext = articles.map((a, i) => {
    const dt = new Date(a.datetime * 1000).toISOString().replace("T", " ").slice(0, 16);
    return `[${i + 1}] 來源: ${a.source} | 時間: ${dt}\n標題: ${a.headline}\n摘要: ${a.summary ?? "（無摘要）"}\n網址: ${a.url}`;
  }).join("\n\n");

  const noNewsContext = `目前在近期查無 ${ticker} 的新聞文章。`;

  const prompt = `你是專業的財經新聞分析師。以下是 ${ticker}（${companyName}）截至 ${dateStr} 的最新新聞${priceInfo ? `，當前股價 ${priceInfo}` : ""}。

${articles.length > 0 ? articleContext : noNewsContext}

請以繁體中文輸出 JSON，格式如下（不要包含其他文字）：
{
  "summaryText": "150-250字的專業新聞摘要，涵蓋主要事件、業務影響與市場意義",
  "sentimentLabel": "positive 或 negative 或 neutral 三選一",
  "sources": [{"articleTitle": "...", "articleUrl": "...", "publishedAt": "YYYY-MM-DD HH:mm"}]
}`;

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 1024,
    messages:   [{ role: "user", content: prompt }],
  });

  const textContent = message.content.find((c: any) => c.type === "text");
  const raw = textContent ? (textContent as any).text : "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude 回覆格式錯誤：無 JSON");

  const parsed = JSON.parse(jsonMatch[0]);

  const sources: RawSource[] = (parsed.sources ?? []).map((s: any) => {
    const matched = articles.find(
      (a) => a.url === s.articleUrl || a.headline === s.articleTitle
    );
    const url    = matched?.url ?? s.articleUrl ?? "";
    const domain = extractDomain(url);
    const dt     = matched
      ? new Date(matched.datetime * 1000).toISOString().replace("T", " ").slice(0, 16)
      : (s.publishedAt ?? "");
    return {
      sourceName:   matched ? domainToSourceName(extractDomain(matched.url)) : domainToSourceName(domain),
      articleTitle: matched?.headline ?? s.articleTitle ?? "",
      articleUrl:   url,
      publishedAt:  dt,
      sourceDomain: domain,
    };
  }).filter((s: RawSource) => s.articleUrl);

  return {
    summaryText: parsed.summaryText ?? "",
    sentimentLabel: ["positive", "negative", "neutral"].includes(parsed.sentimentLabel)
      ? parsed.sentimentLabel
      : "neutral",
    sources,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Process a single ticker: Finnhub + Marketaux → dedup → Claude → DB */
export async function generateDigestForTicker(
  ticker: string,
  companyName: string,
  priceClose?: number,
  priceChangePct?: number
): Promise<DigestResult> {
  const digestDate = todayET();
  try {
    // Step 1: fetch from both sources in parallel
    const [finnhubResult, marketauxResult] = await Promise.allSettled([
      fetchFinnhubNews(ticker),
      fetchMarketauxNews(ticker),
    ]);
    const rawFinnhub   = finnhubResult.status   === "fulfilled" ? finnhubResult.value   : [];
    const rawMarketaux = marketauxResult.status === "fulfilled" ? marketauxResult.value : [];

    // Step 1b: merge, deduplicate, limit to 5
    const articles = deduplicateAndLimit([...rawFinnhub, ...rawMarketaux], 5);
    console.log(
      `[newsDigest] ${ticker}: Finnhub ${rawFinnhub.length}, Marketaux ${rawMarketaux.length}, ` +
      `after dedup: ${articles.length} articles`
    );

    // Step 2: summarize with Claude
    const { summaryText, sentimentLabel, sources } =
      await summarizeWithClaude(ticker, companyName, articles, priceClose, priceChangePct);

    // Step 3: persist to DB (aiTakeaway fixed to "" for schema compatibility)
    const digest = storage.upsertDigest({
      ticker,
      digestDate,
      generatedAt:    Date.now(),
      priceClose:     priceClose     ?? null,
      priceChangePct: priceChangePct ?? null,
      summaryText,
      aiTakeaway:     "",   // removed in v5.2, kept for DB compatibility
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
    // Respect Finnhub free-plan rate limit (60 req/min)
    await new Promise((r) => setTimeout(r, 1200));
  }

  return { results, updatedAt: Date.now() };
}
