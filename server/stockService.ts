/**
 * stockService.ts — Real stock data from multiple public sources
 *
 * Data sources:
 *  1. TWSE mis.twse.com.tw       — Taiwan stocks real-time (no rate limit, official exchange)
 *  2. TWSE STOCK_DAY API         — Taiwan stocks historical (official exchange monthly data)
 *  3. Perplexity Finance API     — US equities + indices real-time (fast, no 429)
 *  4. Yahoo Finance v8 chart     — US equities historical OHLCV only
 *
 * Caching: In-memory, 60s TTL for quotes, 30min for history.
 * Every response includes dataTimestamp, fetchedAt, and source URL.
 */

import https from "https";
import { execSync } from "child_process";
import { storage } from "./storage";
import type { InsertHistoricalPrice } from "@shared/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StockQuote {
  symbol: string;
  yahooSymbol?: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  market: "TW" | "US";
  currency: string;
  dataTimestamp: number;   // Unix seconds — exchange reported time
  fetchedAt: number;       // Unix ms — our fetch time
  source: string;          // e.g. "TWSE" or "Perplexity Finance"
  sourceUrl: string;       // URL of the data source
  isStale: boolean;        // true if data older than expected
  // 市場狀態與價格標籤
  marketState: "PRE" | "REGULAR" | "POST" | "CLOSED" | "PREPRE";
  priceLabel: string;      // "即時" | "盤前參考" | "盤後" | "收盤"
  // v2: 更精細的狀態區分
  quoteStatus: "fresh" | "stale" | "error"; // fresh=正常, stale=超時但有數據, error=完全無資料
  isFallbackCache?: boolean; // true = 來自過期緩存（fetch失敗時）
}

export interface CandleBar {
  time: string;   // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoryResult {
  symbol: string;
  bars: CandleBar[];
  fetchedAt: number;
  source: string;
  sourceUrl: string;
  dataFrom: string;
  dataTo: string;
  // v2: DB-backed history metadata
  fromCache?: boolean;       // served from in-memory cache
  fromDatabase?: boolean;    // served (at least partly) from SQLite DB
  refreshAttempted?: boolean;// tried to fetch fresh data from Yahoo
  refreshSucceeded?: boolean;// fresh fetch succeeded
  lastStoredDate?: string;   // latest date stored in DB before this call
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> { data: T; fetchedAt: number; ttl?: number; }
const quoteCache = new Map<string, CacheEntry<StockQuote>>();
const historyCache = new Map<string, CacheEntry<HistoryResult>>();

const QUOTE_TTL_MS   = 60_000;
const HISTORY_TTL_MS = 30 * 60_000;

function isCacheValid<T>(entry: CacheEntry<T> | undefined, defaultTtl: number): boolean {
  if (!entry) return false;
  const ttl = entry.ttl ?? defaultTtl;
  return Date.now() - entry.fetchedAt < ttl;
}

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent Yahoo Finance history requests to avoid 429
// ---------------------------------------------------------------------------
class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve(); });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }
}

/** Max 2 concurrent Yahoo Finance history fetches (avoids 429 under sustained load) */
const historySemaphore = new Semaphore(2);

// ---------------------------------------------------------------------------
// DB helper utilities
// ---------------------------------------------------------------------------

/**
 * Convert DB HistoricalPrice rows to CandleBar array.
 * Filters out rows with invalid OHLCV data.
 */
function dbRowsToBars(rows: { date: string; open: number; high: number; low: number; close: number; volume: number }[]): CandleBar[] {
  return rows
    .filter((r) => r.close != null && !isNaN(r.close) && r.close > 0)
    .map((r) => ({
      time:   r.date,
      open:   +r.open.toFixed(2),
      high:   +r.high.toFixed(2),
      low:    +r.low.toFixed(2),
      close:  +r.close.toFixed(2),
      volume: r.volume ?? 0,
    }));
}

/**
 * Slice a full 2-year bar array to the requested range without hitting Yahoo Finance.
 * Supports: "1mo" | "3mo" | "6mo" | "1y" | "2y"
 */
