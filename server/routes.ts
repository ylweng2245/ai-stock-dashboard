import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import * as XLSX from "xlsx";
import { storage } from "./storage";
import { insertHoldingSchema, insertAlertSchema, insertWatchlistSchema, type InsertTransaction } from "@shared/schema";
import Anthropic from "@anthropic-ai/sdk";
import { refreshAllIndicators, assembleMarketOverview, type MarketOverviewPayload } from "./marketOverviewService";
import { fetchIntradayYahoo, type IntradayResult } from "./marketIndicatorSources";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** Parse Excel date serial or string → "YYYY-MM-DD" */
function parseExcelDate(val: any): string {
  if (!val) return "";
  // Already a JS Date object (from xlsx with cellDates option)
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  // Taiwan format: "YYYY/MM/DD" or "YYYY/M/D"
  if (typeof val === "string") {
    const parts = val.trim().split("/");
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = String(parseInt(parts[1], 10)).padStart(2, "0");
      const d = String(parseInt(parts[2], 10)).padStart(2, "0");
      // Check if it's ROC year (e.g. 115 -> 2026)
      const year = y < 200 ? y + 1911 : y;
      return `${year}-${m}-${d}`;
    }
  }
  // Excel serial number
  if (typeof val === "number") {
    const date = XLSX.SSF.parse_date_code(val);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, "0");
      const d = String(date.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  return String(val);
}