export function sliceBarsByRange(bars: CandleBar[], range: string): CandleBar[] {
  if (!bars.length) return bars;
  const monthsMap: Record<string, number> = {
    "1mo":  1, "3mo":  3, "6mo":  6, "1y": 12, "2y": 24,
  };
  const months = monthsMap[range];
  if (!months) return bars; // unknown range — return all
  // Calculate cutoff date (today - N months)
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return bars.filter((b) => b.time >= cutoffStr);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
let uaIndex = 0;

function httpsGet(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        "User-Agent": USER_AGENTS[(uaIndex++) % USER_AGENTS.length],
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8",
        ...extraHeaders,
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// Fetch with exponential-backoff retry (up to 5 attempts).
// Alternates between query1/query2 hostnames on every retry to spread load.
async function fetchWithRetry(url: string, extraHeaders: Record<string, string> = {}, maxAttempts = 5): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Alternate between query1 and query2 on each attempt
    let attemptUrl = url;
    if (attempt % 2 === 1) {
      if (url.includes("query1.finance.yahoo.com")) {
        attemptUrl = url.replace("query1.finance.yahoo.com", "query2.finance.yahoo.com");
      } else if (url.includes("query2.finance.yahoo.com")) {
        attemptUrl = url.replace("query2.finance.yahoo.com", "query1.finance.yahoo.com");
      }
    }
    try {
      return await httpsGet(attemptUrl, extraHeaders);
    } catch (e: any) {
      lastErr = e;
      const is429 = e.message.includes("429") || e.message.includes("Too Many");
      const isTimeout = e.message.includes("Timeout");
      if (!is429 && !isTimeout) throw e; // non-retriable error, bail immediately
      if (attempt === maxAttempts - 1) break;  // last attempt, don't sleep
      // Exponential backoff with jitter: 1s, 2s, 4s, 8s
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`[fetchWithRetry] attempt ${attempt + 1} failed (${e.message.slice(0, 60)}), retrying in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// external-tool CLI helper (Perplexity Finance connector)
// ---------------------------------------------------------------------------

function callExternalTool(sourceId: string, toolName: string, args: Record<string, any>): any {
  const params = JSON.stringify({ source_id: sourceId, tool_name: toolName, arguments: args });
  // Use double-quote shell escaping to avoid issues with single quotes in JSON
  const escaped = params.replace(/'/g, "'\\''");
  const raw = execSync(`external-tool call '${escaped}'`, { timeout: 30_000 }).toString();
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Stock metadata (default watchlist — will be merged with DB watchlist)
// ---------------------------------------------------------------------------

export const DEFAULT_TW_WATCHLIST: Array<{ symbol: string; name: string; market: "TW" }> = [
  { symbol: "2330",   name: "台積電",              market: "TW" },
  { symbol: "2308",   name: "台達電",              market: "TW" },
  { symbol: "3017",   name: "奇鋐",                market: "TW" },
  { symbol: "2313",   name: "華通",                market: "TW" },
  { symbol: "0050",   name: "元大台灣50",          market: "TW" },
];

export const DEFAULT_US_WATCHLIST: Array<{ symbol: string; name: string; market: "US" }> = [
  { symbol: "PANW",   name: "Palo Alto Networks",  market: "US" },
  { symbol: "CRWD",   name: "CrowdStrike",          market: "US" },
  { symbol: "VST",    name: "Vistra",              market: "US" },
  { symbol: "LITE",   name: "Lumentum",            market: "US" },
  { symbol: "RKLB",   name: "Rocket Lab",          market: "US" },
  { symbol: "OKLO",   name: "Oklo",                market: "US" },
  { symbol: "LLY",    name: "Eli Lilly",           market: "US" },
];

// Combined default watchlist (backward compat export)
export const WATCHLIST_STOCKS: Array<{ symbol: string; name: string; market: "TW" | "US" }> = [
  ...DEFAULT_TW_WATCHLIST,
  ...DEFAULT_US_WATCHLIST,
];

export const PORTFOLIO_EXTRA: Array<{ symbol: string; name: string; market: "TW" | "US" }> = [
  { symbol: "00719B", name: "元大美債1-3",         market: "TW" },
  { symbol: "00891",  name: "中信關鍵半導體",      market: "TW" },
];

export const INDEX_SYMBOLS: Record<string, { finance: string; name: string; market: "TW" | "US" }> = {
  TWII:   { finance: "^TWII",  name: "加權指數",  market: "TW" },
  USDTWD: { finance: "USDTWD", name: "美元/台幣", market: "US" },
  GSPC:   { finance: "^GSPC",  name: "S&P 500",  market: "US" },
};

// ---------------------------------------------------------------------------
// Staleness check helper
// ---------------------------------------------------------------------------

/**
 * Returns true only if the data timestamp is from a PREVIOUS calendar day
 * in Asia/Taipei (UTC+8). Data from today is always considered fresh —
 * market close price remains valid for the full trading day.
 * Also returns false if timestamp is in the future (should never happen).
 */
function isDataFromPreviousDay(dataTimestampSec: number): boolean {
  const nowMs = Date.now();
  // Clamp to current time (future timestamps = not stale)
  if (dataTimestampSec * 1000 > nowMs) return false;
  // Convert both to YYYY-MM-DD in Asia/Taipei
  const toTPEDate = (ms: number) => {
    const d = new Date(ms);
    // UTC+8 offset: add 8 hours
    const tpe = new Date(ms + 8 * 3600 * 1000);
    return tpe.toISOString().slice(0, 10);
  };
  const dataDate = toTPEDate(dataTimestampSec * 1000);
  const nowDate  = toTPEDate(nowMs);
  return dataDate < nowDate;
}

// ---------------------------------------------------------------------------
// Market state helpers
// ---------------------------------------------------------------------------

/**
 * Normalize Yahoo Finance marketState string to our StockQuote.marketState type.
 * Yahoo may return: "PRE", "REGULAR", "POST", "POSTPOST", "PREPRE", "CLOSED"
 */
function normalizeMarketState(raw: string | undefined): StockQuote["marketState"] {
  const valid = ["PRE", "REGULAR", "POST", "CLOSED", "PREPRE"] as const;
  if (!raw) return "CLOSED";
  const upper = raw.toUpperCase();
  if ((valid as readonly string[]).includes(upper)) return upper as StockQuote["marketState"];
  if (upper === "POSTPOST") return "POST";
  return "CLOSED";
}

/**
 * Returns a human-readable Chinese label for the market state.
 */
function marketStateLabel(state: StockQuote["marketState"]): string {
  switch (state) {
    case "REGULAR": return "即時";
    case "PRE":     return "盤前參考";
    case "POST":    return "盤後";
    case "PREPRE":  return "早盤前";
    case "CLOSED":  return "收盤";
    default:        return "收盤";
  }
}

// ---------------------------------------------------------------------------
// TW: Real-time quotes via Yahoo Finance chart API
// ---------------------------------------------------------------------------
// TWSE mis.twse.com.tw only updates "z" (trade price) on actual executions and
// is unreliable from non-Taiwan IPs. Yahoo Finance v8/finance/chart?interval=1m
// provides regularMarketPrice in real-time and works globally for both .TW and .TWO.
//
// OTC-listed ETFs (like 00719B) use .TWO suffix; all others use .TW
const TWSE_TYPE: Record<string, string> = {
  "2330": "tse", "2308": "tse", "3017": "tse", "2395": "tse",
  "2313": "tse", "0050": "tse", "00719B": "otc", "00891": "tse",
  "00881": "tse", "00981A": "tse", "00830": "tse", "00662": "tse",
  "3665": "tse",
};

// Allow dynamic registration of TWSE types for user-added watchlist symbols
export function registerTwseType(symbol: string, type: "tse" | "otc") {
  TWSE_TYPE[symbol] = type;
}

function yahooTWSuffix(symbol: string): string {
  return (TWSE_TYPE[symbol] ?? "tse") === "otc" ? "TWO" : "TW";
}

/**
 * Parse Yahoo Finance spark API response into StockQuote array.
 */
function parseSparkResponse(body: string, nameMap: Map<string, string>): StockQuote[] {
  const json = JSON.parse(body);
  const sparkResults: any[] = json.spark?.result ?? [];
  const now = Date.now();
  const quotes: StockQuote[] = [];

  for (const r of sparkResults) {
    // Yahoo returns e.g. "2330.TW" or "00719B.TWO" — strip suffix to get our symbol
    const yahooSym: string = r.symbol ?? "";
    const dotIdx = yahooSym.lastIndexOf(".");
    const symbol = dotIdx >= 0 ? yahooSym.slice(0, dotIdx) : yahooSym;
    const suffix = dotIdx >= 0 ? yahooSym.slice(dotIdx + 1) : "TW";
    const name = nameMap.get(symbol) ?? symbol;

    const resp = (r.response ?? [])[0];
    if (!resp) continue;
    const meta = resp.meta ?? {};

    // Yahoo Spark v7 不提供 preMarketPrice / postMarketPrice
    // 一律使用 regularMarketPrice：盤中=即時，盤後=收盤價，符合需求
    const price = +(meta.regularMarketPrice ?? 0).toFixed(2);
    const marketState: StockQuote["marketState"] =
      meta.marketState ? normalizeMarketState(meta.marketState) : "CLOSED";
    const prevClose = +(meta.previousClose ?? meta.chartPreviousClose ?? price).toFixed(2);
    const change    = +(price - prevClose).toFixed(2);
    const changePct = prevClose !== 0 ? +((change / prevClose) * 100).toFixed(2) : 0;
    const dataTimestamp = meta.regularMarketTime ?? Math.floor(now / 1000);
    const priceLabel = marketStateLabel(marketState);

    const twIsStale = isDataFromPreviousDay(dataTimestamp);
    quotes.push({
      symbol,
      name,
      price,
      change,
      changePercent: changePct,
      volume: meta.regularMarketVolume ?? 0,
      high: +(meta.regularMarketDayHigh ?? price).toFixed(2),
      low:  +(meta.regularMarketDayLow  ?? price).toFixed(2),
      open: +(meta.regularMarketOpen    ?? price).toFixed(2),
      prevClose,
      market: "TW" as const,
      currency: "TWD",
      dataTimestamp,
      fetchedAt: now,
      source: "Yahoo Finance",
      sourceUrl: `https://finance.yahoo.com/quote/${symbol}.${suffix}`,
      isStale: twIsStale,
      marketState,
      priceLabel,
      quoteStatus: twIsStale ? "stale" : "fresh",
    });
  }
  return quotes;
}

/**
 * Batch-fetch TW stock quotes using Yahoo Finance spark API.
 * Supports up to 100 symbols by splitting into batches of 50.
 * Each batch is ONE HTTP request — drastically reduces 429 risk vs per-symbol calls.
 */
async function fetchTWSEQuotes(
  symbols: Array<{ symbol: string; name: string }>
): Promise<StockQuote[]> {
  if (symbols.length === 0) return [];

  const nameMap = new Map(symbols.map((s) => [s.symbol, s.name]));
  const SPARK_BATCH_SIZE = 50; // safe URL length limit (~600 chars per batch)
  const allQuotes: StockQuote[] = [];

  for (let i = 0; i < symbols.length; i += SPARK_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SPARK_BATCH_SIZE);
    const yahooSymbols = batch.map((s) => `${s.symbol}.${yahooTWSuffix(s.symbol)}`).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(yahooSymbols)}&range=1d&interval=1m`;

    try {
      const body = await fetchWithRetry(url);
      const batchQuotes = parseSparkResponse(body, nameMap);
      // Update cache with fresh results
      batchQuotes.forEach((q) => quoteCache.set(`${q.symbol}_TW`, { data: q, fetchedAt: Date.now() }));
      allQuotes.push(...batchQuotes);
    } catch (e: any) {
      console.error(`[fetchTWSEQuotes] batch ${i}-${i + SPARK_BATCH_SIZE} failed: ${e.message}`);
      // Fallback: serve stale cache for each symbol in this batch
      for (const s of batch) {
        const cached = quoteCache.get(`${s.symbol}_TW`);
        if (cached) {
          allQuotes.push({ ...cached.data, isStale: true, quoteStatus: "error", isFallbackCache: true });
        }
      }
    }

    // Brief pause between batches (only needed when > 50 symbols)
    if (i + SPARK_BATCH_SIZE < symbols.length) await sleep(300);
  }

  return allQuotes;
}

// ---------------------------------------------------------------------------
// US: Yahoo Finance Spark API — real-time quotes（取代 Perplexity Finance，確保盤中即時更新）
// ---------------------------------------------------------------------------

/**
 * Batch-fetch US stock quotes using Yahoo Finance spark API (same as TW).
 * This guarantees intraday real-time prices, pre-market, and post-market data.
 * Replaces Perplexity Finance for individual stock quotes (indices still use Finance API).
 */
async function fetchUSQuotesSpark(
  symbols: Array<{ symbol: string; name: string }>
): Promise<StockQuote[]> {
  if (symbols.length === 0) return [];

  const nameMap = new Map(symbols.map((s) => [s.symbol, s.name]));
  const BATCH_SIZE = 50;
  const allQuotes: StockQuote[] = [];

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const yahooSymbols = batch.map((s) => s.symbol).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(yahooSymbols)}&range=1d&interval=1m`;

    try {
      const body = await fetchWithRetry(url);
      const json = JSON.parse(body);
      const sparkResults: any[] = json.spark?.result ?? [];
      const now = Date.now();

      for (const r of sparkResults) {
        const symbol: string = r.symbol ?? "";
        const name = nameMap.get(symbol) ?? symbol;
        const resp = (r.response ?? [])[0];
        if (!resp) continue;
        const meta = resp.meta ?? {};

        // Yahoo Spark v7 不提供 preMarketPrice / postMarketPrice
        // 一律使用 regularMarketPrice：盤中=即時，盤後=收盤價，符合需求
        const price = +(meta.regularMarketPrice ?? 0).toFixed(2);
        const marketState: StockQuote["marketState"] =
          meta.marketState ? normalizeMarketState(meta.marketState) : "CLOSED";

        const prevClose = +(meta.previousClose ?? meta.chartPreviousClose ?? price).toFixed(2);
        const change    = +(price - prevClose).toFixed(2);
        const changePct = prevClose !== 0 ? +((change / prevClose) * 100).toFixed(2) : 0;
        const dataTimestamp = meta.regularMarketTime ?? Math.floor(now / 1000);
        const priceLabel = marketStateLabel(marketState);

        const usIsStale = isDataFromPreviousDay(dataTimestamp);
        allQuotes.push({
          symbol,
          name,
          price,
          change,
          changePercent: changePct,
          volume: meta.regularMarketVolume ?? 0,
          high:  +(meta.regularMarketDayHigh ?? price).toFixed(2),
          low:   +(meta.regularMarketDayLow  ?? price).toFixed(2),
          open:  +(meta.regularMarketOpen    ?? price).toFixed(2),
          prevClose,
          market: "US" as const,
          currency: "USD",
          dataTimestamp,
          fetchedAt: now,
          source: "Yahoo Finance",
          sourceUrl: `https://finance.yahoo.com/quote/${symbol}`,
          isStale: usIsStale,
          marketState,
          priceLabel,
          quoteStatus: usIsStale ? "stale" : "fresh",
        });
      }
    } catch (e: any) {
      console.error(`[fetchUSQuotesSpark] batch failed: ${e.message}`);
    }

    if (i + BATCH_SIZE < symbols.length) await sleep(300);
  }

  return allQuotes;
}

// ---------------------------------------------------------------------------
// TW: TWSE historical (afterTrading STOCK_DAY)
// ---------------------------------------------------------------------------