/** Parse number string like "1,000" or "-1,801,539" → number */
function parseNum(val: any): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val.replace(/,/g, "")) || 0;
  return 0;
}
import {
  getAllQuotes,
  getHistory,
  getPortfolioQuotes,
  getCacheStats,
  WATCHLIST_STOCKS,
  PORTFOLIO_EXTRA,
} from "./stockService";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Seed default watchlist stocks into DB on startup (only adds symbols not already present)
  // NOTE: 2395 and LMT have been removed from WATCHLIST_STOCKS so they won't be re-seeded after deletion
  try {
    const defaults = [...WATCHLIST_STOCKS];
    await storage.seedDefaultWatchlist(defaults);
    console.log("[startup] Default watchlist seeded.");
  } catch (e: any) {
    console.warn("[startup] Seed warning:", e.message);
  }


  // ---- Holdings ----
  app.get("/api/holdings", async (_req, res) => {
    const items = await storage.getHoldings();
    res.json(items);
  });

  app.post("/api/holdings", async (req, res) => {
    const parsed = insertHoldingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const item = await storage.addHolding(parsed.data);
    res.json(item);
  });

  app.delete("/api/holdings/:id", async (req, res) => {
    await storage.deleteHolding(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ---- Alerts ----
  app.get("/api/alerts", async (_req, res) => {
    const items = await storage.getAlerts();
    res.json(items);
  });

  app.post("/api/alerts", async (req, res) => {
    const parsed = insertAlertSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const item = await storage.addAlert(parsed.data);
    res.json(item);
  });

  app.delete("/api/alerts/:id", async (req, res) => {
    await storage.deleteAlert(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ---- Watchlist ----
  app.get("/api/watchlist", async (_req, res) => {
    const items = await storage.getWatchlist();
    res.json(items);
  });

  app.post("/api/watchlist", async (req, res) => {
    const parsed = insertWatchlistSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const item = await storage.addToWatchlist(parsed.data);
    res.json(item);
  });

  app.delete("/api/watchlist/:id", async (req, res) => {
    await storage.removeFromWatchlist(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // PATCH /api/watchlist/reorder — drag-and-drop reorder by swapping sortOrder
  app.patch("/api/watchlist/reorder", async (req, res) => {
    try {
      const { dragId, dropId } = req.body as { dragId: number; dropId: number };
      if (!dragId || !dropId || dragId === dropId) return res.json({ ok: true, noChange: true });

      const all = await storage.getWatchlist(); // sorted by sortOrder
      const dragItem = all.find((w) => w.id === dragId);
      const dropItem = all.find((w) => w.id === dropId);
      if (!dragItem || !dropItem) return res.status(404).json({ error: "item not found" });

      // Swap sort orders between drag and drop items
      await storage.updateWatchlistOrder(dragItem.id, dropItem.sortOrder);
      await storage.updateWatchlistOrder(dropItem.id, dragItem.sortOrder);

      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Real-time Stock Data ----

  /**
   * GET /api/quotes
   * Returns live quotes for all watchlist stocks + market indices.
   * Merges default watchlist with user DB watchlist (deduped).
   * TW data from TWSE, US data from Perplexity Finance API.
   */
  app.get("/api/quotes", async (_req, res) => {
    try {
      // Only use DB watchlist — deleted items must NOT be brought back from hardcoded defaults
      const dbWatchlist = await storage.getWatchlist();
      const mergedSymbols: Array<{ symbol: string; name: string; market: "TW" | "US" }> = dbWatchlist.map(
        (item) => ({ symbol: item.symbol, name: item.name, market: item.market as "TW" | "US" })
      );

      const result = await getAllQuotes(mergedSymbols);
      res.json({
        ...result,
        dataSource: "TWSE + Perplexity Finance",
        dataSourceUrl: "https://perplexity.ai/finance",
      });
    } catch (e: any) {
      console.error("getAllQuotes error:", e.message);
      res.status(500).json({ error: "Failed to fetch stock quotes", detail: e.message });
    }
  });

  /**
   * GET /api/history/:symbol?market=TW|US&range=1mo|3mo|6mo|1y
   * Returns OHLCV candlestick bars.
   * TW: TWSE historical. US: Yahoo Finance OHLCV.
   */
  app.get("/api/history/:symbol", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const market = (req.query.market as "TW" | "US") || "TW";
      const range = (req.query.range as string) || "3mo";

      const validRanges = ["1mo", "3mo", "6mo", "1y", "2y"];
      const safeRange = validRanges.includes(range) ? range : "3mo";

      const result = await getHistory(symbol, market, safeRange);
      res.json({
        ...result,
        dataSource: market === "TW" ? "TWSE 臺灣證券交易所" : "Yahoo Finance",
        dataSourceUrl: market === "TW" ? "https://www.twse.com.tw" : "https://finance.yahoo.com",
      });
    } catch (e: any) {
      console.error("getHistory error:", e.message);
      res.status(500).json({ error: "Failed to fetch history", detail: e.message });
    }
  });

  /**
   * GET /api/portfolio-quotes
   * Returns live quotes for all portfolio + extra symbols.
   */
  app.get("/api/portfolio-quotes", async (_req, res) => {
    try {
      const dbWatchlist = await storage.getWatchlist();
      // Also include all active portfolio holdings (computed from transactions)
      const txSymbols = await storage.getPortfolioSymbols();
      const seen = new Set<string>();
      const allSymbols: Array<{ symbol: string; name: string; market: "TW" | "US" }> = [];

      for (const item of [...PORTFOLIO_EXTRA, ...dbWatchlist, ...txSymbols]) {
        const key = `${item.symbol}_${item.market}`;
        if (!seen.has(key)) {
          seen.add(key);
          allSymbols.push({ symbol: item.symbol, name: item.name, market: item.market as "TW" | "US" });
        }
      }

      const quotes = await getPortfolioQuotes(allSymbols);
      res.json({
        quotes,
        fetchedAt: Date.now(),
        dataSource: "TWSE + Perplexity Finance",
      });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch portfolio quotes", detail: e.message });
    }
  });

  /**
   * GET /api/health
   */
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      cache: getCacheStats(),
    });
  });

  // ---- AI Chat ----
  app.post("/api/ai/chat", async (req, res) => {
    try {
      const { symbol, name, price, change, market, question } = req.body;

      const client = new Anthropic();

      const systemPrompt = `你是一位專業的台灣投資分析師 AI 助手，擅長台股與美股分析。
你的回答必須使用繁體中文。
你正在分析的股票是：${symbol} (${name})
目前價格：${market === "TW" ? "NT$" : "$"}${price}
今日漲跌：${change >= 0 ? "+" : ""}${change}%
市場：${market === "TW" ? "台灣證券交易所" : "美國股市"}

請提供專業、具體且實用的分析。包含數據、圖表描述和明確建議。
使用清晰的段落和列點格式。回答長度適中（200-400字）。`;

      const message = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: question }],
        system: systemPrompt,
      });

      const textContent = message.content.find((c: any) => c.type === "text");
      res.json({ response: textContent ? (textContent as any).text : "無法取得回應" });
    } catch (error: any) {
      console.error("AI chat error:", error.message);
      res.status(500).json({ error: "AI service unavailable" });
    }
  });

  // ---- Transactions ----

  /** GET /api/transactions — all raw trade records */
  app.get("/api/transactions", async (_req, res) => {
    const rows = await storage.getTransactions();
    res.json(rows);
  });

  /** GET /api/transactions/:symbol?market=TW|US — trades for a specific stock */
  app.get("/api/transactions/:symbol", async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const market = (req.query.market as string) || "TW";
    const rows = await storage.getTransactionsBySymbol(symbol, market);
    res.json(rows);
  });

  /**
   * POST /api/transactions/import
   * Accepts a multipart/form-data Excel file, parses both sheets
   * using a unified column spec (row 1 = header, row 2+ = data):
   *   A=交易日期  B=股票代號  C=股票名稱  D=交易類別  E=成交價格  F=成交股數  G=總成本
   */

  // ── Unified helpers ────────────────────────────────────────────────────────
  function normalizeTradeSide(val: any): "buy" | "sell" | null {
    const s = String(val ?? "").trim().toLowerCase();
    if (!s) return null;
    if (s === "買" || s === "买" || s === "買進" || s === "买进" || s === "buy" || s === "b") return "buy";
    if (s === "賣" || s === "卖" || s === "賣出" || s === "卖出" || s === "sell" || s === "s") return "sell";
    return null;
  }

  function inferSideFromTotalCost(totalCost: number): "buy" | "sell" | null {
    if (totalCost < 0) return "buy";
    if (totalCost > 0) return "sell";
    return null;
  }

  function parseUnifiedTransactionSheet(
    sheet: XLSX.WorkSheet,
    market: "TW" | "US"
  ): InsertTransaction[] {
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: null });
    const result: InsertTransaction[] = [];
    // Row 0 = header, data starts at row 1
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0] || !row[1]) continue;
      const dateStr = parseExcelDate(row[0]);
      if (!dateStr) continue;
      const rawSymbol = String(row[1]).trim();
      const symbol = market === "US" ? rawSymbol.toUpperCase() : rawSymbol;
      const name = row[2] ? String(row[2]).trim() : symbol;
      const sideFromCol  = normalizeTradeSide(row[3]);  // col D: 交易類別 (primary)
      const price        = parseNum(row[4]);              // col E: 成交價格
      const shares       = Math.abs(parseNum(row[5]));   // col F: 成交股數
      const totalCost    = parseNum(row[6]);              // col G: 總成本
      const sideFromCost = inferSideFromTotalCost(totalCost); // fallback
      // Warn if col D and totalCost disagree
      if (sideFromCol && sideFromCost && sideFromCol !== sideFromCost) {
        console.warn(
          `[import] side mismatch ${market} ${symbol} ${dateStr}: ` +
          `tradeType=${sideFromCol}, totalCost=${totalCost} (inferred=${sideFromCost})`
        );
      }
      const side = sideFromCol ?? sideFromCost;
      if (!symbol || !price || !shares || !side) continue;
      result.push({
        tradeDate: dateStr,
        symbol,
        name,
        market,
        side,
        shares,
        price,
        totalCost,
        currency: market === "TW" ? "TWD" : "USD",
      });
    }
    return result;
  }
  // ── End helpers ─────────────────────────────────────────────────────────────

  app.post("/api/transactions/import", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const imported: InsertTransaction[] = [];

      // Sheet 1 → TW, Sheet 2 → US (by index; also try by name as fallback)
      const twSheet = wb.Sheets[wb.SheetNames[0]];
      if (twSheet) imported.push(...parseUnifiedTransactionSheet(twSheet, "TW"));

      const usSheet = wb.Sheets[wb.SheetNames[1]];
      if (usSheet) imported.push(...parseUnifiedTransactionSheet(usSheet, "US"));

      if (imported.length === 0) {
        return res.status(400).json({
          error: "Failed to import Excel",
          detail: "No valid transaction rows found. Please check column order: A=日期 B=代號 C=名稱 D=交易類別 E=價格 F=股數 G=總成本",
        });
      }

      // Replace all existing transactions
      await storage.clearAllTransactions();
      const count = await storage.importTransactions(imported);

      // Also clear old manual holdings (replaced by computed view)
      await storage.clearAllHoldings();

      res.json({ ok: true, imported: count, tw: imported.filter(r => r.market === "TW").length, us: imported.filter(r => r.market === "US").length });
    } catch (e: any) {
      console.error("[import] error:", e.message, e.stack);
      res.status(500).json({ error: "Failed to import Excel", detail: e.message });
    }
  });

  /**
   * GET /api/portfolio/computed
   * Computes current holdings, average cost, realized/unrealized P&L from transaction DB.
   * Requires current prices from /api/portfolio-quotes (called separately by frontend).
   * Returns holdings array + realized gains array.
   */
  app.get("/api/portfolio/computed", async (_req, res) => {
    try {
      const txns = await storage.getTransactions();

      // Group by symbol+market
      type PositionMap = Record<string, {
        symbol: string; name: string; market: string; currency: string;
        lots: Array<{ shares: number; price: number; cost: number }>; // open lots (FIFO)
        realizedGain: number; // cumulative realized gain in native currency
        totalBuyCost: number; // total buy cost (abs value)
        totalBuyShares: number;
      }>;

      const positions: PositionMap = {};

      for (const tx of txns) {
        const key = `${tx.symbol}_${tx.market}`;
        if (!positions[key]) {
          positions[key] = {
            symbol: tx.symbol, name: tx.name, market: tx.market, currency: tx.currency,
            lots: [], realizedGain: 0, totalBuyCost: 0, totalBuyShares: 0,
          };
        }
        const pos = positions[key];

        if (tx.side === "buy") {
          pos.lots.push({ shares: tx.shares, price: tx.price, cost: Math.abs(tx.totalCost) });
          pos.totalBuyCost += Math.abs(tx.totalCost);
          pos.totalBuyShares += tx.shares;
        } else {
          // FIFO sell: consume oldest lots first
          let toSell = tx.shares;
          const proceedsPerShare = tx.totalCost / tx.shares; // positive per share
          while (toSell > 0 && pos.lots.length > 0) {
            const lot = pos.lots[0];
            const consume = Math.min(lot.shares, toSell);
            const costBasis = (lot.cost / lot.shares) * consume;
            const proceeds = Math.abs(tx.totalCost) * (consume / tx.shares);
            pos.realizedGain += proceeds - costBasis;
            lot.shares -= consume;
            lot.cost -= costBasis;
            toSell -= consume;
            if (lot.shares <= 0.0001) pos.lots.shift();
          }
        }
      }

      // Build output
      const holdings = Object.values(positions).map((pos) => {
        const currentShares = pos.lots.reduce((s, l) => s + l.shares, 0);
        const currentCost = pos.lots.reduce((s, l) => s + l.cost, 0);
        const avgCost = currentShares > 0 ? currentCost / currentShares : 0;
        return {
          symbol: pos.symbol,
          name: pos.name,
          market: pos.market,
          currency: pos.currency,
          shares: Math.round(currentShares * 10000) / 10000,
          avgCost: Math.round(avgCost * 100) / 100,
          totalCost: Math.round(currentCost * 100) / 100,
          realizedGain: Math.round(pos.realizedGain * 100) / 100,
          totalBuyCost: Math.round(pos.totalBuyCost * 100) / 100,
          totalBuyShares: pos.totalBuyShares,
        };
      }).filter(h => h.shares > 0.0001 || h.realizedGain !== 0);

      res.json(holdings);
    } catch (e: any) {
      console.error("[computed portfolio] error:", e.message);
      res.status(500).json({ error: "Failed to compute portfolio", detail: e.message });
    }
  });

  // ─── Market Overview ────────────────────────────────────────────────────
  // Cache the last assembled payload to avoid re-fetching on every request.
  // Background refresh runs on first request and then every 5 minutes.
  interface OverviewCacheEntry { payload: MarketOverviewPayload; fetchedAt: number; }
  let overviewCache: OverviewCacheEntry | null = null;
  let overviewRefreshing = false;

  async function runOverviewRefresh(): Promise<void> {
    try {
      await refreshAllIndicators();
      const payload = await assembleMarketOverview();
      overviewCache = { payload, fetchedAt: Date.now() };
    } catch (e: any) {
      console.error("[market-overview] refresh error:", e.message);
    } finally {
      overviewRefreshing = false;
    }
  }

  async function getOverviewPayload() {
    const now = Date.now();
    const CACHE_TTL = 5 * 60 * 1000; // 5 min
    // Return fresh cache immediately
    if (overviewCache && now - overviewCache.fetchedAt < CACHE_TTL) {
      return overviewCache.payload;
    }
    if (!overviewRefreshing) {
      overviewRefreshing = true;
      // Run refresh non-blocking so first call still gets stale data quickly
      void runOverviewRefresh();
    }
    // If we have any cache (even stale), return it immediately
    if (overviewCache) return overviewCache.payload;
    // First ever call — must wait for data
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (!overviewRefreshing || overviewCache !== null) {
          clearInterval(poll);
          resolve();
        }
      }, 200);
    });
    // TS narrows overviewCache inside async callback — cast to bypass
    const cached = overviewCache as OverviewCacheEntry | null;
    return cached ? cached.payload : null;
  }

  app.get("/api/market-overview", async (_req, res) => {
    try {
      const payload = await getOverviewPayload();
      if (!payload) return res.status(503).json({ error: "Market data not yet available" });
      res.json(payload);
    } catch (e: any) {
      console.error("[market-overview] route error:", e.message);
      res.status(500).json({ error: "Failed to load market overview", detail: e.message });
    }
  });

  // Warm up cache on server start (non-blocking)
  getOverviewPayload().catch(() => {});

  // ─── Intraday Chart Data (短 TTL 2-minute cache) ────────────────────────
  // Symbol map: taiex → ^TWII, djia → ^DJI, sp500 → ^GSPC, nasdaq → ^IXIC, sox → ^SOX
  const INTRADAY_SYMBOL_MAP: Record<string, string> = {
    taiex: "^TWII",
    djia:  "^DJI",
    sp500: "^GSPC",
    nasdaq: "^IXIC",
    sox:   "^SOX",
  };

  interface IntraCache { result: IntradayResult; fetchedAt: number; }
  const intradayCache = new Map<string, IntraCache>();
  const INTRADAY_TTL = 2 * 60 * 1000; // 2 minutes

  app.get("/api/intraday/:key", async (req, res) => {
    const key = req.params.key as string;
    const symbol = INTRADAY_SYMBOL_MAP[key];
    if (!symbol) return res.status(404).json({ error: `Unknown intraday key: ${key}` });

    const now = Date.now();
    const cached = intradayCache.get(key);
    if (cached && now - cached.fetchedAt < INTRADAY_TTL) {
      return res.json(cached.result);
    }

    try {
      const result = await fetchIntradayYahoo(symbol);
      intradayCache.set(key, { result, fetchedAt: now });
      res.json(result);
    } catch (e: any) {
      console.error(`[intraday] ${key} error:`, e.message);
      // Return stale cache if available
      if (cached) return res.json(cached.result);
      res.status(503).json({ error: `Intraday data unavailable for ${key}` });
    }
  });

  return httpServer;
}