function rocToGreg(rocDate: string): string {
  // "115/04/01" -> "2026-04-01"
  const [y, m, d] = rocDate.split("/");
  return `${parseInt(y, 10) + 1911}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

async function fetchTWSEHistory(symbol: string, months = 3): Promise<HistoryResult> {
  const bars: CandleBar[] = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const dateParam = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`;
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${symbol}&date=${dateParam}&response=json`;

    try {
      await sleep(300); // be polite to TWSE
      const body = await fetchWithRetry(url);
      const json = JSON.parse(body);

      if (json.stat !== "OK" || !json.data) continue;

      // columns: 日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數
      for (const row of json.data) {
        const time = rocToGreg(row[0]);
        const open   = parseFloat(row[3].replace(/,/g, ""));
        const high   = parseFloat(row[4].replace(/,/g, ""));
        const low    = parseFloat(row[5].replace(/,/g, ""));
        const close  = parseFloat(row[6].replace(/,/g, ""));
        const volume = parseInt(row[1].replace(/,/g, ""), 10);
        if (isNaN(close)) continue;
        bars.push({ time, open, high, low, close, volume });
      }
    } catch {
      // Skip months that fail
    }
  }

  bars.sort((a, b) => a.time.localeCompare(b.time));

  return {
    symbol,
    bars,
    fetchedAt: Date.now(),
    source: "TWSE 臺灣證券交易所",
    sourceUrl: "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY",
    dataFrom: bars[0]?.time ?? "",
    dataTo: bars[bars.length - 1]?.time ?? "",
  };
}

// ---------------------------------------------------------------------------
// US: Perplexity Finance API — real-time quotes (batch, instant)
// ---------------------------------------------------------------------------

interface FinanceQuoteRow {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changesPercentage: number;
  volume: number;
  dayHigh: number;
  dayLow: number;
  open: number;
  previousClose: number;
  timestamp: string;   // ISO datetime "2026-04-15 14:21:59 UTC"
}

/**
 * Parse the markdown table rows from the finance_quotes content into typed rows.
 * The content has multiple ## sections, each with a markdown table.
 */
function parseFinanceQuotesContent(content: string): FinanceQuoteRow[] {
  const rows: FinanceQuoteRow[] = [];
  // Helper: strip commas before parsing (handles "6,992" and "36,615.37")
  const num = (s: string) => parseFloat(s?.replace(/,/g, "")) || 0;

  // Match table rows (lines starting with |, not header separators)
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.startsWith("| ")) continue;
    if (line.includes("---")) continue; // separator row
    if (line.includes("symbol") && line.includes("name")) continue; // header row

    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 13) continue;

    rows.push({
      symbol: cells[0],
      name: cells[1],
      timestamp: cells[2],
      price: num(cells[5]),
      change: num(cells[6]),
      changesPercentage: num(cells[7]),
      volume: num(cells[8]),
      dayHigh: num(cells[9]),
      dayLow: num(cells[10]),
      open: num(cells[11]),
      previousClose: num(cells[12]),
    });
  }
  return rows;
}

/**
 * Fetch US stock quotes via Perplexity Finance connector.
 * Splits into chunks of ≤15 symbols and runs chunks in parallel (max 4 concurrent).
 * Returns combined rows from all successful chunks.
 */
async function fetchFinanceQuotes(
  symbols: string[],
  fields: string[] = ["price", "change", "changesPercentage", "volume", "dayHigh", "dayLow", "open", "previousClose"]
): Promise<FinanceQuoteRow[]> {
  if (symbols.length === 0) return [];

  const CHUNK_SIZE = 15;
  const MAX_CONCURRENT = 4;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    chunks.push(symbols.slice(i, i + CHUNK_SIZE));
  }

  const allRows: FinanceQuoteRow[] = [];

  // Process chunks in parallel batches of MAX_CONCURRENT
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
    const parallelChunks = chunks.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      parallelChunks.map((chunk) =>
        new Promise<FinanceQuoteRow[]>((resolve, reject) => {
          try {
            const result = callExternalTool("finance", "finance_quotes", {
              ticker_symbols: chunk,
              fields,
            });
            const content = result?.result?.content ?? result?.content ?? "";
            resolve(parseFinanceQuotesContent(content));
          } catch (e) {
            reject(e);
          }
        })
      )
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        allRows.push(...r.value);
      } else {
        console.error(`Finance connector chunk error:`, (r.reason as any)?.message);
      }
    }
  }

  return allRows;
}

/**
 * Convert a FinanceQuoteRow to our StockQuote format.
 */
function financeRowToQuote(row: FinanceQuoteRow, market: "TW" | "US", overrideName?: string): StockQuote {
  const now = Date.now();
  // Parse timestamp like "2026-04-15 14:21:59 UTC"
  let dataTimestamp = Math.floor(now / 1000);
  try {
    const d = new Date(row.timestamp.replace(" UTC", "Z").replace(" ", "T"));
    if (!isNaN(d.getTime())) dataTimestamp = Math.floor(d.getTime() / 1000);
  } catch {}

  const finIsStale = isDataFromPreviousDay(dataTimestamp);
  return {
    symbol: row.symbol.replace("^", "").replace("=X", ""),
    yahooSymbol: row.symbol,
    name: overrideName ?? row.name,
    price: +row.price.toFixed(2),
    change: +row.change.toFixed(2),
    changePercent: +row.changesPercentage.toFixed(2),
    volume: Math.round(row.volume),
    high: +row.dayHigh.toFixed(2),
    low: +row.dayLow.toFixed(2),
    open: +row.open.toFixed(2),
    prevClose: +row.previousClose.toFixed(2),
    market,
    currency: market === "TW" ? "TWD" : "USD",
    dataTimestamp,
    fetchedAt: now,
    source: "Perplexity Finance",
    sourceUrl: `https://perplexity.ai/finance/${row.symbol.replace("^", "")}`,
    // Stale only if data is from a previous calendar day (TPE UTC+8)
    isStale: finIsStale,
    // Finance API 不區分狀態，統一補預設値（指數用）
    marketState: "REGULAR" as StockQuote["marketState"],
    priceLabel: "即時",
    quoteStatus: finIsStale ? "stale" : "fresh",
  };
}

// ---------------------------------------------------------------------------
// US: Yahoo Finance history (kept for OHLCV only)
// Also used for TW OTC ETFs (e.g. 00719B) with .TWO suffix, since TWSE STOCK_DAY only covers listed stocks.
// ---------------------------------------------------------------------------

/**
 * Fetch Yahoo Finance history by explicit date range (period1/period2 unix timestamps).
 * Use for targeted gap-fill instead of re-fetching the whole 1y/2y range.
 */
async function fetchYahooHistoryByDateRange(
  symbol: string,
  from: string,  // YYYY-MM-DD
  to: string,    // YYYY-MM-DD
  yahooSuffix = ""
): Promise<HistoryResult> {
  const tickerForYahoo = yahooSuffix ? `${symbol}.${yahooSuffix}` : symbol;
  const period1 = Math.floor(new Date(from + "T00:00:00Z").getTime() / 1000);
  const period2 = Math.floor(new Date(to   + "T23:59:59Z").getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerForYahoo)}?interval=1d&period1=${period1}&period2=${period2}`;
  const body = await historySemaphore.run(() => fetchWithRetry(url));
  const json = JSON.parse(body);
  if (!json.chart?.result?.[0]) {
    await new Promise(r => setTimeout(r, 1500));
    const body2 = await historySemaphore.run(() => fetchWithRetry(url));
    const json2 = JSON.parse(body2);
    if (!json2.chart?.result?.[0]) throw new Error(`No history for ${symbol} (${from}~${to})`);
    Object.assign(json, json2);
  }
  return parseYahooChartResult(symbol, tickerForYahoo, json);
}

/** Shared JSON-to-bars parser for both fetchYahooHistory and fetchYahooHistoryByDateRange */
function parseYahooChartResult(symbol: string, tickerForYahoo: string, json: any): HistoryResult {
  const result = json.chart.result[0];
  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};

  const bars: CandleBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i];
    if (close == null || isNaN(close) || close <= 0) continue;
    const open  = quote.open?.[i];
    const high  = quote.high?.[i];
    const low   = quote.low?.[i];
    bars.push({
      time: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
      open:   (open  != null && !isNaN(open)  && open  > 0) ? +open.toFixed(2)  : +close.toFixed(2),
      high:   (high  != null && !isNaN(high)  && high  > 0) ? +high.toFixed(2)  : +close.toFixed(2),
      low:    (low   != null && !isNaN(low)   && low   > 0) ? +low.toFixed(2)   : +close.toFixed(2),
      close:  +close.toFixed(2),
      volume: quote.volume?.[i] ?? 0,
    });
  }

  bars.sort((a, b) => a.time.localeCompare(b.time));
  const deduped: CandleBar[] = [];
  for (const b of bars) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === b.time) {
      deduped[deduped.length - 1] = b;
    } else {
      deduped.push(b);
    }
  }

  return {
    symbol,
    bars: deduped,
    fetchedAt: Date.now(),
    source: "Yahoo Finance",
    sourceUrl: `https://finance.yahoo.com/quote/${tickerForYahoo}/history`,
    dataFrom: deduped[0]?.time ?? "",
    dataTo: deduped[deduped.length - 1]?.time ?? "",
  };
}

async function fetchYahooHistory(symbol: string, range = "1y", yahooSuffix = ""): Promise<HistoryResult> {
  const tickerForYahoo = yahooSuffix ? `${symbol}.${yahooSuffix}` : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerForYahoo)}?interval=1d&range=${range}`;
  const body = await historySemaphore.run(() => fetchWithRetry(url));
  const json = JSON.parse(body);
  if (!json.chart?.result?.[0]) {
    await new Promise(r => setTimeout(r, 1500));
    const body2 = await historySemaphore.run(() => fetchWithRetry(url));
    const json2 = JSON.parse(body2);
    if (!json2.chart?.result?.[0]) throw new Error(`No history for ${symbol}`);
    Object.assign(json, json2);
  }
  return parseYahooChartResult(symbol, tickerForYahoo, json);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Trading calendar utilities
// ---------------------------------------------------------------------------

/**
 * US market fixed holidays (month is 1-based).
 * Variable holidays (MLK Day, Presidents Day, etc.) use "Nth weekday" rules.
 */
function isUSHoliday(d: Date): boolean {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  const day = d.getUTCDate();
  const dow = d.getUTCDay(); // 0=Sun

  // Helper: Nth weekday of a month (n=1 first, n=-1 last)
  const nthWeekday = (year: number, month: number, weekday: number, n: number): number => {
    if (n > 0) {
      const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      const offset = (weekday - first + 7) % 7;
      return 1 + offset + (n - 1) * 7;
    } else { // n=-1: last weekday
      const last = new Date(Date.UTC(year, month, 0));
      const diff = (last.getUTCDay() - weekday + 7) % 7;
      return last.getUTCDate() - diff;
    }
  };

  // Good Friday (2 days before Easter) — approximate via Anonymous Gregorian algorithm
  const easterDay = (year: number): Date => {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d2 = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d2 - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const month2 = Math.floor((h + l - 7 * mm + 114) / 31);
    const day2 = ((h + l - 7 * mm + 114) % 31) + 1;
    return new Date(Date.UTC(year, month2 - 1, day2));
  };
  const easter = easterDay(y);
  const goodFriday = new Date(easter.getTime() - 2 * 86400_000);
  if (m === goodFriday.getUTCMonth() + 1 && day === goodFriday.getUTCDate()) return true;

  // Fixed-date holidays (observed Mon if Sun, observed Fri if Sat)
  const observed = (hm: number, hd: number): boolean => {
    if (m !== hm) return false;
    if (day === hd) return true;
    if (dow === 1 && day === hd + 1) return true; // Sun holiday → Mon observed
    if (dow === 5 && day === hd - 1) return true; // Sat holiday → Fri observed
    return false;
  };
  if (observed(1, 1))  return true; // New Year's Day
  if (observed(7, 4))  return true; // Independence Day
  if (observed(11, 11)) return true; // Veterans Day (not NYSE, skip) — actually NYSE does NOT close; skip
  if (observed(12, 25)) return true; // Christmas

  // Variable weekday holidays
  if (m === 1  && day === nthWeekday(y, 1, 1, 3))  return true; // MLK Day (3rd Mon Jan)
  if (m === 2  && day === nthWeekday(y, 2, 1, 3))  return true; // Presidents Day (3rd Mon Feb)
  if (m === 5  && day === nthWeekday(y, 5, 1, -1)) return true; // Memorial Day (last Mon May)
  if (m === 6  && day === nthWeekday(y, 6, 1, 3))  return true; // Juneteenth observed Mon if needed
  if (observed(6, 19)) return true;                              // Juneteenth fixed
  if (m === 9  && day === nthWeekday(y, 9, 1, 1))  return true; // Labor Day (1st Mon Sep)
  if (m === 11 && day === nthWeekday(y, 11, 4, 4)) return true; // Thanksgiving (4th Thu Nov)

  return false;
}

/**
 * Taiwan market fixed holidays.
 * Lunar-based holidays (CNY) use an approximate fixed-window approach:
 * CNY closure is treated as Jan 20 – Feb 10 window check against known years.
 * For gap-detection purposes (2-day tolerance), a ±3 day error is acceptable.
 */
function isTWHoliday(d: Date): boolean {
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dow = d.getUTCDay();

  // Weekend (TWSE closed Sat/Sun)
  if (dow === 0 || dow === 6) return true;

  // Fixed national holidays
  const fixed: [number, number][] = [
    [1, 1],   // 元旦
    [2, 28],  // 228 和平紀念日
    [4, 4],   // 兒童節
    [4, 5],   // 清明節 (approximate)
    [5, 1],   // 勞動節
    [10, 10], // 國慶日
    [12, 25], // 行憲紀念日 (TWSE open — skip)
  ];
  for (const [hm, hd] of fixed) {
    if (m === hm && Math.abs(day - hd) <= 1) return true; // ±1 day buffer for observed
  }

  // Chinese New Year: approximate window (Jan 21 – Feb 10)
  // Covers the typical 7~10 day closure period across years
  if ((m === 1 && day >= 21) || (m === 2 && day <= 10)) return true;

  // Dragon Boat (around Jun 7±3), Mid-Autumn (around Sep 29±3)
  if (m === 6 && day >= 4  && day <= 10) return true; // 端午節 window
  if (m === 9 && day >= 26 && day <= 30) return true; // 中秋節 window
  if (m === 10 && day === 1)             return true; // 中秋節 window overflow

  return false;
}

/**
 * Returns true if the given date is a trading day for the market.
 */
function isTradingDay(dateStr: string, market: "TW" | "US"): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false; // weekend always closed
  return market === "TW" ? !isTWHoliday(d) : !isUSHoliday(d);
}

/**
 * Count trading days from fromDate (exclusive) to today (inclusive).
 * Returns 0 if fromDate is today or in the future.
 */
function countTradingDaysSince(fromDateStr: string, market: "TW" | "US"): number {
  const from = new Date(fromDateStr + "T00:00:00Z");
  const todayUTC = new Date(
    market === "TW"
      ? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) + "T00:00:00Z"
      : new Date().toISOString().slice(0, 10) + "T00:00:00Z"
  );
  let count = 0;
  const cursor = new Date(from.getTime() + 86400_000); // start day after fromDate
  while (cursor <= todayUTC) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (isTradingDay(dateStr, market)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Intraday today-bar injection
// ---------------------------------------------------------------------------

/**
 * Returns today's date string in YYYY-MM-DD format using Asia/Taipei (UTC+8).
 */
function todayTPE(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Build today's bar from a live quote and upsert it to DB (Method A).
 * This replaces the old in-memory-only approach so today's bar persists
 * across requests and is gradually updated until market close.
 */
async function injectTodayBar(
  result: HistoryResult,
  symbol: string,
  market: "TW" | "US"
): Promise<{ result: HistoryResult; isLive: boolean }> {
  const today = todayTPE();
  const lastBar = result.bars[result.bars.length - 1];

  // Already has today's bar in DB — no injection needed
  if (lastBar?.time === today) return { result, isLive: false };

  try {
    const cacheKey = `${symbol}_${market}`;
    let quote = quoteCache.get(cacheKey)?.data;

    if (!quote) {
      if (market === "TW") {
        const wl = [{ symbol, name: symbol }];
        const results = await fetchTWSEQuotes(wl);
        quote = results[0];
      } else {
        const results = await fetchUSQuotesSpark([{ symbol, name: symbol }]);
        quote = results[0];
      }
      if (quote) quoteCache.set(cacheKey, { data: quote, fetchedAt: Date.now() });
    }

    if (!quote) return { result, isLive: false };

    // Verify the quote is actually from today (not stale/weekend)
    const quoteDate = new Date(quote.dataTimestamp * 1000 + 8 * 3600_000).toISOString().slice(0, 10);
    if (quoteDate !== today) return { result, isLive: false };

    const todayBar: CandleBar = {
      time:   today,
      open:   quote.open   || lastBar?.close || quote.price,
      high:   quote.high   || quote.price,
      low:    quote.low    || quote.price,
      close:  quote.price,
      volume: quote.volume || 0,
    };

    // Write today's bar to DB (upsert — same date key can be overwritten on next refresh)
    await storage.upsertHistoricalPrices([{
      symbol, market,
      date:   today,
      open:   todayBar.open,
      high:   todayBar.high,
      low:    todayBar.low,
      close:  todayBar.close,
      volume: todayBar.volume,
      updatedAt: Date.now(),
    }]);

    const updatedResult: HistoryResult = {
      ...result,
      bars: [...result.bars, todayBar],
      dataTo: today,
      source: result.source + "（含今日盤中）",
    };

    return { result: updatedResult, isLive: true };
  } catch (e: any) {
    console.warn(`[injectTodayBar] ${symbol} skipped: ${e.message}`);
    return { result, isLive: false };
  }
}

/**
 * Check if DB already has sufficient 1-year base history for a symbol.
 * Does NOT query Yahoo — pure DB check.
 */
export async function ensureHistoricalCoverage(
  symbol: string,
  market: "TW" | "US"
): Promise<{ hasEnoughBaseHistory: boolean; latestStoredDate?: string; missingReason?: string }> {
  const latestStoredDate = await storage.getLatestHistoricalDate(symbol, market);
  if (!latestStoredDate) {
    return { hasEnoughBaseHistory: false, missingReason: "no data in DB" };
  }
  // Check oldest stored date to verify ~1 year coverage
  const dbRows = await storage.getHistoricalPrices(symbol, market);
  if (dbRows.length < 200) { // ~1 year ≈ 250 trading days; 200 is a safe floor
    return { hasEnoughBaseHistory: false, latestStoredDate, missingReason: `only ${dbRows.length} bars stored` };
  }
  return { hasEnoughBaseHistory: true, latestStoredDate };
}

/**
 * Initialize the 1-year base history pool for a brand-new symbol.
 * Called once when a symbol has no DB data.
 */
export async function initializeOneYearHistoryPool(
  symbol: string,
  market: "TW" | "US"
): Promise<void> {
  const suffix = market === "TW" ? yahooTWSuffix(symbol) : "";
  const todayStr = todayTPE();
  const now = Date.now();
  console.log(`[initializeOneYearHistoryPool] ${symbol}: fetching 1y base history...`);
  const fetched = await fetchYahooHistory(symbol, "1y", suffix);
  const barsForDB = fetched.bars.filter((b) => b.time <= todayStr);
  if (barsForDB.length > 0) {
    const rows: InsertHistoricalPrice[] = barsForDB.map((b) => ({
      symbol, market,
      date: b.time,
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume,
      updatedAt: now,
    }));
    await storage.upsertHistoricalPrices(rows);
    console.log(`[initializeOneYearHistoryPool] ${symbol}: stored ${rows.length} bars`);
  }
}

/**
 * Sync today's technical bar from a live quote directly (called by the 60s quote refresh).
 * Only writes when the market is open (REGULAR) or just closed (POST/CLOSED with today's data).
 */
export async function syncTodayTechnicalBarFromQuote(
  symbol: string,
  market: "TW" | "US",
  quote: StockQuote
): Promise<void> {
  try {
    const today = todayTPE();
    const quoteDate = new Date(quote.dataTimestamp * 1000 + 8 * 3600_000).toISOString().slice(0, 10);
    // Only write if the quote is actually from today
    if (quoteDate !== today) return;
    // Only write during REGULAR, POST, or CLOSED (final bar) — skip PRE to avoid early noise
    if (quote.marketState === "PRE" || quote.marketState === "PREPRE") return;
    // Fetch existing today bar from DB to carry forward open/high/low
    const dbRows = await storage.getHistoricalPrices(symbol, market);
    const existingToday = dbRows.find(r => r.date === today);
    const open   = existingToday?.open  ?? quote.open  ?? quote.price;
    const curHigh = existingToday?.high ?? quote.price;
    const curLow  = existingToday?.low  ?? quote.price;
    await storage.upsertHistoricalPrices([{
      symbol, market,
      date:   today,
      open:   +open.toFixed(2),
      high:   +Math.max(curHigh, quote.price, quote.high ?? 0).toFixed(2),
      low:    +Math.min(curLow,  quote.price, quote.low  ?? Infinity).toFixed(2),
      close:  +quote.price.toFixed(2),
      volume: quote.volume ?? existingToday?.volume ?? 0,
      updatedAt: Date.now(),
    }]);
  } catch (e: any) {
    console.warn(`[syncTodayTechnicalBarFromQuote] ${symbol}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// DB-first historical data sync
// ---------------------------------------------------------------------------

/**
 * DB-first strategy for historical data (v5.6.2):
 * 1. Check DB for existing bars
 * 2. No DB data → initializeOneYearHistoryPool (fetch 1y, write to DB)
 * 3. DB has data but gap detected (≥2 trading days since lastStoredDate)
 *    → targeted gap-fill using fetchYahooHistoryByDateRange (lastStoredDate+1 → yesterday)
 *    → never re-fetches the entire 1y/2y range for a small gap
 * 4. Return all DB rows sliced to requested range
 * 5. Inject today's live bar if market is open (also writes to DB via injectTodayBar)
 * 6. Graceful degradation: if Yahoo fails, serve whatever is in DB
 */
export async function getOrSyncHistoricalData(
  symbol: string,
  market: "TW" | "US",
  range = "3mo"
): Promise<HistoryResult> {
  const suffix = market === "TW" ? yahooTWSuffix(symbol) : "";
  const now = Date.now();
  const todayStr = todayTPE();

  // Step 1: Check DB coverage
  const lastStoredDate = await storage.getLatestHistoricalDate(symbol, market);

  let refreshAttempted = false;
  let refreshSucceeded = false;

  if (!lastStoredDate) {
    // No DB data at all — initialize 1-year base history pool
    refreshAttempted = true;
    try {
      await initializeOneYearHistoryPool(symbol, market);
      refreshSucceeded = true;
    } catch (e: any) {
      console.error(`[getOrSyncHistoricalData] ${symbol}: initial 1y fetch failed: ${e.message}`);
      return {
        symbol, bars: [], fetchedAt: now,
        source: "Yahoo Finance",
        sourceUrl: `https://finance.yahoo.com/quote/${symbol}`,
        dataFrom: "", dataTo: "",
        fromDatabase: false, refreshAttempted: true, refreshSucceeded: false,
        lastStoredDate: undefined,
      };
    }
  } else {
    // We have DB data — only fill gaps, never re-fetch the full year
    const tradingDaysGap = countTradingDaysSince(lastStoredDate, market);
    if (tradingDaysGap >= 1) {
      refreshAttempted = true;
      console.log(`[getOrSyncHistoricalData] ${symbol}: gap detected (${lastStoredDate}, ${tradingDaysGap} trading days ago), targeted gap-fill...`);
      try {
        // Calculate the day after lastStoredDate as gap start
        const gapFrom = new Date(lastStoredDate + "T00:00:00Z");
        gapFrom.setUTCDate(gapFrom.getUTCDate() + 1);
        const gapFromStr = gapFrom.toISOString().slice(0, 10);
        // Gap end: yesterday (don’t include today, today’s bar handled by injectTodayBar)
        const yesterday = new Date(Date.now() + 8 * 3600_000);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        yesterday.setUTCHours(0, 0, 0, 0);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);

        if (gapFromStr <= yesterdayStr) {
          const fetched = await fetchYahooHistoryByDateRange(symbol, gapFromStr, yesterdayStr, suffix);
          const barsForDB = fetched.bars.filter(
            (b) => b.time > lastStoredDate && b.time < todayStr
          );
          if (barsForDB.length > 0) {
            const rows: InsertHistoricalPrice[] = barsForDB.map((b) => ({
              symbol, market,
              date: b.time,
              open: b.open, high: b.high, low: b.low, close: b.close,
              volume: b.volume,
              updatedAt: now,
            }));
            await storage.upsertHistoricalPrices(rows);
          }
          console.log(`[getOrSyncHistoricalData] ${symbol}: gap-filled ${barsForDB.length} bars (${gapFromStr}→${yesterdayStr})`);
        }
        refreshSucceeded = true;
      } catch (e: any) {
        console.warn(`[getOrSyncHistoricalData] ${symbol}: gap fill failed: ${e.message}, serving DB data`);
        refreshSucceeded = false;
      }
    }
    // else: DB is up to date — read directly, no Yahoo query needed
  }

  // Step 2: Read from DB and slice to requested range
  const dbRows = await storage.getHistoricalPrices(symbol, market);
  const allBars = dbRowsToBars(dbRows);
  const slicedBars = sliceBarsByRange(allBars, range);

  // Step 3: Inject today's live bar (in-memory only, not written to DB)
  const baseResult: HistoryResult = {
    symbol,
    bars: slicedBars,
    fetchedAt: now,
    source: "Yahoo Finance",
    sourceUrl: `https://finance.yahoo.com/quote/${symbol}`,
    dataFrom: slicedBars[0]?.time ?? "",
    dataTo: slicedBars[slicedBars.length - 1]?.time ?? "",
    fromDatabase: true,
    refreshAttempted,
    refreshSucceeded,
    lastStoredDate: lastStoredDate ?? undefined,
  };

  const { result: withTodayBar, isLive } = await injectTodayBar(baseResult, symbol, market);

  // Cache with short TTL when live bar injected
  const cacheTtl = isLive ? QUOTE_TTL_MS : HISTORY_TTL_MS;
  const cacheKey = `hist_${symbol}_${market}_${range}`;
  historyCache.set(cacheKey, { data: withTodayBar, fetchedAt: now, ttl: cacheTtl });

  return withTodayBar;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getQuote(
  symbol: string,
  market: "TW" | "US",
  name: string
): Promise<StockQuote> {
  const cacheKey = `${symbol}_${market}`;
  const cached = quoteCache.get(cacheKey);
  if (isCacheValid(cached, QUOTE_TTL_MS)) return cached!.data;

  let quote: StockQuote;
  if (market === "TW") {
    const results = await fetchTWSEQuotes([{ symbol, name }]);
    if (!results.length) throw new Error(`No TWSE data for ${symbol}`);
    quote = results[0];
  } else {
    // US: Use Yahoo Finance Spark API（保證盤中即時更新）
    const results = await fetchUSQuotesSpark([{ symbol, name }]);
    if (!results.length) throw new Error(`No Yahoo Finance data for ${symbol}`);
    quote = results[0];
  }
  quoteCache.set(cacheKey, { data: quote, fetchedAt: Date.now() });
  return quote;
}

export async function getAllQuotes(
  watchlistSymbols?: Array<{ symbol: string; name: string; market: "TW" | "US" }>
): Promise<{
  quotes: StockQuote[];
  indices: StockQuote[];
  fetchedAt: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const fetchedAt = Date.now();
  const stocks = watchlistSymbols ?? WATCHLIST_STOCKS;

  // --- TW stocks: ONE batch call via Yahoo Finance spark API ---
  // spark API returns all symbols in a single HTTP request — no 429 risk.
  const twStocks = stocks.filter((s) => s.market === "TW");
  let twQuotes: StockQuote[] = [];

  // Check cache first — skip fetch if all symbols are fresh
  const cachedTW = twStocks.map((s) => quoteCache.get(`${s.symbol}_TW`));
  const allCached = cachedTW.every((c) => c && Date.now() - c.fetchedAt < QUOTE_TTL_MS);

  if (allCached) {
    twQuotes = cachedTW.map((c) => c!.data);
  } else {
    try {
      twQuotes = await fetchTWSEQuotes(twStocks);
      twQuotes.forEach((q) => quoteCache.set(`${q.symbol}_TW`, { data: q, fetchedAt: Date.now() }));
    } catch (e: any) {
      errors.push(`TW quotes: ${e.message}`);
      // Fallback: serve stale cache if available, mark as error
      twStocks.forEach((s) => {
        const c = quoteCache.get(`${s.symbol}_TW`);
        if (c) twQuotes.push({ ...c.data, isStale: true, quoteStatus: "error", isFallbackCache: true });
        else twQuotes.push({
          symbol: s.symbol, name: s.name, price: 0, change: 0, changePercent: 0,
          volume: 0, high: 0, low: 0, open: 0, prevClose: 0, market: "TW",
          currency: "TWD", dataTimestamp: 0, fetchedAt: Date.now(),
          source: "", sourceUrl: "", isStale: true,
          marketState: "CLOSED", priceLabel: "收盤",
          quoteStatus: "error", isFallbackCache: false,
        });
      });
    }
  }

  // --- US stocks: Yahoo Finance Spark API（個股即時，保證盤中更新）---
  const usStocks = stocks.filter((s) => s.market === "US");
  let usQuotes: StockQuote[] = [];

  try {
    const fetchedUS = await fetchUSQuotesSpark(usStocks);
    for (const q of fetchedUS) {
      usQuotes.push(q);
      quoteCache.set(`${q.symbol}_US`, { data: q, fetchedAt: Date.now() });
    }
    // Fallback for symbols not returned by Spark
    for (const s of usStocks) {
      if (!usQuotes.find((q) => q.symbol === s.symbol)) {
        const c = quoteCache.get(`${s.symbol}_US`);
        if (c) usQuotes.push({ ...c.data, isStale: true, quoteStatus: "error", isFallbackCache: true });
        else errors.push(`${s.symbol}: no data`);
      }
    }
  } catch (e: any) {
    errors.push(`US quotes (Yahoo Spark): ${e.message}`);
    for (const s of usStocks) {
      const c = quoteCache.get(`${s.symbol}_US`);
      if (c) usQuotes.push({ ...c.data, isStale: true, quoteStatus: "error", isFallbackCache: true });
    }
  }

  // --- Indices: Yahoo Finance Spark API（純 HTTP，Windows/Linux 皆可用）---
  let indexQuotes: StockQuote[] = [];

  try {
    // Build input list: use yahoo ticker (finance field) as symbol, store key for remapping
    const indexInputs = Object.entries(INDEX_SYMBOLS).map(([key, def]) => ({
      symbol: def.finance,  // Yahoo ticker e.g. "^TWII", "USDTWD=X", "^GSPC"
      name: def.name,
      _key: key,
    }));

    // USDTWD: Yahoo uses "USDTWD=X" ticker
    const sparkInputs = indexInputs.map((d) => ({
      symbol: d.symbol === "USDTWD" ? "USDTWD=X" : d.symbol,
      name: d.name,
    }));

    const fetched = await fetchUSQuotesSpark(sparkInputs);
    // fetchUSQuotesSpark preserves the input symbol in the returned quote
    const fetchedMap = new Map(fetched.map((q) => [q.symbol, q]));

    for (const { _key, symbol, name } of indexInputs) {
      const yahooSymbol = symbol === "USDTWD" ? "USDTWD=X" : symbol;
      const q = fetchedMap.get(yahooSymbol);
      if (q) {
        // Remap symbol back to our key (e.g. "^TWII" -> "TWII")
        const mapped: StockQuote = { ...q, symbol: _key, name, market: INDEX_SYMBOLS[_key].market };
        indexQuotes.push(mapped);
        quoteCache.set(`idx_${_key}`, { data: mapped, fetchedAt: Date.now() });
      } else {
        const c = quoteCache.get(`idx_${_key}`);
        if (c) indexQuotes.push({ ...c.data, isStale: true, quoteStatus: "error", isFallbackCache: true });
        else errors.push(`${name} (${yahooSymbol}): no data`);
      }
    }
  } catch (e: any) {
    errors.push(`Indices (Yahoo Spark): ${e.message}`);
    for (const [key] of Object.entries(INDEX_SYMBOLS)) {
      const c = quoteCache.get(`idx_${key}`);
      if (c) indexQuotes.push({ ...c.data, isStale: true, quoteStatus: "error", isFallbackCache: true });
    }
  }

  return {
    quotes: [...twQuotes, ...usQuotes],
    indices: indexQuotes,
    fetchedAt,
    errors,
  };
}

export async function getHistory(
  symbol: string,
  market: "TW" | "US",
  range = "3mo"
): Promise<HistoryResult> {
  const cacheKey = `hist_${symbol}_${market}_${range}`;
  const cached = historyCache.get(cacheKey);
  if (isCacheValid(cached, HISTORY_TTL_MS)) return { ...cached!.data, fromCache: true };

  // Use DB-first strategy: getOrSyncHistoricalData handles fetch, DB upsert, slicing, and today-bar injection
  return getOrSyncHistoricalData(symbol, market, range);
}

export async function getPortfolioQuotes(
  symbols: Array<{ symbol: string; name: string; market: "TW" | "US" }>
): Promise<StockQuote[]> {
  const twSymbols = symbols.filter((s) => s.market === "TW");
  const usSymbols = symbols.filter((s) => s.market === "US");

  const results: StockQuote[] = [];

  // TW: batch TWSE — with cache fallback on failure
  if (twSymbols.length > 0) {
    try {
      const twQuotes = await fetchTWSEQuotes(twSymbols);
      // Update cache with fresh data
      twQuotes.forEach((q) => quoteCache.set(`${q.symbol}_TW`, { data: q, fetchedAt: Date.now() }));
      results.push(...twQuotes);
      // Fallback for symbols not returned by TWSE
      for (const s of twSymbols) {
        if (!results.find((r) => r.symbol === s.symbol)) {
          const cached = quoteCache.get(`${s.symbol}_TW`);
          if (cached) results.push({ ...cached.data, isStale: true, quoteStatus: "error", isFallbackCache: true, name: s.name || cached.data.name });
        }
      }
    } catch (e: any) {
      console.error("getPortfolioQuotes TW error:", e.message);
      // Serve stale cache for all TW symbols
      for (const s of twSymbols) {
        const cached = quoteCache.get(`${s.symbol}_TW`);
        if (cached) results.push({ ...cached.data, isStale: true, quoteStatus: "error", isFallbackCache: true, name: s.name || cached.data.name });
      }
    }
  }

  // US: Yahoo Finance Spark API（個股即時，與 getAllQuotes 一致）
  if (usSymbols.length > 0) {
    try {
      const fetchedUS = await fetchUSQuotesSpark(usSymbols);
      for (const q of fetchedUS) {
        results.push(q);
        quoteCache.set(`${q.symbol}_US`, { data: q, fetchedAt: Date.now() });
      }
      // Fallback for symbols not returned
      for (const s of usSymbols) {
        if (!results.find((r) => r.symbol === s.symbol)) {
          const cached = quoteCache.get(`${s.symbol}_US`);
          if (cached) results.push({ ...cached.data, isStale: true, quoteStatus: "error", isFallbackCache: true, name: s.name || cached.data.name });
        }
      }
    } catch (e: any) {
      console.error("getPortfolioQuotes US error:", e.message);
      for (const s of usSymbols) {
        const cached = quoteCache.get(`${s.symbol}_US`);
        if (cached) results.push({ ...cached.data, isStale: true, quoteStatus: "error", isFallbackCache: true, name: s.name || cached.data.name });
      }
    }
  }

  return results;
}

export function getCacheStats() {
  return {
    quoteCacheSize: quoteCache.size,
    historyCacheSize: historyCache.size,
    quoteTTLSeconds: QUOTE_TTL_MS / 1000,
    historyTTLSeconds: HISTORY_TTL_MS / 1000,
  };
}
