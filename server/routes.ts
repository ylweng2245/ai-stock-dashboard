import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import * as XLSX from "xlsx";
import { storage, sqlite } from "./storage";
import { insertHoldingSchema, insertAlertSchema, insertWatchlistSchema, type InsertTransaction, type InsertAnalystTarget } from "@shared/schema";
// Anthropic SDK removed — AI Insights now uses prompt builder (zero API cost)
import { refreshAllIndicators, assembleMarketOverview, type MarketOverviewPayload } from "./marketOverviewService";
import { fetchIntradayYahoo, fetchVIX, fetchUS10Y, fetchFearGreed, fetchYahooLivePrice, type IntradayResult } from "./marketIndicatorSources";
import { generateAllDigests, saveDigestData, saveMacroSentiment, type DigestSyncItem } from "./newsDigestService";
import { runPrediction } from "./mlPredictionService";
import { ensurePrediction, getSchedulerStatus, triggerSweepNow, triggerForceAll } from "./predictionScheduler";
import { buildPersonalPositionState, generatePersonalAdvice, DEFAULT_STRATEGY } from "./personalAdviceService";
import { buildAnalystConsensusFeatures } from "./analystConsensusService";

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
  syncTodayTechnicalBarFromQuote,
  initializeOneYearHistoryPool,
  backfillHistoryTo2Years,
} from "./stockService";
import { getOrFetchFundamentals } from "./fundamentalService";

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

  // PATCH /api/alerts/:id/reset — reset triggered state
  app.patch("/api/alerts/:id/reset", async (req, res) => {
    sqlite.prepare(`UPDATE alerts SET triggered=0, last_checked_at=? WHERE id=?`)
      .run(Date.now(), parseInt(req.params.id));
    res.json({ ok: true });
  });

  // GET /api/earnings-calendar — next earnings date for all watchlist symbols
  app.get("/api/earnings-calendar", async (_req, res) => {
    try {
      const wl = await storage.getWatchlist();
      const rows: Array<{symbol:string;name:string;market:string;earningsDate:string|null;epsEstimate:number|null;revenueEstimate:number|null}> = [];
      for (const item of wl) {
        const fd = sqlite.prepare(
          `SELECT calendar_json FROM fundamental_data WHERE symbol=? AND market=? LIMIT 1`
        ).get(item.symbol, item.market) as { calendar_json: string } | undefined;
        if (!fd) { rows.push({ symbol: item.symbol, name: item.name, market: item.market, earningsDate: null, epsEstimate: null, revenueEstimate: null }); continue; }
        const cal = JSON.parse(fd.calendar_json || "{}");
        rows.push({
          symbol: item.symbol,
          name: item.name,
          market: item.market,
          earningsDate: cal.earningsDate ?? null,
          epsEstimate: cal.epsEstimate ?? null,
          revenueEstimate: cal.revenueEstimate ?? null,
        });
      }
      // Sort: symbols with upcoming earnings first
      const today = new Date().toISOString().slice(0, 10);
      rows.sort((a, b) => {
        if (!a.earningsDate && !b.earningsDate) return 0;
        if (!a.earningsDate) return 1;
        if (!b.earningsDate) return -1;
        const aFuture = a.earningsDate >= today;
        const bFuture = b.earningsDate >= today;
        if (aFuture && !bFuture) return -1;
        if (!aFuture && bFuture) return 1;
        return a.earningsDate.localeCompare(b.earningsDate);
      });
      res.json({ rows, fetchedAt: Date.now() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/portfolio/performance — NAV curve from transactions + historical prices
  app.get("/api/portfolio/performance", async (_req, res) => {
    try {
      // Exclude 00719B from all calculations
      const EXCLUDE_SYMBOLS = new Set(['00719B']);

      const txns = (sqlite.prepare(
        `SELECT trade_date, symbol, market, side, shares, price, total_cost, currency FROM transactions ORDER BY trade_date ASC`
      ).all() as Array<{trade_date:string;symbol:string;market:string;side:string;shares:number;price:number;total_cost:number;currency:string}>)
        .filter((t: any) => !EXCLUDE_SYMBOLS.has(t.symbol));
      // Note: SQLite returns snake_case columns; total_cost is negative for buys

      if (!txns.length) return res.json({ curve: [] });

      const firstDate = txns[0].trade_date;
      const today = new Date().toISOString().slice(0, 10);

      // Get USD/TWD rate history from market_indicators
      const fxRows = sqlite.prepare(
        `SELECT date, value FROM market_indicators WHERE indicator_key='USDTWD' AND date >= ? ORDER BY date ASC`
      ).all(firstDate) as Array<{date:string;value:number}>;
      const fxMap = new Map<string, number>(fxRows.map((r: any) => [r.date, r.value]));
      let lastFx = 31.0;

      // Collect all unique symbols with their market
      const symMarketMap = new Map<string, string>();
      for (const t of txns) symMarketMap.set(t.symbol, t.market);
      const symbols = [...symMarketMap.keys()];

      // Auto-fetch history for symbols with no/insufficient data in DB
      // (e.g. portfolio symbols not in watchlist: US stocks, non-watchlist TW ETFs)
      const fetchPromises: Promise<void>[] = [];
      for (const sym of symbols) {
        const market = symMarketMap.get(sym) as "TW" | "US";
        const count = (sqlite.prepare(
          `SELECT COUNT(*) as c FROM historical_prices WHERE symbol=? AND market=?`
        ).get(sym, market) as any)?.c ?? 0;
        if (count < 50) {
          console.log(`[performance] ${sym} has only ${count} bars — fetching 2y history via yfinance`);
          fetchPromises.push(
            initializeOneYearHistoryPool(sym, market).catch((e: any) =>
              console.warn(`[performance] yfinance fetch failed for ${sym}: ${e.message}`)
            )
          );
        }
      }
      if (fetchPromises.length > 0) {
        await Promise.all(fetchPromises);
        console.log(`[performance] Done auto-fetching ${fetchPromises.length} symbols`);
      }

      // Get price history for all symbols (after auto-fetch)
      const priceHistory = new Map<string, Map<string, number>>();
      for (const sym of symbols) {
        const rows = sqlite.prepare(
          `SELECT date, close FROM historical_prices WHERE symbol=? AND date >= ? ORDER BY date ASC`
        ).all(sym, firstDate) as Array<{date:string;close:number}>;
        priceHistory.set(sym, new Map(rows.map((r: any) => [r.date, r.close])));
      }

      // Build all trading dates between firstDate and today
      const allDates: string[] = [];
      const d = new Date(firstDate);
      const end = new Date(today);
      while (d <= end) {
        const ds = d.toISOString().slice(0, 10);
        allDates.push(ds);
        d.setDate(d.getDate() + 1);
      }

      // Build last-known price map per symbol (forward-fill)
      const lastKnownPrice = new Map<string, number>();

      // Compute portfolio NAV per day
      // Mirrors portfolio/computed logic exactly:
      //   TW stocks: FIFO lots
      //   US stocks: Weighted Average Cost
      //   Dividends: directly added to realizedPnl (native currency → TWD)
      type PosState = {
        shares: number;       // current holding shares
        holdingCost: number;  // current holding cost (native currency)
        currency: string;
        market: string;
        lots: Array<{ shares: number; unitCost: number }>; // FIFO lots (TW)
      };
      const holdings = new Map<string, PosState>();
      let realizedPnlTwd = 0;  // cumulative realized PnL in TWD (incl dividends)
      let txIdx = 0;
      let realizedCostBasisTwd = 0; // cumulative cost basis of all sold shares (TWD)
      const curve: Array<{date:string;nav:number;holdingCost:number;realizedPnl:number;realizedCostBasis:number}> = [];

      for (const date of allDates) {
        const fx = fxMap.get(date) ?? lastFx;

        // Apply transactions on this date
        while (txIdx < txns.length && txns[txIdx].trade_date === date) {
          const t = txns[txIdx];
          const key = t.symbol;
          if (!holdings.has(key)) {
            holdings.set(key, { shares: 0, holdingCost: 0, currency: t.currency, market: t.market, lots: [] });
          }
          const pos = holdings.get(key)!;
          const isTW = t.market === 'TW';
          const absCost = Math.abs(t.total_cost); // native currency

          if (t.side === 'buy') {
            if (isTW) {
              pos.lots.push({ shares: t.shares, unitCost: absCost / t.shares });
              pos.holdingCost += absCost;
            } else {
              pos.holdingCost += absCost;
            }
            pos.shares += t.shares;
          } else if (t.side === 'dividend') {
            // Dividend: add to realized (total_cost is positive for dividends)
            const divTwd = t.currency === 'USD' ? t.total_cost * fx : t.total_cost;
            realizedPnlTwd += divTwd;
          } else {
            // Sell
            const proceeds = absCost; // native
            if (isTW) {
              let rem = t.shares; let cb = 0;
              while (rem > 0.0001 && pos.lots.length > 0) {
                const lot = pos.lots[0];
                if (lot.shares <= rem + 0.0001) {
                  cb += lot.unitCost * lot.shares; rem -= lot.shares;
                  pos.shares -= lot.shares; pos.holdingCost -= lot.unitCost * lot.shares;
                  pos.lots.shift();
                } else {
                  cb += lot.unitCost * rem;
                  pos.shares -= rem; pos.holdingCost -= lot.unitCost * rem;
                  lot.shares -= rem; rem = 0;
                }
              }
              realizedPnlTwd += proceeds - cb;
              realizedCostBasisTwd += cb; // TWD
            } else {
              const avgNow = pos.shares > 0 ? pos.holdingCost / pos.shares : 0;
              const cb = avgNow * t.shares;
              const pnlNative = proceeds - cb;
              realizedPnlTwd += pnlNative * fx;
              realizedCostBasisTwd += cb * fx; // USD → TWD
              pos.holdingCost -= cb;
              pos.shares -= t.shares;
            }
            if (pos.shares < 0.0001) { pos.shares = 0; pos.holdingCost = 0; pos.lots = []; }
          }
          txIdx++;
        }
        if (fxMap.has(date)) lastFx = fxMap.get(date)!;

        // Update last-known prices (forward-fill)
        for (const [sym, symPrices] of priceHistory) {
          const p = symPrices.get(date);
          if (p != null) lastKnownPrice.set(sym, p);
        }

        // Compute NAV (market value) and holdingCost in TWD
        let nav = 0;
        let holdingCostTwd = 0;
        let hasAnyHolding = false;
        for (const [sym, pos] of holdings) {
          if (pos.shares <= 0.0001) continue;
          const price = lastKnownPrice.get(sym) ?? null;
          if (price === null) continue;
          hasAnyHolding = true;
          const valueNative = price * pos.shares;
          const costNative = pos.holdingCost;
          const fxRate = pos.currency === 'USD' ? (fxMap.get(date) ?? lastFx) : 1;
          nav += valueNative * fxRate;
          holdingCostTwd += costNative * fxRate;
        }
        // Include day even if fully sold out (hasAnyHolding=false) as long as
        // there has been at least one transaction (realizedCostBasis > 0)
        if (!hasAnyHolding && realizedCostBasisTwd === 0) continue;
        curve.push({ date, nav, holdingCost: holdingCostTwd, realizedPnl: realizedPnlTwd, realizedCostBasis: realizedCostBasisTwd });
      }

      res.json({ curve });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/market-anomaly — detect VIX spike, SPY volume surge, 10Y yield jump
  app.get("/api/market-anomaly", async (_req, res) => {
    try {
      const anomalies: Array<{type:string;label:string;value:number;threshold:number;severity:'warning'|'critical';date:string}> = [];

      // VIX spike: latest vs 10-day avg
      const vixRows = sqlite.prepare(
        `SELECT date, value FROM market_indicators WHERE indicator_key='vix' ORDER BY date DESC LIMIT 15`
      ).all() as Array<{date:string;value:number}>;
      if (vixRows.length >= 5) {
        const latest = vixRows[0];
        const avg10 = vixRows.slice(1, 11).reduce((s: number, r: any) => s + r.value, 0) / Math.min(vixRows.length - 1, 10);
        const spikePct = ((latest.value - avg10) / avg10) * 100;
        if (spikePct > 15) anomalies.push({ type:'vix_spike', label:'VIX 急升', value: latest.value, threshold: avg10, severity: spikePct > 30 ? 'critical' : 'warning', date: latest.date });
      }

      // Four major indices: single-day drop detection (aligned with K-line display)
      const indexDropConfigs = [
        { symbol: '^GSPC', market: 'INDEX', label: 'S&P 500 單日大跌', type: 'gspc_drop', threshold: -2.0, critical: -3.5 },
        { symbol: '^DJI',  market: 'INDEX', label: '道瓊工業單日大跌',    type: 'dji_drop',  threshold: -2.0, critical: -3.5 },
        { symbol: '^IXIC', market: 'INDEX', label: 'Nasdaq 單日大跌',  type: 'ixic_drop', threshold: -2.5, critical: -4.0 },
      ];
      for (const cfg of indexDropConfigs) {
        const rows = sqlite.prepare(
          `SELECT date, close, volume FROM historical_prices WHERE symbol=? AND market=? ORDER BY date DESC LIMIT 5`
        ).all(cfg.symbol, cfg.market) as Array<{date:string;close:number;volume:number}>;
        if (rows.length >= 2) {
          const dropPct = ((rows[0].close - rows[1].close) / rows[1].close) * 100;
          if (dropPct < cfg.threshold) anomalies.push({ type: cfg.type, label: cfg.label, value: dropPct, threshold: cfg.threshold, severity: dropPct < cfg.critical ? 'critical' : 'warning', date: rows[0].date });
        }
      }

      // S&P 500 volume surge (broad market participation signal)
      const gspcRows = sqlite.prepare(
        `SELECT date, close, volume FROM historical_prices WHERE symbol='^GSPC' AND market='INDEX' ORDER BY date DESC LIMIT 25`
      ).all() as Array<{date:string;close:number;volume:number}>;
      if (gspcRows.length >= 5) {
        const latest = gspcRows[0];
        const avg20vol = gspcRows.slice(1, 21).reduce((s: number, r: any) => s + r.volume, 0) / Math.min(gspcRows.length - 1, 20);
        const volRatio = latest.volume / (avg20vol || 1);
        if (volRatio > 1.8) anomalies.push({ type:'gspc_volume', label:'S&P 500 成交量異常', value: latest.volume, threshold: avg20vol, severity: volRatio > 2.5 ? 'critical' : 'warning', date: latest.date });
      }

      // SOX (Philadelphia Semiconductor) single-day drop + volume surge
      const soxAnomalyRows = sqlite.prepare(
        `SELECT date, close, high, low, volume FROM historical_prices WHERE symbol='^SOX' AND market='INDEX' ORDER BY date DESC LIMIT 25`
      ).all() as Array<{date:string;close:number;volume:number}>;
      if (soxAnomalyRows.length >= 2) {
        const latest = soxAnomalyRows[0];
        const prev = soxAnomalyRows[1];
        const dropPct = ((latest.close - prev.close) / prev.close) * 100;
        if (dropPct < -3.0) anomalies.push({ type:'sox_drop', label:'SOX 半導體大跌', value: dropPct, threshold: -3.0, severity: dropPct < -5 ? 'critical' : 'warning', date: latest.date });
        // SOX volume surge
        if (soxAnomalyRows.length >= 5) {
          const avg20vol = soxAnomalyRows.slice(1, 21).reduce((s: number, r: any) => s + r.volume, 0) / Math.min(soxAnomalyRows.length - 1, 20);
          const volRatio = latest.volume / (avg20vol || 1);
          if (volRatio > 1.8) anomalies.push({ type:'sox_volume', label:'SOX 成交量異常', value: latest.volume, threshold: avg20vol, severity: volRatio > 2.5 ? 'critical' : 'warning', date: latest.date });
        }
      }

      // 10Y yield jump: latest vs 5-day avg
      const yieldRows = sqlite.prepare(
        `SELECT date, value FROM market_indicators WHERE indicator_key='10y_yield' ORDER BY date DESC LIMIT 10`
      ).all() as Array<{date:string;value:number}>;
      if (yieldRows.length >= 3) {
        const latest = yieldRows[0];
        const avg5 = yieldRows.slice(1, 6).reduce((s: number, r: any) => s + r.value, 0) / Math.min(yieldRows.length - 1, 5);
        const jump = latest.value - avg5;
        if (jump > 0.15) anomalies.push({ type:'yield_jump', label:'10Y殖利率急升', value: latest.value, threshold: avg5, severity: jump > 0.3 ? 'critical' : 'warning', date: latest.date });
      }

      res.json({ anomalies, checkedAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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
    // Initialize 1-year history pool for the new symbol (fire-and-forget)
    const market = (parsed.data.market ?? "TW") as "TW" | "US";
    initializeOneYearHistoryPool(parsed.data.symbol, market).catch((e: any) =>
      console.warn(`[watchlist POST] history init failed for ${parsed.data.symbol}: ${e.message}`)
    );
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

      // Sync today's technical bar to DB for each watchlist stock (fire-and-forget)
      // This keeps the today row updated every 60s during market hours
      const allQuotes = [...(result.tw ?? []), ...(result.us ?? [])];
      for (const q of allQuotes) {
        if (q.symbol && q.market) {
          syncTodayTechnicalBarFromQuote(q.symbol, q.market as "TW" | "US", q).catch(() => {});
        }
      }

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
   * POST /api/history/resync-all
   * Force re-fetch 1 year of history for ALL watchlist symbols.
   * Runs sequentially to avoid rate limiting.
   */
  app.post("/api/history/resync-all", async (_req, res) => {
    try {
      const dbWatchlist = await storage.getWatchlist();
      const unique = new Map<string, "TW" | "US">();
      for (const item of dbWatchlist) {
        unique.set(`${item.symbol}_${item.market}`, item.market as "TW" | "US");
      }
      const results: { symbol: string; market: string; bars: number; error?: string }[] = [];
      for (const [key, market] of unique) {
        const symbol = key.split("_")[0];
        try {
          console.log(`[resync-all] ${symbol} (${market})...`);
          await storage.deleteHistoricalPrices(symbol, market);
          await initializeOneYearHistoryPool(symbol, market);
          const rows = await storage.getHistoricalPrices(symbol, market);
          results.push({ symbol, market, bars: rows.length });
        } catch (e: any) {
          console.error(`[resync-all] ${symbol} failed: ${e.message}`);
          results.push({ symbol, market, bars: 0, error: e.message });
        }
      }
      res.json({ ok: true, total: results.length, results });
    } catch (e: any) {
      res.status(500).json({ error: "Resync-all failed", detail: e.message });
    }
  });

  /**
   * POST /api/history/:symbol/resync
   * Force re-fetch 1 year of history from Yahoo and overwrite DB.
   * Use to correct historical data that was captured as intraday snapshots.
   */
  app.post("/api/history/:symbol/resync", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const market = (req.query.market as "TW" | "US") || "US";
      console.log(`[resync] Force re-fetching 1y history for ${symbol} (${market})...`);
      // 1. Wipe existing historical data for this symbol
      await storage.deleteHistoricalPrices(symbol, market);
      // 2. Re-fetch full 1-year pool from Yahoo
      await initializeOneYearHistoryPool(symbol, market);
      // 3. Return new DB row count
      const rows = await storage.getHistoricalPrices(symbol, market);
      console.log(`[resync] ${symbol}: resynced ${rows.length} bars`);
      res.json({ ok: true, symbol, market, bars: rows.length });
    } catch (e: any) {
      console.error("[resync] error:", e.message);
      res.status(500).json({ error: "Resync failed", detail: e.message });
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

  /** Build rich context string from DB for a given symbol */
  function buildStockContext(symbol: string, market: string, price: number, change: number, name: string): string {
    const cur = market === "TW" ? "NT" : "$";
    const lines: string[] = [];

    lines.push(`【基本資訊】`);
    lines.push(`股票代碼：${symbol}（${name}）| 市場：${market === "TW" ? "台灣證券交易所" : "美國股市"}`);
    lines.push(`現價：${cur}${price.toLocaleString()} | 今日漲跌：${change >= 0 ? "+" : ""}${change.toFixed(2)}%`);

    // ── 持倉資訊（從 transactions 計算，與 portfolio/computed 相同邏輯）──
    try {
      const txns = sqlite.prepare(
        `SELECT side, shares, total_cost FROM transactions WHERE symbol=? AND market=? ORDER BY trade_date ASC`
      ).all(symbol, market) as { side: string; shares: number; total_cost: number }[];

      const isTW = market === "TW";
      let holdingShares = 0;
      let holdingCost = 0;
      let realizedGain = 0;
      const lots: { shares: number; unitCost: number }[] = [];

      for (const tx of txns) {
        if (tx.side === "buy") {
          const cost = Math.abs(tx.total_cost);
          holdingShares += tx.shares;
          holdingCost += cost;
          if (isTW) lots.push({ shares: tx.shares, unitCost: cost / tx.shares });
        } else if (tx.side === "sell") {
          const proceeds = Math.abs(tx.total_cost);
          if (isTW) {
            let rem = tx.shares; let cb = 0;
            while (rem > 0.0001 && lots.length > 0) {
              const lot = lots[0];
              if (lot.shares <= rem + 0.0001) { cb += lot.unitCost * lot.shares; rem -= lot.shares; holdingShares -= lot.shares; holdingCost -= lot.unitCost * lot.shares; lots.shift(); }
              else { cb += lot.unitCost * rem; holdingShares -= rem; holdingCost -= lot.unitCost * rem; lot.shares -= rem; rem = 0; }
            }
            realizedGain += proceeds - cb;
          } else {
            const avgNow = holdingShares > 0 ? holdingCost / holdingShares : 0;
            const cb = avgNow * tx.shares;
            realizedGain += proceeds - cb;
            holdingShares -= tx.shares;
            holdingCost -= cb;
          }
          if (holdingShares < 0.0001) { holdingShares = 0; holdingCost = 0; }
        } else if (tx.side === "dividend") {
          realizedGain += tx.total_cost;
        }
      }

      if (holdingShares > 0.0001) {
        const avgCost = holdingCost / holdingShares;
        const pnl = ((price - avgCost) / avgCost * 100);
        const currentValue = price * holdingShares;
        lines.push(`\n【持倉】`);
        lines.push(`持有股數：${holdingShares.toFixed(2)} | 平均成本：${cur}${avgCost.toFixed(2)} | 現值：${cur}${currentValue.toFixed(0)} | 未實現損益：${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`);
        if (realizedGain !== 0) lines.push(`已實現損益：${cur}${realizedGain.toFixed(2)}`);
      } else {
        lines.push(`\n【持倉】`);
        lines.push(`目前未持有此股票`);
      }
    } catch { /* no holding */ }

    // ── 基本面 ──
    try {
      const fd = sqlite.prepare(
        `SELECT info_json, quarterly_income_json, eps_history_json, calendar_json FROM fundamental_data WHERE symbol=? AND market=? LIMIT 1`
      ).get(symbol, market) as { info_json: string; quarterly_income_json: string; eps_history_json: string; calendar_json: string } | undefined;
      if (fd) {
        const info  = JSON.parse(fd.info_json || "{}");
        const cal   = JSON.parse(fd.calendar_json || "{}");
        // qInc from cron: { date, fiscalYear, fiscalQuarter, revenue, grossProfit, netIncome, basicEPS, dilutedEPS }
        const qInc  = JSON.parse(fd.quarterly_income_json || "[]") as any[];

        function toQLabel(q: any): string {
          if (q.fiscalYear && q.fiscalQuarter) return `${q.fiscalYear}Q${q.fiscalQuarter}`;
          const d = new Date(q.date || "");
          if (!isNaN(d.getTime())) return `${d.getFullYear()}Q${Math.ceil((d.getMonth()+1)/3)}`;
          return "—";
        }

        lines.push(`\n【基本面】`);
        if (info.pe_ratio)    lines.push(`本益比(PE)：${info.pe_ratio}x`);
        if (info.eps_ttm)     lines.push(`EPS(TTM)：${cur}${info.eps_ttm}`);
        if (info.revenue_growth_yoy !== undefined) lines.push(`最新季營收 YoY：${(info.revenue_growth_yoy * 100).toFixed(1)}%`);
        if (info.gross_margin !== undefined)       lines.push(`毛利率(TTM)：${(info.gross_margin * 100).toFixed(1)}%`);
        if (info.market_cap)  lines.push(`市值：${cur}${(info.market_cap / 1e9).toFixed(1)}B`);
        if (info.sector)      lines.push(`產業：${info.sector}`);
        if (cal.earnings_date) lines.push(`下次財報日：${cal.earnings_date}`);

        // Latest 3 quarters with full metrics
        if (qInc.length >= 1) {
          lines.push(`近期季報（最新在上）：`);
          const recent = qInc.slice(0, 3);
          for (let i = 0; i < recent.length; i++) {
            const q    = recent[i];
            const prev = recent[i + 1];
            const label = toQLabel(q);
            const rev   = q.revenue ?? q.totalRevenue;
            const gp    = q.grossProfit;
            const ni    = q.netIncome;
            const eps   = q.basicEPS ?? q.dilutedEPS;
            const revB  = rev  != null ? `${cur}${(rev / 1e9).toFixed(2)}B`  : "N/A";
            const epsStr = eps != null ? `${cur}${eps.toFixed(2)}` : "N/A";
            const gmStr  = (rev && gp   != null) ? `毛利率${((gp / rev) * 100).toFixed(1)}%`  : "";
            const nmStr  = (rev && ni   != null) ? `淨利率${((ni / rev) * 100).toFixed(1)}%`  : "";
            const qoqStr = (prev && rev != null && (prev.revenue ?? prev.totalRevenue) != null)
              ? `QoQ${(((rev - (prev.revenue ?? prev.totalRevenue)) / (prev.revenue ?? prev.totalRevenue)) * 100).toFixed(1)}%` : "";
            // YoY: compare with same quarter last year (index i+4)
            const yoyQ  = qInc[i + 4];
            const yoyStr = (yoyQ && rev != null && (yoyQ.revenue ?? yoyQ.totalRevenue) != null)
              ? `YoY${(((rev - (yoyQ.revenue ?? yoyQ.totalRevenue)) / (yoyQ.revenue ?? yoyQ.totalRevenue)) * 100).toFixed(1)}%` : "";
            const parts = [revB, epsStr !== "N/A" ? `EPS${epsStr}` : "", gmStr, nmStr, qoqStr, yoyStr].filter(Boolean);
            lines.push(`  ${label}: ${parts.join(" | ")}`);
          }
        }
      }
    } catch { /* no fundamentals */ }

    // ── 分析師共識 ──
    try {
      const analysts = sqlite.prepare(
        `SELECT rating_category, score, target_price, institution, analyst_date
         FROM analyst_targets WHERE symbol=? AND market=?
         ORDER BY analyst_date DESC LIMIT 10`
      ).all(symbol, market) as { rating_category: string; score: number; target_price: number; institution: string; analyst_date: string }[];
      if (analysts.length > 0) {
        const avgTarget = analysts.reduce((s, a) => s + a.target_price, 0) / analysts.length;
        const buys   = analysts.filter(a => a.score >= 4).length;
        const holds  = analysts.filter(a => a.score === 3).length;
        const sells  = analysts.filter(a => a.score <= 2).length;
        const upside = ((avgTarget - price) / price * 100);
        lines.push(`\n【分析師共識（近10筆）】`);
        lines.push(`買進：${buys} | 持有：${holds} | 賣出：${sells} | 平均目標價：${cur}${avgTarget.toFixed(2)}（潛在空間：${upside >= 0 ? "+" : ""}${upside.toFixed(1)}%）`);
        // Most recent 3 ratings
        const recent3 = analysts.slice(0, 3).map(a => `${a.institution}(${a.rating_category} ${a.analyst_date})`).join("、");
        lines.push(`最新評級：${recent3}`);
      }
    } catch { /* no analysts */ }

    // ── ML 預測 ──
    try {
      const pred = sqlite.prepare(
        `SELECT meta_json, run_at FROM modelpredictions
         WHERE symbol=? AND market=?
         ORDER BY created_at DESC LIMIT 1`
      ).get(symbol, market) as { meta_json: string; run_at: string } | undefined;
      if (pred) {
        const meta = JSON.parse(pred.meta_json || "{}");
        // horizons stored as JSON string in horizonsJson field
        const horizons: Record<string, any> = meta.horizonsJson
          ? JSON.parse(meta.horizonsJson)
          : {};
        lines.push(`\n【ML 預測（${pred.run_at.slice(0,10)}）】`);
        const displayHorizons = [5, 10, 20];
        let hasPredData = false;
        for (const h of displayHorizons) {
          const hp = horizons[String(h)];
          if (hp) {
            hasPredData = true;
            const ret = hp.medianReturn ?? 0;
            const prob = hp.upProbability ?? 0;
            lines.push(`${h}日預測：${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% | 上漲機率：${(prob * 100).toFixed(0)}%`);
          }
        }
        if (!hasPredData) lines.push(`（預測資料待更新）`);
        const featCount = Array.isArray(meta.featuresUsed) ? meta.featuresUsed.length : (meta.featureCount ?? "N/A");
        const weights = meta.ensembleWeights;
        const wStr = weights ? ` HGB:${weights.hgb} LGB:${weights.lgb} RF:${weights.rf}` : "";
        if (meta.modelVersion) lines.push(`模型：${meta.modelVersion}（特徵數：${featCount}）${wStr}`);
      }
    } catch { /* no prediction */ }

    // ── 新聞情緒 ──
    try {
      const digest = sqlite.prepare(
        `SELECT digest_date, sentiment_label, ai_takeaway, source_count
         FROM daily_news_digest WHERE ticker=?
         ORDER BY digest_date DESC LIMIT 3`
      ).all(symbol) as { digest_date: string; sentiment_label: string; ai_takeaway: string; source_count: number }[];
      if (digest.length > 0) {
        lines.push(`\n【近期新聞情緒】`);
        for (const d of digest) {
          lines.push(`${d.digest_date}：${d.sentiment_label}（${d.source_count} 則）— ${d.ai_takeaway?.slice(0, 80) ?? ""}`);
        }
      }
      // Latest news titles
      const latestDigest = digest[0];
      if (latestDigest) {
        const sources = sqlite.prepare(
          `SELECT article_title FROM daily_news_sources
           WHERE digest_id = (SELECT id FROM daily_news_digest WHERE ticker=? ORDER BY digest_date DESC LIMIT 1)
           ORDER BY sort_order LIMIT 5`
        ).all(symbol) as { article_title: string }[];
        if (sources.length > 0) {
          lines.push(`最新新聞標題：`);
          sources.forEach((s, i) => lines.push(`  ${i + 1}. ${s.article_title}`));
        }
      }
    } catch { /* no digest */ }

    // ── 大盤情緒 ──
    try {
      const fg = sqlite.prepare(
        `SELECT value, meta_json FROM market_indicators
         WHERE indicator_key='fear_greed' ORDER BY date DESC LIMIT 1`
      ).get() as { value: number; meta_json: string } | undefined;
      if (fg) {
        let fgMeta: any = {}; try { fgMeta = JSON.parse(fg.meta_json || "{}"); } catch { fgMeta = { classification: fg.meta_json ?? "" }; }
        lines.push(`\n【大盤情緒】`);
        lines.push(`Fear & Greed Index：${fg.value}（${fgMeta.classification ?? ""}）`);
      }
      const macro = sqlite.prepare(
        `SELECT value, date FROM market_indicators
         WHERE indicator_key='macro_sentiment' ORDER BY date DESC LIMIT 1`
      ).get() as { value: number; date: string } | undefined;
      if (macro) {
        lines.push(`Macro 情緒分數（SPY+QQQ）：${macro.value.toFixed(2)}（${macro.date}）`);
      }
    } catch { /* no market indicators */ }

    // ── 板塊相對強弱 ──
    try {
      const sectorRow = sqlite.prepare(
        `SELECT meta_json FROM modelpredictions
         WHERE symbol=? AND market=? ORDER BY created_at DESC LIMIT 1`
      ).get(symbol, market) as { meta_json: string } | undefined;
      if (sectorRow) {
        const m = JSON.parse(sectorRow.meta_json || "{}");
        const features = m.featureValues || m.features;
        if (features) {
          const rs5  = features["sector_rs_5d"];
          const rs20 = features["sector_rs_20d"];
          if (rs5 !== undefined || rs20 !== undefined) {
            lines.push(`\n【板塊相對強弱】`);
            if (rs5  !== undefined) lines.push(`sector_rs_5d：${rs5 >= 0 ? "+" : ""}${(rs5 * 100).toFixed(2)}%`);
            if (rs20 !== undefined) lines.push(`sector_rs_20d：${rs20 >= 0 ? "+" : ""}${(rs20 * 100).toFixed(2)}%`);
          }
        }
      }
    } catch { /* no sector data */ }

    return lines.join("\n");
  }

  /**
   * Build a full-portfolio context for macro-level prompts.
   * Includes: every active holding with shares / avg cost / current price /
   * market value / unrealized return / portfolio weight, plus portfolio totals
   * and macro sentiment data.
   */
  function buildPortfolioContext(prices: Record<string, number>): string {
    const lines: string[] = [];

    // ── Compute all holdings from transactions ──
    try {
      const txns = sqlite.prepare(
        `SELECT symbol, market, name, side, shares, total_cost, currency
         FROM transactions ORDER BY trade_date ASC`
      ).all() as { symbol: string; market: string; name: string; side: string; shares: number; total_cost: number; currency: string }[];

      type Pos = {
        symbol: string; market: string; name: string; currency: string;
        holdingShares: number; holdingCost: number; realizedGain: number;
        lots: { shares: number; unitCost: number }[];
      };
      const posMap = new Map<string, Pos>();

      for (const tx of txns) {
        const key = `${tx.symbol}_${tx.market}`;
        if (!posMap.has(key)) {
          posMap.set(key, {
            symbol: tx.symbol, market: tx.market, name: tx.name,
            currency: tx.currency || (tx.market === "TW" ? "TWD" : "USD"),
            holdingShares: 0, holdingCost: 0, realizedGain: 0, lots: [],
          });
        }
        const pos = posMap.get(key)!;
        const isTW = tx.market === "TW";
        if (tx.side === "buy") {
          const cost = Math.abs(tx.total_cost);
          pos.holdingShares += tx.shares;
          pos.holdingCost += cost;
          if (isTW) pos.lots.push({ shares: tx.shares, unitCost: cost / tx.shares });
        } else if (tx.side === "sell") {
          const proceeds = Math.abs(tx.total_cost);
          if (isTW) {
            let rem = tx.shares; let cb = 0;
            while (rem > 0.0001 && pos.lots.length > 0) {
              const lot = pos.lots[0];
              if (lot.shares <= rem + 0.0001) { cb += lot.unitCost * lot.shares; rem -= lot.shares; pos.holdingShares -= lot.shares; pos.holdingCost -= lot.unitCost * lot.shares; pos.lots.shift(); }
              else { cb += lot.unitCost * rem; pos.holdingShares -= rem; pos.holdingCost -= lot.unitCost * rem; lot.shares -= rem; rem = 0; }
            }
            pos.realizedGain += proceeds - cb;
          } else {
            const avgNow = pos.holdingShares > 0 ? pos.holdingCost / pos.holdingShares : 0;
            const cb = avgNow * tx.shares;
            pos.realizedGain += proceeds - cb;
            pos.holdingShares -= tx.shares;
            pos.holdingCost -= cb;
          }
          if (pos.holdingShares < 0.0001) { pos.holdingShares = 0; pos.holdingCost = 0; }
        } else if (tx.side === "dividend") {
          pos.realizedGain += tx.total_cost;
        }
      }

      // Filter active holdings (shares > 0)
      const active = [...posMap.values()].filter(p => p.holdingShares > 0.0001);
      if (active.length === 0) {
        lines.push("【投資組合】");
        lines.push("目前無持倉");
      } else {
        // Compute current values
        type HRow = {
          symbol: string; market: string; name: string; cur: string;
          shares: number; avgCost: number; currentPrice: number;
          marketValue: number; unrealizedPct: number;
        };
        const rows: HRow[] = active.map(p => {
          const cur = p.market === "TW" ? "NT" : "$";
          const avgCost = p.holdingCost / p.holdingShares;
          const currentPrice = prices[`${p.symbol}_${p.market}`] ?? prices[p.symbol] ?? avgCost;
          const marketValue = currentPrice * p.holdingShares;
          const unrealizedPct = ((currentPrice - avgCost) / avgCost) * 100;
          return { symbol: p.symbol, market: p.market, name: p.name, cur, shares: p.holdingShares, avgCost, currentPrice, marketValue, unrealizedPct };
        });

        // Total portfolio value (USD-only for weight calculation; TW in TWD)
        const totalUSDValue = rows.filter(r => r.market === "US").reduce((s, r) => s + r.marketValue, 0);
        const totalTWValue  = rows.filter(r => r.market === "TW").reduce((s, r) => s + r.marketValue, 0);
        const totalAllValue = rows.reduce((s, r) => s + (r.market === "US" ? r.marketValue : r.marketValue / 32), 0); // rough USD equiv for weight

        lines.push(`【我的投資組合】`);
        lines.push(`持倉數量：${rows.length} 檔｜美股合計：$${totalUSDValue.toFixed(0)}｜台股合計：NT${totalTWValue.toFixed(0)}`);
        lines.push(``);
        lines.push(`持倉明細（依市值排序）：`);
        const sorted = [...rows].sort((a, b) => {
          const aUSD = a.market === "US" ? a.marketValue : a.marketValue / 32;
          const bUSD = b.market === "US" ? b.marketValue : b.marketValue / 32;
          return bUSD - aUSD;
        });
        for (const r of sorted) {
          const weightBase = r.market === "US" ? totalUSDValue : totalTWValue;
          const weight = weightBase > 0 ? (r.marketValue / weightBase * 100).toFixed(1) : "N/A";
          const retStr = `${r.unrealizedPct >= 0 ? "+" : ""}${r.unrealizedPct.toFixed(1)}%`;
          lines.push(
            `  ${r.market} ${r.symbol}（${r.name}）` +
            `｜${r.shares.toFixed(2)}股` +
            `｜均成本${r.cur}${r.avgCost.toFixed(2)}` +
            `｜現價${r.cur}${r.currentPrice.toLocaleString()}` +
            `｜市值${r.cur}${r.marketValue.toFixed(0)}` +
            `｜報酬${retStr}` +
            `｜占${r.market}倉${weight}%`
          );
        }
      }
    } catch (e) {
      lines.push(`【投資組合】`);
      lines.push(`（資料讀取失敗）`);
    }

    // ── 大盤情緒 ──
    try {
      const fg = sqlite.prepare(
        `SELECT value, meta_json FROM market_indicators
         WHERE indicator_key='fear_greed' ORDER BY date DESC LIMIT 1`
      ).get() as { value: number; meta_json: string } | undefined;
      if (fg) {
        let fgMeta: any = {}; try { fgMeta = JSON.parse(fg.meta_json || "{}"); } catch { fgMeta = { classification: fg.meta_json ?? "" }; }
        lines.push(`\n【大盤情緒】`);
        lines.push(`Fear & Greed Index：${fg.value}（${fgMeta.classification ?? ""}）`);
      }
      const macro = sqlite.prepare(
        `SELECT value, date FROM market_indicators
         WHERE indicator_key='macro_sentiment' ORDER BY date DESC LIMIT 1`
      ).get() as { value: number; date: string } | undefined;
      if (macro) {
        lines.push(`Macro 情緒分數（SPY+QQQ）：${macro.value.toFixed(2)}（${macro.date}）`);
      }
    } catch { /* ignore */ }

    // ── 板塊 ETF 相對強弱（最近 1 個月走勢）──
    try {
      const etfSymbols = ["SOXX", "XLI", "XBI", "CIBR", "ARKX", "XLU"];
      const etfRows: string[] = [];
      for (const etf of etfSymbols) {
        const bars = sqlite.prepare(
          `SELECT date, close FROM historical_prices
           WHERE symbol=? AND market='US'
           ORDER BY date DESC LIMIT 21`
        ).all(etf) as { date: string; close: number }[];
        if (bars.length >= 2) {
          const latest = bars[0].close;
          const oldest = bars[bars.length - 1].close;
          const ret = ((latest - oldest) / oldest * 100).toFixed(1);
          etfRows.push(`${etf}：${parseFloat(ret) >= 0 ? "+" : ""}${ret}%`);
        }
      }
      if (etfRows.length > 0) {
        lines.push(`\n【板塊 ETF 近 1 月漲跌】`);
        lines.push(etfRows.join("｜"));
      }
    } catch { /* ignore */ }

    return lines.join("\n");
  }

  /** Build a ready-to-paste Perplexity prompt from DB context + question intent */
  function buildUserPrompt(ctx: string, questionType: string, customQuestion?: string): string {
    const searchInstructions: Record<string, string> = {
      // ── 買賣決策類 ──
      trade_enter: `請搜尋該公司最近 7 天最新新聞與競爭對手動態。
結合上述數據，分析現在是否適合買進建立持股：目前估值是否合理（PE、目標價潛在空間）？技術面是否在相對低點或突破位置？ML預測方向是否支持？給出建議進場區間與分批策略。`,

      trade_profit: `請搜尋該公司最近 7 天最新新聞與競爭對手動態。
結合上述持倉成本與未實現損益，分析是否應獲利了結：目前距分析師目標價還有多少空間？估值是否已過高？ML預測短期有無回調風險？建議全出、部分了結還是續抱？`,

      trade_dip: `請搜尋該公司最近 7 天最新新聞，確認下跌原因是消息面還是基本面惡化。
結合上述數據，分析現在是否適合低接：下跌是暫時性還是趨勢性？技術面支撐在哪？基本面是否仍健全？給出建議低接區間與風險提示。`,

      trade_average: `請搜尋該公司最近 7 天最新新聞，確認是否有影響長期基本面的重大負面消息。
結合上述持倉成本與虧損幅度，分析是否值得攤平：公司基本面是否仍支持長期持有？攤平後新成本合理嗎？還是應設停損？給出明確建議。`,

      trade_stoploss: `請搜尋該公司最近 7 天最新新聞，確認是否有基本面惡化或重大利空。
結合上述持倉成本與技術面，判斷是否出現停損訊號：技術面關鍵支撐是否已破？基本面是否改變？建議停損點位在哪？繼續持有的最大風險是什麼？`,

      trade_valuation: `請搜尋該公司最近財報、分析師報告與同業估值比較。
結合上述PE、EPS、分析師目標價，分析目前估值是否合理：與歷史估值區間相比是高是低？與同業相比溢價多少？若利率或成長預期改變，估值下修空間多大？`,

      // ── 消息面判斷類 ──
      news: `請搜尋該公司最近 7 天的最新新聞、財報發布情況、競爭對手動態。
判斷：1.多空方向與強度 2.消息是否改變營運基本面或技術競爭力 3.財報前後操作建議 4.有無個股風險預警。`,

      news_fundamental: `請搜尋該公司最近的財報、法說會內容、產品管線更新與競爭對手消息。
分析：近期消息是否實質改變公司的營收成長潛力、毛利率趨勢或技術競爭優勢？是正面還是負面影響？影響是短期還是長期？`,

      news_earnings: `請搜尋該公司最近的財報結果、法說會指引與分析師反應。
結合上述財報日期與近期季報數據，提供財報前後操作策略：財報前應持有/減碼/加碼？財報後根據結果如何應對？預期落差風險多大？`,

      news_risk: `請搜尋該公司最近的負面消息、監管風險、訴訟、競爭威脅與市場份額變化。
結合上述新聞情緒與基本面數據，列出目前最值得警惕的個股風險因子，評估每項風險的嚴重程度與發生機率。`,

      // ── 大盤趨勢類 ──
      macro: `請搜尋目前全球最新的政經新聞、貨幣政策動向、地緣政治風險與板塊輪動趨勢。
分析：1.大盤環境是順風還是逆風 2.有無崩盤預警 3.板塊輪動趨勢。
結合上述我的投資組合持倉明細，從整體市場與個人持倉兩個角度評估：大盤環境對我各持倉標的有何具體影響？哪些持倉處於順風/逆風位置？給出針對我目前組合的倉位調整建議。`,

      macro_crash: `請搜尋目前美股最新市場情緒指標、信用利差、VIX走勢、資金流向與機構風險預警報告。
結合上述 Fear & Greed 與 Macro 情緒分數，判斷：目前是否出現系統性風險訊號？
結合我的投資組合持倉明細，分析：若市場出現系統性風險或崩盤，哪些持倉風險最高（高槓桿、高估值、低流動性）？哪些持倉相對抗跌？建議如何調整倉位結構對沖下行風險？`,

      macro_rotation: `請搜尋目前美股各板塊資金流向、ETF 進出資金、機構持倉變化與板塊輪動分析報告。
結合上述板塊 ETF 近 1 月漲跌數據，分析目前資金輪動方向。
結合我的投資組合持倉明細，評估：板塊輪動趨勢對我現有各持股是利多還是利空？我的持倉板塊集中度是否過高？是否有需要汰換或加碼的板塊？給出具體的倉位輪動建議。`,

      macro_sector: `請搜尋目前「XX類股」板塊的最新動態（請將 XX 替換為實際類股名稱，例如：AI半導體、生技醫療、核能電力、網路安全、太空科技等）。
分析方向：
1.【板塊整體走勢】近期該板塊的漲跌趨勢、相對大盤強弱、資金流入/流出狀況。
2.【代表性指標股介紹】列出該板塊 3-5 檔最具代表性的龍頭股或高成長潛力股，針對每一檔說明：公司主要業務與競爭優勢、近期技術面走勢（趨勢、關鍵支撐/壓力位）、基本面重點（營收成長率、毛利率、EPS 趨勢、PE 估值）、近期催化劑（財報、新品、合約、政策）。
3.【操作建議】目前是否為該板塊布局的好時機？資金輪動方向對該板塊是否有利？短中期風險因子有哪些？
結合上述我的投資組合持倉明細，若我已有持倉在此板塊，評估現有持股與龍頭股的相對強弱，給出加碼/減碼/換股建議。`,

      macro_discover: `今天日期：{TODAY}。
我希望你幫我從美股市場中，找出目前不在我自選名單內、但在未來 3–5 年極具投資潛力的個股（3–5 檔）。

【我目前的自選清單（請排除這些）】
{WATCHLIST}

請依照以下多維度篩選框架進行挑選，並說明篩選邏輯：
1.【未來技術趨勢】AI Agent / 機器人 / 量子運算 / 下一代半導體 / 新能源 / 生技創新等長期成長主題中，哪些細分賽道目前資金最為集中、護城河最深？
2.【經濟與市場現況】結合目前 Fed 利率環境、通膨走勢、美元強弱、信用市場，哪類股票在此環境下最具結構性優勢（如高現金流、定價能力、出口受益等）？
3.【近期新聞焦點與催化劑】搜尋最近 30 天內市場關注度快速上升的題材（例如：AI 資料中心需求、GLP-1 藥物、核電復興、國防預算、重返太空等），哪些個股是直接受益者？
4.【法人籌碼追蹤】搜尋近期機構大幅加倉、分析師上調目標價、或出現異常大量買入的個股，篩選出籌碼面乾淨、機構持股增加的標的。

【輸出格式】針對每一檔推薦股，請提供：
- 股票代碼與公司名稱
- 核心投資論點（2-3 句）
- 近期技術面走勢（趨勢方向、關鍵位置）
- 基本面數據（營收成長、毛利率、EPS 預估、PE/PS 估值）
- 近期催化劑與潛在風險
- 進場參考區間

最後總結：目前市場環境下，以上哪 1–2 檔的風險報酬比最佳？`,

      default: `請搜尋相關最新資訊，結合以上數據給出整合性回答。`,
    };

    const questionPart = customQuestion
      ? `\n我的問題：${customQuestion}`
      : "";

    const search = searchInstructions[questionType] ?? searchInstructions.default;

    const today = new Date().toISOString().slice(0, 10);
    return `今天日期：${today}
以下是我的投資組合系統對此股票的即時數據：

${ctx}

---
${search}${questionPart}

⚠️ 注意：今天是 ${today}，請優先引用最近 7–14 天內的新聞與資料。若搜尋結果含較舊的內容（超過 30 天前），請明確標示其日期，不要將舊新聞當成最新動態。每條引用請附上來源日期（格式：YYYY-MM-DD）。

請使用繁體中文回答，條列重點，長度 300-500 字。`;
  }

  /** POST /api/ai/build-prompt — returns a ready-to-paste prompt string, no LLM call */
  app.post("/api/ai/build-prompt", async (req, res) => {
    try {
      const { symbol, name, price, change, market, questionType = "default", customQuestion } = req.body;
      let ctx: string;
      if (typeof questionType === "string" && questionType.startsWith("macro")) {
        // Build a prices map from quoteCache via getAllQuotes (uses cache, no fresh fetch)
        const priceMap: Record<string, number> = {};
        try {
          const { quotes: allQuotes } = await getAllQuotes();
          for (const q of allQuotes) {
            priceMap[`${q.symbol}_${q.market}`] = q.price;
            priceMap[q.symbol] = q.price;
          }
        } catch { /* use empty map — buildPortfolioContext falls back to avgCost */ }
        ctx = buildPortfolioContext(priceMap);
      } else {
        ctx = buildStockContext(symbol, market, price ?? 0, change ?? 0, name);
      }
      // For macro_sector / macro_discover, customQuestion is used as a parameter (sector name),
      // not as a freeform question to append — suppress it from buildUserPrompt
      const suppressCustomQ = questionType === "macro_sector" || questionType === "macro_discover";
      let prompt = buildUserPrompt(ctx, questionType, suppressCustomQ ? undefined : customQuestion);

      // For macro_sector: replace XX placeholder with actual sector name from customQuestion
      if (questionType === "macro_sector" && customQuestion) {
        prompt = prompt.replace(/XX/g, customQuestion);
      }

      // For macro_discover: inject watchlist symbols and today's date
      if (questionType === "macro_discover") {
        const today = new Date().toISOString().slice(0, 10);
        try {
          const wl = await storage.getWatchlist();
          const watchlistStr = wl.map((w: { symbol: string; name: string; market: string }) =>
            `${w.market} ${w.symbol}（${w.name}）`
          ).join("、");
          prompt = prompt.replace("{TODAY}", today).replace("{WATCHLIST}", watchlistStr || "（無）");
        } catch {
          prompt = prompt.replace("{TODAY}", new Date().toISOString().slice(0, 10)).replace("{WATCHLIST}", "（讀取失敗）");
        }
      }

      res.json({ prompt });
    } catch (error: any) {
      console.error("build-prompt error:", error.message);
      res.status(500).json({ error: "Failed to build prompt" });
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
  function normalizeTradeSide(val: any): "buy" | "sell" | "dividend" | null {
    const s = String(val ?? "").trim().toLowerCase();
    if (!s) return null;
    if (s === "買" || s === "买" || s === "買進" || s === "买进" || s === "buy" || s === "b") return "buy";
    if (s === "賣" || s === "卖" || s === "賣出" || s === "卖出" || s === "sell" || s === "s") return "sell";
    if (s === "股息" || s === "dividend" || s === "div") return "dividend";
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
      if (!symbol || !side) continue;

      // Dividend row: price/shares are "NA" — only totalCost matters
      if (side === "dividend") {
        if (!totalCost || totalCost <= 0) continue; // must be a positive amount
        result.push({
          tradeDate: dateStr,
          symbol,
          name,
          market,
          side,
          shares: 0,
          price: 0,
          totalCost,
          currency: market === "TW" ? "TWD" : "USD",
        });
        continue;
      }

      if (!price || !shares) continue;
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
  // ── Analyst Target Helpers ─────────────────────────────────────────────────

  /**
   * Parse a target price string like "US1,183", "US$850", "$850", "1,327", 850
   * Returns null if unparseable.
   */
  function parseTargetPrice(raw: any): number | null {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "number") return isNaN(raw) ? null : raw;
    // If cell contains "原為" (e.g. "US$1,183 原為 US$1,163"), take only the FIRST number
    const str = String(raw).trim();
    const firstPart = str.split(/原為/)[0].trim();
    const s = firstPart
      .replace(/^US\$?/i, "")  // remove US$ or US prefix
      .replace(/^\$/,    "")  // remove leading $
      .replace(/,/g,    "")  // remove thousands separators
      .trim();
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /** Extract the previous target price from combined cell "US$1,183 原為 US$1,163" */
  function parsePrevTargetPrice(raw: any): number | null {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "number") return null; // pure number → no "原為" part
    const str = String(raw).trim();
    const parts = str.split(/原為/);
    if (parts.length < 2) return null;
    const s = parts[1].trim()
      .replace(/^US\$?/i, "")
      .replace(/^\$/,    "")
      .replace(/,/g,    "")
      .trim();
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /**
   * Normalise a raw rating string to category + score.
   * Unknown ratings → neutral (score 3) with a console warning.
   */
  function normalizeAnalystRating(raw: any): {
    rating: string;
    category: "bullish" | "neutral" | "bearish";
    score: 5 | 3 | 1;
  } {
    const rating = String(raw ?? "").trim();
    const lower  = rating.toLowerCase();

    const bullish = [
      "buy", "strong buy", "overweight", "outperform",
      "accumulate", "sector outperform", "positive",
    ];
    const bearish = [
      "sell", "underweight", "underperform",
      "reduce", "negative",
    ];
    const neutral = [
      "hold", "neutral", "market perform",
      "equal weight", "sector perform", "mixed",
    ];

    if (bullish.includes(lower)) return { rating, category: "bullish", score: 5 };
    if (bearish.includes(lower)) return { rating, category: "bearish", score: 1 };
    if (neutral.includes(lower)) return { rating, category: "neutral", score: 3 };

    console.warn(`[analyst] Unknown rating "${rating}" — defaulting to neutral`);
    return { rating, category: "neutral", score: 3 };
  }

  /**
   * Parse an analyst target price sheet.
   * sheetName is used as the stock symbol.
   * Expected column order (case-insensitive header detection or positional):
   *   A=Institution  B=Rating  C=New Target  D=Previous Target  E=Date
   */
  function parseAnalystTargetSheet(
    sheet: XLSX.WorkSheet,
    sheetName: string,
    market: "US" | "TW" = "US"
  ): InsertAnalystTarget[] {
    const symbol = sheetName.trim().toUpperCase();
    const rows   = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: null });
    if (rows.length < 2) return [];

    // Detect header row (row 0) column positions by keyword matching (English + Chinese)
    const headerRow = (rows[0] as any[]).map((c: any) => String(c ?? "").toLowerCase().trim());

    const colIdx = {
      institution: -1,
      rating:      -1,
      newTarget:   -1,
      date:        -1,
    };

    headerRow.forEach((h, i) => {
      if (colIdx.institution < 0 && (h.includes("institution") || h.includes("firm") || h.includes("broker") || h.includes("機構")))  colIdx.institution = i;
      if (colIdx.rating      < 0 && (h.includes("rating") || h.includes("action") || h.includes("評級")))                            colIdx.rating      = i;
      if (colIdx.newTarget   < 0 && (h.includes("target") || h.includes("目標價")))                                               colIdx.newTarget   = i;
      if (colIdx.date        < 0 && (h.includes("date") || h.includes("日期")))                                                      colIdx.date        = i;
    });

    // Fallback positional mapping: A=0 Institution  B=1 Rating  C=2 Target(+prev combined)  D=3 Date
    if (colIdx.institution < 0) colIdx.institution = 0;
    if (colIdx.rating      < 0) colIdx.rating      = 1;
    if (colIdx.newTarget   < 0) colIdx.newTarget   = 2;
    if (colIdx.date        < 0) colIdx.date        = 3;

    const now = Date.now();
    const result: InsertAnalystTarget[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as any[];
      if (!row || row.every((c: any) => c === null || c === undefined || c === "")) continue;

      const institution = String(row[colIdx.institution] ?? "").trim();
      if (!institution) continue;

      const rawRating   = row[colIdx.rating];
      const rawNew      = row[colIdx.newTarget];
      const rawDate     = row[colIdx.date];

      const newTarget   = parseTargetPrice(rawNew);
      if (newTarget === null || newTarget <= 0) continue;  // must have a valid new target

      // prevTarget extracted from the same cell as newTarget ("US$1,183 原為 US$1,163")
      const prevTarget  = parsePrevTargetPrice(rawNew);
      const analystDate = parseExcelDate(rawDate) || new Date().toISOString().slice(0, 10);

      const { rating, category, score } = normalizeAnalystRating(rawRating);

      result.push({
        symbol,
        market,
        institution,
        rating,
        ratingCategory: category,
        score,
        targetPrice: newTarget,
        previousTargetPrice: prevTarget,
        analystDate,
        sourceSheet: sheetName,
        createdAt: now,
        updatedAt: now,
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

      // Sheet 1 (index 0) → TW transactions
      const twSheet = wb.Sheets[wb.SheetNames[0]];
      if (twSheet) imported.push(...parseUnifiedTransactionSheet(twSheet, "TW"));

      // Sheet 2 (index 1) → US transactions
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

      // ── Sheet 3+ → Analyst Target Sheets ────────────────────────────────
      // Each sheet name is treated as the stock symbol (e.g. "LLY", "RKLB")
      // We only replace analyst data for symbols present in this Excel file.
      const analystSymbols: string[] = [];
      let analystTargetsImported = 0;

      for (let si = 2; si < wb.SheetNames.length; si++) {
        const sheetName = wb.SheetNames[si];
        const sheet     = wb.Sheets[sheetName];
        if (!sheet) continue;

        // Heuristic: analyst sheets have names that look like stock symbols
        // (1-6 uppercase letters/digits, no spaces) — skip if it looks like a trade sheet
        const looksLikeSymbol = /^[A-Za-z0-9]{1,8}$/.test(sheetName.trim());
        if (!looksLikeSymbol) {
          console.log(`[import] Skipping sheet "${sheetName}" — doesn't look like a stock symbol`);
          continue;
        }

        const analystRows = parseAnalystTargetSheet(sheet, sheetName, "US");
        if (analystRows.length === 0) {
          console.log(`[import] Sheet "${sheetName}" yielded 0 analyst rows — skipping`);
          continue;
        }

        // Replace only this symbol's analyst data
        await storage.replaceAnalystTargetsForSymbol(
          sheetName.trim().toUpperCase(),
          "US",
          analystRows
        );
        analystSymbols.push(sheetName.trim().toUpperCase());
        analystTargetsImported += analystRows.length;
        console.log(`[import] Analyst targets: ${sheetName} → ${analystRows.length} rows`);
      }

      res.json({
        ok: true,
        imported: count,
        tw: imported.filter(r => r.market === "TW").length,
        us: imported.filter(r => r.market === "US").length,
        analystTargetsImported,
        analystSymbols,
      });
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
      // Cost method depends on market:
      //   TW → FIFO (台灣券商採先進先出法)
      //   US → Weighted Average Cost
      type PositionMap = Record<string, {
        symbol: string; name: string; market: string; currency: string;
        holdingShares: number;   // current shares held
        holdingCost: number;     // current total cost of held shares (weighted avg basis, US only)
        realizedGain: number;    // cumulative realized gain in native currency
        totalBuyCost: number;    // total buy cost (abs value, for reference)
        totalBuyShares: number;
        lots: Array<{ shares: number; unitCost: number }>;  // FIFO lots (TW only)
      }>;

      const positions: PositionMap = {};

      for (const tx of txns) {
        const key = `${tx.symbol}_${tx.market}`;
        if (!positions[key]) {
          positions[key] = {
            symbol: tx.symbol, name: tx.name, market: tx.market, currency: tx.currency,
            holdingShares: 0, holdingCost: 0, realizedGain: 0, totalBuyCost: 0, totalBuyShares: 0,
            lots: [],
          };
        }
        const pos = positions[key];
        const isTW = pos.market === "TW";

        if (tx.side === "buy") {
          pos.totalBuyCost += Math.abs(tx.totalCost);
          pos.totalBuyShares += tx.shares;
          if (isTW) {
            // FIFO: push a new lot
            pos.lots.push({ shares: tx.shares, unitCost: Math.abs(tx.totalCost) / tx.shares });
            pos.holdingShares += tx.shares;
            pos.holdingCost += Math.abs(tx.totalCost);
          } else {
            // Weighted average: add to holding pool
            pos.holdingShares += tx.shares;
            pos.holdingCost += Math.abs(tx.totalCost);
          }
        } else if (tx.side === "dividend") {
          // Dividend: directly add to realized gain
          pos.realizedGain += tx.totalCost;
        } else {
          // Sell
          const proceeds = Math.abs(tx.totalCost);
          if (isTW) {
            // FIFO: consume oldest lots first
            let remainingToSell = tx.shares;
            let costBasis = 0;
            while (remainingToSell > 0.0001 && pos.lots.length > 0) {
              const lot = pos.lots[0];
              if (lot.shares <= remainingToSell + 0.0001) {
                // consume entire lot
                costBasis += lot.unitCost * lot.shares;
                remainingToSell -= lot.shares;
                pos.holdingShares -= lot.shares;
                pos.holdingCost -= lot.unitCost * lot.shares;
                pos.lots.shift();
              } else {
                // partial lot
                costBasis += lot.unitCost * remainingToSell;
                pos.holdingShares -= remainingToSell;
                pos.holdingCost -= lot.unitCost * remainingToSell;
                lot.shares -= remainingToSell;
                remainingToSell = 0;
              }
            }
            pos.realizedGain += proceeds - costBasis;
            if (pos.holdingShares < 0.0001) { pos.holdingShares = 0; pos.holdingCost = 0; pos.lots = []; }
          } else {
            // Weighted average sell
            const avgCostNow = pos.holdingShares > 0 ? pos.holdingCost / pos.holdingShares : 0;
            const costBasis = avgCostNow * tx.shares;
            pos.realizedGain += proceeds - costBasis;
            pos.holdingShares -= tx.shares;
            pos.holdingCost -= costBasis;
            if (pos.holdingShares < 0.0001) { pos.holdingShares = 0; pos.holdingCost = 0; }
          }
        }
      }

      // Build output
      const holdings = Object.values(positions).map((pos) => {
        const currentShares = pos.holdingShares;
        const currentCost = pos.holdingCost;
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
  let overviewFullRefreshDone = false; // true after first full refresh completes

  // Full refresh: external fetch (refreshAllIndicators) + DB assemble — used on server start only
  async function runOverviewRefreshFull(): Promise<void> {
    try {
      await refreshAllIndicators();
      const payload = await assembleMarketOverview();
      overviewCache = { payload, fetchedAt: Date.now() };
      overviewFullRefreshDone = true;
    } catch (e: any) {
      console.error("[market-overview] full refresh error:", e.message);
    } finally {
      overviewRefreshing = false;
    }
  }

  // DB-only refresh: re-assemble from DB without any external fetch
  // Called every 60s from backgroundQuotePoll so VIX/TNX/FG stay real-time
  async function runOverviewRefreshDB(): Promise<void> {
    try {
      const payload = await assembleMarketOverview();
      overviewCache = { payload, fetchedAt: Date.now() };
    } catch (e: any) {
      // silent — DB refresh should never crash the server
    }
  }

  async function getOverviewPayload() {
    const now = Date.now();
    const CACHE_TTL = 55 * 1000; // 55s — shorter than 60s poll so each poll gets fresh DB data
    // Return fresh cache immediately
    if (overviewCache && now - overviewCache.fetchedAt < CACHE_TTL) {
      return overviewCache.payload;
    }
    if (!overviewRefreshing) {
      overviewRefreshing = true;
      // First ever call: full refresh (refreshAllIndicators + DB)
      // Subsequent cache misses: DB-only refresh (backgroundQuotePoll already keeps DB fresh)
      if (!overviewFullRefreshDone) {
        void runOverviewRefreshFull();
      } else {
        void runOverviewRefreshDB().then(() => { overviewRefreshing = false; });
      }
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

  // ─── Background Quote Poller ─────────────────────────────────────────────
  // Proactively refresh all watchlist quotes every 60s during market hours.
  // This keeps technical bar DB and quoteCache warm so page switches show
  // data instantly instead of waiting for on-demand fetch.
  const BACKGROUND_POLL_INTERVAL = 60_000; // 60 seconds
  // Helper: upsert a single today-bar into historical_prices for INDEX symbols (^VIX, ^TNX, etc.)
  async function syncIndexTodayBar(symbol: string, close: number): Promise<void> {
    try {
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
      const existing = sqlite.prepare(
        `SELECT open, high, low, volume FROM historical_prices WHERE symbol=? AND market='INDEX' AND date=?`
      ).get(symbol, today) as { open: number; high: number; low: number; volume: number } | undefined;
      const open   = existing?.open  ?? close;
      const high   = Math.max(existing?.high  ?? close, close);
      const low    = Math.min(existing?.low   ?? close, close);
      const volume = existing?.volume ?? 0;
      await storage.upsertHistoricalPrices([{
        symbol, market: "INDEX", date: today,
        open: +open.toFixed(4),
        high: +high.toFixed(4),
        low:  +low.toFixed(4),
        close: +close.toFixed(4),
        volume,
        updatedAt: Date.now(),
      }]);
    } catch (e: any) {
      // silent
    }
  }

  async function backgroundQuotePoll() {
    try {
      const dbWatchlist = await storage.getWatchlist();
      if (dbWatchlist.length === 0) return;
      const symbols = dbWatchlist.map((item) => ({ symbol: item.symbol, name: item.name, market: item.market as "TW" | "US" }));
      const result = await getAllQuotes(symbols);
      const allQuotes = [...(result.tw ?? []), ...(result.us ?? [])];
      for (const q of allQuotes) {
        if (q.symbol && q.market) {
          syncTodayTechnicalBarFromQuote(q.symbol, q.market as "TW" | "US", q).catch(() => {});
        }
      }
    } catch (e: any) {
      // Silent fail — background poller should never crash the server
    }

    // ── Intraday real-time update for VIX, ^TNX, and Fear & Greed ──────────
    // Use v8/chart range=1d (stable) instead of spark range=3mo (returns 500 for ^VIX)
    // ^VIX — upsert today's bar in historical_prices (market=INDEX)
    fetchYahooLivePrice("^VIX").then(price => {
      if (price) syncIndexTodayBar("^VIX", price).catch(() => {});
    }).catch(() => {});

    // ^TNX (US 10Y yield) — upsert today's bar in historical_prices (market=INDEX)
    fetchYahooLivePrice("^TNX").then(price => {
      if (price) syncIndexTodayBar("^TNX", price).catch(() => {});
    }).catch(() => {});

    // CNN Fear & Greed — upsert today's value in market_indicators
    fetchFearGreed().then(r => {
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
      // Only write if CNN returned a value for today (trading day)
      if (!r.date || !r.value) return;
      storage.upsertIndicatorHistory([{
        indicatorKey: "fear_greed",
        market: "US",
        frequency: "daily",
        date: today,
        value: +r.value.toFixed(2),
        value2: null,
        metaJson: r.label ?? null,  // plain string: "fear" / "greed" / etc.
        source: "CNN Fear&Greed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }]).catch(() => {});
    }).catch(() => {});

    // After all DB writes complete (~1s), refresh the overview cache from DB
    // This ensures VIX/TNX/FG on the overview page reflect today's intraday values
    setTimeout(() => { runOverviewRefreshDB().catch(() => {}); }, 2000);
  }
  // Start polling after a short delay so server is fully ready
  setTimeout(() => {
    backgroundQuotePoll(); // immediate first run
    setInterval(backgroundQuotePoll, BACKGROUND_POLL_INTERVAL);
  }, 5000);

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

  // ---- News Digest ----

  /** GET /api/news-digest/stocks
   * Returns US watchlist stocks with their recent digest history.
   * ?days=N (default 30)
   */
  app.get("/api/news-digest/stocks", async (req, res) => {
    try {
      const days = Math.min(180, Math.max(1, parseInt((req.query.days as string) ?? "30") || 30));
      const watchlistItems = await storage.getWatchlist();
      const usItems = watchlistItems.filter((w) => w.market === "US");
      const tickers = usItems.map((w) => w.symbol);
      const allDigests = storage.getDigestsForTickers(tickers, days);

      const digestsByTicker = new Map<string, typeof allDigests>();
      for (const d of allDigests) {
        const arr = digestsByTicker.get(d.ticker) ?? [];
        arr.push(d);
        digestsByTicker.set(d.ticker, arr);
      }

      const stocks = usItems.map((w) => ({
        symbol: w.symbol,
        name: w.name,
        sectorTag: storage.getSectorTag(w.symbol),
        digests: digestsByTicker.get(w.symbol) ?? [],
      }));

      // Stats
      const todayDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
      const updatedToday = stocks.filter((s) =>
        s.digests.some((d) => d.digestDate === todayDate && d.status === "ok")
      ).length;

      res.json({
        stocks,
        stats: {
          totalStocks: usItems.length,
          updatedToday,
          historyDays: days,
          maxSourceCount: Math.max(0, ...allDigests.map((d) => d.sourceCount)),
        },
        lastUpdated: allDigests.length > 0
          ? Math.max(...allDigests.map((d) => d.generatedAt))
          : null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/news-digest/update — trigger full update for all US watchlist stocks */
  let digestUpdateRunning = false;
  app.post("/api/news-digest/update", async (_req, res) => {
    if (digestUpdateRunning) {
      return res.status(409).json({ error: "Update already in progress" });
    }
    digestUpdateRunning = true;
    try {
      const { results, updatedAt } = await generateAllDigests();
      res.json({
        success: true,
        updatedAt,
        results,
        successCount: results.filter((r) => r.success).length,
        errorCount: results.filter((r) => !r.success).length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      digestUpdateRunning = false;
    }
  });

  /** GET /api/news-digest/:digestId/sources — sources for a single digest */
  app.get("/api/news-digest/:digestId/sources", (req, res) => {
    try {
      const digestId = parseInt(req.params.digestId);
      if (isNaN(digestId)) return res.status(400).json({ error: "Invalid digestId" });
      const sources = storage.getSourcesForDigest(digestId);
      res.json(sources);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /api/news-digest/:ticker/history — full history for one ticker */
  app.get("/api/news-digest/:ticker/history", (req, res) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const days = Math.min(180, parseInt((req.query.days as string) ?? "90") || 90);
      const digests = storage.getDigestsForTicker(ticker, days);
      res.json(digests);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** PATCH /api/news-digest/sector-tag — set sector tag for a symbol */
  app.patch("/api/news-digest/sector-tag", (req, res) => {
    try {
      const { symbol, sectorTag } = req.body;
      if (!symbol || sectorTag === undefined) return res.status(400).json({ error: "symbol and sectorTag required" });
      storage.upsertSectorTag(symbol.toUpperCase(), sectorTag);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** DELETE /api/news-digest/before/:date — remove all digests before YYYY-MM-DD */
  app.delete("/api/news-digest/before/:date", (req, res) => {
    try {
      const date = req.params.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      const deleted = storage.deleteDigestsBefore(date);
      res.json({ ok: true, deleted });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/analyst-targets/:symbol?market=US|TW
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/analyst-targets/:symbol", async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const market = ((req.query.market as string) || "US").toUpperCase() as "US" | "TW";

      // All rows for this symbol — filter to 4 months
      const fourMonthsAgo = new Date();
      fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
      const cutoff = fourMonthsAgo.toISOString().slice(0, 10);

      const allRows = await storage.getAnalystTargetsBySymbol(symbol, market);

      // consensusRows (4-month, deduplicated per institution) — for summary stats
      // tableRows (6-month, ALL rows including repeated institutions) — for table display
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const sixMonthCutoff = sixMonthsAgo.toISOString().slice(0, 10);
      const tableRows = allRows
        .filter(r => r.analystDate >= sixMonthCutoff)
        .sort((a, b) => (a.analystDate > b.analystDate ? -1 : 1));

      // recentRows alias for downstream checks
      const recentRows = tableRows;

      if (recentRows.length === 0) {
        return res.json({ symbol, market, hasData: false });
      }

      // Consensus rows: each institution's latest entry within 6 months
      const consensusRows = await storage.getLatestAnalystConsensusBySymbol(symbol, market);

      // ── Compute consensus summary ─────────────────────────────────────────
      const sampleCount  = consensusRows.length;
      const bullishRows  = consensusRows.filter(r => r.ratingCategory === "bullish");
      const neutralRows  = consensusRows.filter(r => r.ratingCategory === "neutral");
      const bearishRows  = consensusRows.filter(r => r.ratingCategory === "bearish");

      const avgScore = sampleCount > 0
        ? consensusRows.reduce((s, r) => s + r.score, 0) / sampleCount
        : 0;

      let consensusLabel: string;
      if      (avgScore >= 4.5) consensusLabel = "強烈買入";
      else if (avgScore >= 3.5) consensusLabel = "買入";
      else if (avgScore >= 2.5) consensusLabel = "持有";
      else if (avgScore >= 1.5) consensusLabel = "賣出";
      else                      consensusLabel = "強烈賣出";

      const pct = (n: number) =>
        sampleCount > 0 ? Math.round((n / sampleCount) * 1000) / 10 : 0;

      const targetPrices = consensusRows.map(r => r.targetPrice);
      const avgTargetPrice  = targetPrices.reduce((s, v) => s + v, 0) / targetPrices.length;
      const highTargetPrice = Math.max(...targetPrices);
      const lowTargetPrice  = Math.min(...targetPrices);

      // ── Build overlay events ───────────────────────────────────────────
      // Use recent-6-month rows for overlay (all events, not deduplicated)
      const overlayEvents = recentRows.map(r => {
        let direction: "up" | "down" | "flat";
        if (r.previousTargetPrice === null || r.previousTargetPrice === undefined) {
          direction = "flat";
        } else if (r.targetPrice > r.previousTargetPrice) {
          direction = "up";
        } else if (r.targetPrice < r.previousTargetPrice) {
          direction = "down";
        } else {
          direction = "flat";
        }
        return {
          date:                r.analystDate,
          institution:         r.institution,
          rating:              r.rating,
          ratingCategory:      r.ratingCategory,
          targetPrice:         r.targetPrice,
          previousTargetPrice: r.previousTargetPrice ?? null,
          direction,
        };
      });

      res.json({
        symbol,
        market,
        hasData: true,
        summary: {
          consensusLabel,
          averageScore:     Math.round(avgScore * 100) / 100,
          bullishCount:     bullishRows.length,
          neutralCount:     neutralRows.length,
          bearishCount:     bearishRows.length,
          bullishPct:       pct(bullishRows.length),
          neutralPct:       pct(neutralRows.length),
          bearishPct:       pct(bearishRows.length),
          averageTargetPrice: Math.round(avgTargetPrice * 100) / 100,
          highTargetPrice,
          lowTargetPrice,
          sampleCount,
        },
        overlayEvents,
        rows: recentRows,  // full 6-month data for bottom table
      });
    } catch (e: any) {
      console.error("[analyst-targets] error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ──── Stock Notes ────────────────────────────────────────────────────────────────────────

  // GET /api/stock-notes/:symbol?market=US|TW
  app.get("/api/stock-notes/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const market = ((req.query.market as string) || "US").toUpperCase();
    const content = storage.getStockNote(symbol, market);
    res.json({ symbol, market, content });
  });

  // PUT /api/stock-notes/:symbol?market=US|TW  { content: string }
  app.put("/api/stock-notes/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const market = ((req.query.market as string) || "US").toUpperCase();
    const content: string = req.body?.content ?? "";
    storage.upsertStockNote(symbol, market, content);
    res.json({ ok: true });
  });


  // ──── Fundamentals ───────────────────────────────────────────────────────────────────────

  /**
   * GET /api/fundamentals/:symbol?market=US
   * Returns computed fundamental scores + raw metrics for the given symbol.
   * Data is cached in DB for 7 days; fetches from yfinance if expired.
   */
  app.get("/api/fundamentals/:symbol", async (req, res) => {
    const symbol  = (req.params.symbol ?? "").toUpperCase();
    const market  = (req.query.market as string ?? "US").toUpperCase() as "TW" | "US";
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    try {
      const result = await getOrFetchFundamentals(symbol, market);
      res.json(result);
    } catch (e: any) {
      console.error(`[fundamentals] ${symbol}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/fundamentals/:symbol/resync?market=US
   * Force re-fetch from yfinance regardless of TTL.
   */
  app.post("/api/fundamentals/:symbol/resync", async (req, res) => {
    const symbol  = (req.params.symbol ?? "").toUpperCase();
    const market  = (req.query.market as string ?? "US").toUpperCase() as "TW" | "US";
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    try {
      const result = await getOrFetchFundamentals(symbol, market, true);
      res.json({ ok: true, fetchedAt: result.fetchedAt });
    } catch (e: any) {
      console.error(`[fundamentals/resync] ${symbol}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/fundamentals/cache/all
   * Wipe all cached fundamental data so every symbol re-fetches fresh on next request.
   */
  app.delete("/api/fundamentals/cache/all", (_req, res) => {
    try {
      storage.clearAllFundamentals();
      console.log("[fundamentals] cache cleared");
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/internal/fundamentals-sync
   * Called by Perplexity cron to write fresh fundamental data into the DB.
   * Requires X-Sync-Secret header matching INTERNAL_SYNC_SECRET env var.
   *
   * Body: Array of { symbol, market, quarterlyIncome, epsHistory, info, calendar }
   */
  app.post("/api/internal/fundamentals-sync", async (req, res) => {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret || req.headers["x-sync-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const items = req.body as any[];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Expected non-empty array" });
    }
    let saved = 0;

    for (const item of items) {
      try {
        const { symbol, market, quarterlyIncome, epsHistory } = item;
        if (!symbol || !market) continue;
        const sym = String(symbol).toUpperCase();
        const mkt = String(market).toUpperCase() as "TW" | "US";
        // updateCronData ONLY writes quarterly/eps — never touches info or calendar
        storage.updateCronData(
          sym, mkt,
          JSON.stringify(quarterlyIncome ?? []),
          JSON.stringify(epsHistory      ?? [])
        );
        saved++;
      } catch (e: any) {
        console.error(`[fundamentals-sync] failed for ${item?.symbol}:`, e.message);
      }
    }
    console.log(`[fundamentals-sync] saved ${saved}/${items.length} symbols`);
    res.json({ ok: true, saved });
  });

  /**
   * POST /api/internal/news-digest-sync
   * Called by Perplexity cron (news_digest_cron.py) to write daily news digests into the DB.
   * Requires X-Sync-Secret header matching INTERNAL_SYNC_SECRET env var.
   *
   * Body: Array of DigestSyncItem
   */
  /**
   * POST /api/internal/macro-sentiment-sync
   * Called by news_digest_cron.py Step 5 to write macro sentiment (SPY+QQQ) into market_indicators.
   * Body: [{ ticker, summaryRaw }]
   */
  app.post("/api/internal/macro-sentiment-sync", async (req, res) => {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret || req.headers["x-sync-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const items = req.body as { ticker: string; summaryRaw: string }[];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Expected non-empty array" });
    }
    // Use today's date in ET (same convention as news digest)
    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    try {
      const result = await saveMacroSentiment(items, todayET);
      res.json({ ok: result.ok, score: result.score, method: result.method, date: todayET });
    } catch (e: any) {
      console.error("[macro-sentiment-sync] error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/internal/news-digest-sync", async (req, res) => {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret || req.headers["x-sync-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const items = req.body as DigestSyncItem[];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Expected non-empty array" });
    }
    let saved = 0;
    const errors: string[] = [];
    for (const item of items) {
      const result = await saveDigestData(item);
      if (result.success) saved++;
      else errors.push(`${item.ticker}: ${result.error}`);
    }
    console.log(`[news-digest-sync] saved ${saved}/${items.length}`);
    res.json({ ok: true, saved, errors });
  });

  /**
   * POST /api/internal/analyst-sync
   * Called by analyst_sync_cron.py to write analyst target data into the DB.
   * Requires X-Sync-Secret header matching INTERNAL_SYNC_SECRET env var.
   *
   * Body: Array of { symbol, market, institution, rating, rating_category,
   *                   score, target_price, previous_target_price, analyst_date, source_sheet }
   */
  app.post("/api/internal/analyst-sync", async (req, res) => {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret || req.headers["x-sync-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const items = req.body as any[];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Expected non-empty array" });
    }
    const now = Date.now();
    const rows: InsertAnalystTarget[] = [];
    for (const item of items) {
      const sym = String(item.symbol ?? "").toUpperCase();
      const mkt = String(item.market ?? "US").toUpperCase();
      const institution = String(item.institution ?? "").trim();
      const analystDate = String(item.analyst_date ?? "").trim();
      if (!sym || !institution || !analystDate) continue;

      const rawRating = String(item.rating ?? "").trim();
      const rawCategory = String(item.rating_category ?? "").trim().toLowerCase();
      const { rating, category, score } = rawCategory === "bullish" || rawCategory === "bearish" || rawCategory === "neutral"
        ? { rating: rawRating, category: rawCategory as "bullish" | "neutral" | "bearish", score: rawCategory === "bullish" ? 5 : rawCategory === "bearish" ? 1 : 3 as 5 | 3 | 1 }
        : normalizeAnalystRating(rawRating);

      const targetPrice = parseFloat(item.target_price);
      if (isNaN(targetPrice) || targetPrice <= 0) continue;
      const prevTarget = item.previous_target_price != null ? parseFloat(item.previous_target_price) : null;

      rows.push({
        symbol: sym,
        market: mkt,
        institution,
        rating,
        ratingCategory: category,
        score,
        targetPrice,
        previousTargetPrice: isNaN(prevTarget as any) ? null : prevTarget,
        analystDate,
        sourceSheet: String(item.source_sheet ?? "auto-sync"),
        createdAt: now,
        updatedAt: now,
      });
    }

    try {
      await storage.upsertAnalystTargets(rows);
      console.log(`[analyst-sync] synced ${rows.length}/${items.length} rows`);
      res.json({ ok: true, synced: rows.length });
    } catch (e: any) {
      console.error("[analyst-sync] error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/internal/news-sentiment-sync
  // Body: [{ symbol, market, date, sentiment_score, bullish_ratio, article_count }]
  app.post("/api/internal/news-sentiment-sync", (req, res) => {
    const secret = req.headers["x-sync-secret"];
    if (secret !== process.env.INTERNAL_SYNC_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const rows: any[] = req.body;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: "expected array" });
    }

    const now = new Date().toISOString();
    const stmt = sqlite.prepare(`
      INSERT INTO news_sentiment (symbol, market, date, sentiment_score, bullish_ratio, article_count, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, market, date) DO UPDATE SET
        sentiment_score = excluded.sentiment_score,
        bullish_ratio = excluded.bullish_ratio,
        article_count = excluded.article_count,
        fetched_at = excluded.fetched_at
    `);

    let synced = 0;
    for (const row of rows) {
      try {
        stmt.run(
          row.symbol,
          row.market || "US",
          row.date,
          row.sentiment_score ?? null,
          row.bullish_ratio ?? null,
          row.article_count ?? null,
          now
        );
        synced++;
      } catch (e) {
        // skip bad rows
      }
    }

    return res.json({ synced });
  });

  /**
   * POST /api/internal/historical-prices-sync
   * Called by sector_etf_cron.py to write ETF/stock historical prices into the DB.
   * Requires X-Sync-Secret header matching INTERNAL_SYNC_SECRET env var.
   *
   * Body: { symbol, market, prices: [{ date, open, high, low, close, volume }] }
   */
  app.post("/api/internal/historical-prices-sync", async (req, res) => {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret || req.headers["x-sync-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { symbol, market, prices } = req.body as {
      symbol?: string; market?: string; prices?: any[];
    };
    if (!symbol || !market || !Array.isArray(prices) || prices.length === 0) {
      return res.status(400).json({ error: "symbol, market, and non-empty prices array required" });
    }
    const sym = symbol.toUpperCase();
    const mkt = market.toUpperCase();
    const now = Date.now();

    const rows = prices
      .filter((p: any) => p.date && p.close != null)
      .map((p: any) => ({
        symbol: sym,
        market: mkt,
        date: String(p.date).slice(0, 10),
        open: parseFloat(p.open) || parseFloat(p.close),
        high: parseFloat(p.high) || parseFloat(p.close),
        low: parseFloat(p.low) || parseFloat(p.close),
        close: parseFloat(p.close),
        volume: parseInt(p.volume) || 0,
        updatedAt: now,
      }));

    try {
      await storage.upsertHistoricalPrices(rows);
      console.log(`[historical-prices-sync] ${sym}: upserted ${rows.length} bars`);
      res.json({ ok: true, synced: rows.length });
    } catch (e: any) {
      console.error("[historical-prices-sync] error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/internal/market-indicator-sync
   * Called by sector_etf_cron.py to write market indicators (e.g. 10y_yield) into market_indicators table.
   * Body: { indicatorKey: string, market: string, rows: [{date: string, value: number}] }
   */
  app.post("/api/internal/market-indicator-sync", async (req, res) => {
    const secret = process.env.INTERNAL_SYNC_SECRET;
    if (!secret || req.headers["x-sync-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { indicatorKey, market = "US", rows } = req.body as {
      indicatorKey: string;
      market?: string;
      rows: { date: string; value: number }[];
    };
    if (!indicatorKey || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "Expected indicatorKey and non-empty rows" });
    }
    try {
      const now = new Date().toISOString();
      const insertRows = rows.map(r => ({
        indicatorKey,
        market,
        frequency: "daily",
        date: r.date,
        value: r.value,
        value2: null,
        metaJson: null,
        source: "cron",
        createdAt: now,
        updatedAt: now,
      }));
      await storage.upsertIndicatorHistory(insertRows);
      console.log(`[market-indicator-sync] ${indicatorKey}: upserted ${insertRows.length} rows`);
      res.json({ ok: true, synced: insertRows.length });
    } catch (e: any) {
      console.error("[market-indicator-sync] error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // V6.1: POST /api/history/backfill-2y  — backfill all watchlist symbols to 2 years
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/history/backfill-2y", async (_req, res) => {
    try {
      const allSymbols = [
        ...WATCHLIST_STOCKS.map((s: any) => ({ symbol: s.symbol, market: s.market as "TW" | "US" })),
        ...PORTFOLIO_EXTRA.map((s: any) => ({ symbol: s.symbol, market: s.market as "TW" | "US" })),
      ];
      const seen = new Set<string>();
      const unique = allSymbols.filter(({ symbol, market }) => {
        const key = `${symbol}:${market}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const results: Record<string, number> = {};
      for (const { symbol, market } of unique) {
        try {
          const r = await backfillHistoryTo2Years(symbol, market);
          results[`${symbol}:${market}`] = r.added;
        } catch (e: any) {
          results[`${symbol}:${market}`] = -99;
        }
      }
      res.json({ ok: true, results });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // V6.1: POST /api/prediction/run
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/prediction/run", async (req, res) => {
    const { symbol, market, horizonDays } = req.body as {
      symbol?: string; market?: string; horizonDays?: number;
    };
    if (!symbol || !market)
      return res.status(400).json({ error: "symbol and market are required" });
    // horizonDays is accepted but ignored — always run full 1..20 horizon set
    try {
      // Get current price from latest historical bar
      const recentBars = await storage.getHistoricalPricesByRange(
        symbol.toUpperCase(), market.toUpperCase(),
        new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
        new Date().toISOString().slice(0, 10),
      );
      const currentPrice = recentBars.length > 0
        ? recentBars.sort((a, b) => b.date.localeCompare(a.date))[0].close
        : 0;
      // Always run full 1..20 horizons so ForecastChart gets all 20 points
      const result = await runPrediction({
        symbol: symbol.toUpperCase(),
        market: market.toUpperCase() as "TW" | "US",
        horizons: Array.from({ length: 20 }, (_, i) => i + 1),
        currentPrice,
        saveToDb: true,
      });
      // Attach the requested horizonDays for frontend display
      res.json({ ...result, horizonDays: horizonDays ?? 20 });
    } catch (e: any) {
      console.error(`[prediction/run] ${symbol} h=${horizonDays}:`, e.message);
      res.status(500).json({ ok: false, error: e.message ?? "Prediction failed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // V6.1: GET /api/prediction-history
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/prediction-history", async (req, res) => {
    const symbol     = (req.query.symbol  as string ?? "").toUpperCase();
    const market     = (req.query.market  as string ?? "").toUpperCase();
    const horizonDays = parseInt(req.query.horizon as string ?? "", 10);
    const from       = req.query.from as string;
    const to         = req.query.to   as string;

    if (!symbol || !market) return res.status(400).json({ error: "symbol and market are required" });
    if (isNaN(horizonDays) || ![5, 20, 60].includes(horizonDays))
      return res.status(400).json({ error: "horizon must be 5, 20, or 60" });
    if (!from || !to) return res.status(400).json({ error: "from and to are required" });

    try {
      const rows = storage.getModelPredictions(symbol, market, horizonDays, from, to);
      const todayISO = new Date().toISOString().slice(0, 10);

      const results = await Promise.all(rows.map(async (row) => {
        const medianPath: {date:string;price:number}[] = row.medianPathJson ? JSON.parse(row.medianPathJson) : [];
        const lowerPath:  {date:string;price:number}[] = row.lowerPathJson  ? JSON.parse(row.lowerPathJson)  : [];
        const upperPath:  {date:string;price:number}[] = row.upperPathJson  ? JSON.parse(row.upperPathJson)  : [];

        const item: any = { runAt: row.runAt, horizonDays: row.horizonDays, startDate: row.startDate, endDate: row.endDate, medianPath, upperPath, lowerPath, modelName: row.modelName };

        // Compute accuracy if prediction window is in the past
        if (row.endDate <= todayISO && medianPath.length >= 2) {
          try {
            const actual = await storage.getHistoricalPricesByRange(symbol, market, row.startDate, row.endDate);
            if (actual.length >= 2) {
              const actualMap = new Map(actual.map(p => [p.date, p.close]));
              let sumAbsErr = 0, sumAbsPctErr = 0, count = 0;
              for (const pt of medianPath) {
                const a = actualMap.get(pt.date);
                if (a !== undefined && a > 0) {
                  const e = Math.abs(pt.price - a);
                  sumAbsErr += e; sumAbsPctErr += e / a; count++;
                }
              }
              if (count > 0) {
                const predUp   = medianPath[medianPath.length-1].price > medianPath[0].price;
                const actualUp = actual[actual.length-1].close > actual[0].close;
                item.accuracy = { mae: sumAbsErr/count, mape: (sumAbsPctErr/count)*100, directionCorrect: predUp === actualUp };
              }
            }
          } catch { /* non-fatal */ }
        }
        return item;
      }));
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // V6.1 NEW: POST /api/predictions/trigger — trigger 1~20 prediction run
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/predictions/trigger", async (req, res) => {
    const { symbol, market } = req.body as { symbol?: string; market?: string };
    if (!symbol || !market)
      return res.status(400).json({ error: "symbol and market are required" });
    try {
      const recentBars = await storage.getHistoricalPricesByRange(
        symbol.toUpperCase(), market.toUpperCase(),
        new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
        new Date().toISOString().slice(0, 10),
      );
      const currentPrice = recentBars.length > 0
        ? recentBars.sort((a: any, b: any) => b.date.localeCompare(a.date))[0].close
        : 0;
      const result = await runPrediction({
        symbol: symbol.toUpperCase(),
        market: market.toUpperCase() as "TW" | "US",
        horizons: Array.from({ length: 20 }, (_, i) => i + 1),
        currentPrice,
        saveToDb: true,
      });
      res.json(result);
    } catch (e: any) {
      console.error(`[predictions/trigger] ${symbol}:`, e.message);
      res.status(500).json({ ok: false, error: e.message ?? "Prediction failed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // V6.1 NEW: GET /api/predictions/latest — latest run's 20-point paths
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/predictions/latest", async (req, res) => {
    const symbol = (req.query.symbol as string ?? "").toUpperCase();
    const market = (req.query.market as string ?? "").toUpperCase();
    if (!symbol || !market)
      return res.status(400).json({ error: "symbol and market are required" });
    try {
      const row = (storage as any).getLatestModelPrediction(symbol, market, 20) as any;
      if (!row) {
        // Kick off a background prediction for this symbol (non-blocking)
        ensurePrediction(symbol, market).catch(() => {});
        return res.json({ ok: false, found: false, queued: true, message: "No prediction found — queued" });
      }

      // Parse horizons and meta from metaJson if present
      let horizons: Record<string, any> | null = null;
      let parsedMeta: Record<string, any> | null = null;
      if (row.metaJson) {
        try {
          const meta = JSON.parse(row.metaJson);
          if (meta.horizonsJson) horizons = JSON.parse(meta.horizonsJson);
          // Strip horizonsJson (large) before sending to client; keep featureCoverage etc.
          const { horizonsJson: _h, featuresUsed: _f, ...metaRest } = meta;
          parsedMeta = metaRest;
        } catch { /* non-fatal */ }
      }

      // Fallback: reconstruct horizons from medianPath / lowerPath / upperPath
      if (!horizons && row.medianPathJson) {
        const median: Array<{date:string;price:number}> = JSON.parse(row.medianPathJson);
        const lower:  Array<{date:string;price:number}> = row.lowerPathJson ? JSON.parse(row.lowerPathJson) : [];
        const upper:  Array<{date:string;price:number}> = row.upperPathJson ? JSON.parse(row.upperPathJson) : [];
        const baseP = row.basePrice ?? (median[0]?.price ?? 0);
        horizons = {};
        for (let i = 0; i < median.length; i++) {
          const h = i + 1;
          horizons[String(h)] = {
            targetDate:    median[i].date,
            medianPrice:   median[i].price,
            lowerPrice:    lower[i]?.price  ?? median[i].price,
            upperPrice:    upper[i]?.price  ?? median[i].price,
            medianReturn:  baseP > 0 ? (median[i].price - baseP) / baseP * 100 : 0,
            upProbability: 0.5,
            topFeatures:   [],
          };
        }
      }

      res.json({
        ok:         true,
        found:      true,
        run_id:     row.runId   ?? null,
        runAt:      row.runAt,
        baseDate:   row.baseDate  ?? null,
        basePrice:  row.basePrice ?? null,
        symbol:     row.symbol,
        market:     row.market,
        horizons,
        meta:       parsedMeta ?? {},
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // V6.1 NEW: GET /api/predictions/history — list recent run_ids
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/predictions/history", async (req, res) => {
    const symbol = (req.query.symbol as string ?? "").toUpperCase();
    const market = (req.query.market as string ?? "").toUpperCase();
    const limit  = Math.min(parseInt(req.query.limit as string ?? "10", 10) || 10, 30);
    if (!symbol || !market)
      return res.status(400).json({ error: "symbol and market are required" });
    try {
      const runs = (storage as any).getModelPredictionHistory(symbol, market, limit);
      res.json({ ok: true, runs });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // V6.1 NEW: GET /api/predictions/run/:run_id — full run data
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/predictions/run/:run_id", async (req, res) => {
    const run_id = req.params.run_id;
    if (!run_id) return res.status(400).json({ error: "run_id required" });
    try {
      const row = (storage as any).getModelPredictionByRunId(run_id);
      if (!row) return res.status(404).json({ ok: false, error: "run not found" });

      let horizons: Record<string, any> | null = null;
      if (row.metaJson) {
        try {
          const meta = JSON.parse(row.metaJson);
          if (meta.horizonsJson) horizons = JSON.parse(meta.horizonsJson);
        } catch { /* non-fatal */ }
      }
      if (!horizons && row.medianPathJson) {
        const median: Array<{date:string;price:number}> = JSON.parse(row.medianPathJson);
        const lower:  Array<{date:string;price:number}> = row.lowerPathJson ? JSON.parse(row.lowerPathJson) : [];
        const upper:  Array<{date:string;price:number}> = row.upperPathJson ? JSON.parse(row.upperPathJson) : [];
        const baseP = row.basePrice ?? (median[0]?.price ?? 0);
        horizons = {};
        for (let i = 0; i < median.length; i++) {
          const h = i + 1;
          horizons[String(h)] = {
            targetDate:    median[i].date,
            medianPrice:   median[i].price,
            lowerPrice:    lower[i]?.price  ?? median[i].price,
            upperPrice:    upper[i]?.price  ?? median[i].price,
            medianReturn:  baseP > 0 ? (median[i].price - baseP) / baseP * 100 : 0,
            upProbability: 0.5,
            topFeatures:   [],
          };
        }
      }

      res.json({
        ok:        true,
        run_id:    row.runId   ?? null,
        runAt:     row.runAt,
        baseDate:  row.baseDate  ?? null,
        basePrice: row.basePrice ?? null,
        symbol:    row.symbol,
        market:    row.market,
        horizons,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/predictions/queue-status — background scheduler progress
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/predictions/queue-status", (_req, res) => {
    res.json(getSchedulerStatus());
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /api/predictions/sweep — manually trigger full watchlist sweep
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/predictions/sweep", (_req, res) => {
    triggerSweepNow();
    res.json({ ok: true, message: "Sweep triggered" });
  });

  // POST /api/predictions/run-all — force re-predict ALL symbols (ignores today's existing)
  // DB keeps only latest per day; old same-day records are deleted before insert.
  app.post("/api/predictions/run-all", (_req, res) => {
    triggerForceAll();
    res.json({ ok: true, message: "Force re-predict all symbols triggered" });
  });

  // V6.1: GET /api/personal-advice
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/personal-advice", async (req, res) => {
    const symbol = (req.query.symbol as string ?? "").toUpperCase();
    const market = (req.query.market as string ?? "") as "TW" | "US";
    if (!symbol || !market) return res.status(400).json({ error: "symbol and market are required" });

    try {
      // Current price from recent history
      const recentBars = await storage.getHistoricalPricesByRange(
        symbol, market,
        new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
        new Date().toISOString().slice(0, 10),
      );
      const currentPrice = recentBars.length > 0
        ? recentBars.sort((a, b) => b.date.localeCompare(a.date))[0].close
        : null;

      // Latest prediction for each horizon
      const horizonPredictions = [5, 20, 60].map((h) => {
        const latest = storage.getLatestModelPrediction(symbol, market, h);
        if (!latest) return null;
        const median: {date:string;price:number}[] = latest.medianPathJson ? JSON.parse(latest.medianPathJson) : [];
        const lower:  {date:string;price:number}[] = latest.lowerPathJson  ? JSON.parse(latest.lowerPathJson)  : [];
        const upper:  {date:string;price:number}[] = latest.upperPathJson  ? JSON.parse(latest.upperPathJson)  : [];
        if (median.length < 2) return null;
        const pct = (path: {price:number}[]) => path.length < 2 ? null : (path[path.length-1].price - path[0].price) / path[0].price * 100;
        return {
          horizonDays: h,
          expectedReturnPct:  pct(median),
          downsideRiskPct:    pct(lower),
          upsidePotentialPct: pct(upper),
          upProbability: null,
        };
      }).filter(Boolean) as any[];

      // Analyst consensus features
      const analystFeatures = await buildAnalystConsensusFeatures(symbol, market, currentPrice ?? 0);

      // Personal position state
      const positionState = await buildPersonalPositionState(symbol, market, currentPrice);

      // Generate advice
      const advice = generatePersonalAdvice(symbol, market, currentPrice, horizonPredictions, analystFeatures, DEFAULT_STRATEGY, positionState);

      res.json({ ...advice, positionState, horizonPredictions, analystFeatures });
    } catch (e: any) {
      console.error(`[personal-advice] ${symbol}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market Trend API — 大盤趨勢分析
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/predictions/optimize-status
  app.get("/api/predictions/optimize-status", (_req, res) => {
    const rows = sqlite.prepare(`
      SELECT symbol, market, rf_weight, gb_weight, lr_weight,
             last_optimized_at, sample_count
      FROM model_weights ORDER BY market, symbol
    `).all();

    const counts = sqlite.prepare(`
      SELECT symbol, market, COUNT(*) as total,
             SUM(CASE WHEN actual_return IS NOT NULL THEN 1 ELSE 0 END) as filled
      FROM prediction_tracking GROUP BY symbol, market
    `).all() as any[];

    const countMap = Object.fromEntries(counts.map((r: any) => [`${r.symbol}_${r.market}`, r]));

    const lastOpt = sqlite.prepare(`
      SELECT MAX(last_optimized_at) as last FROM model_weights
    `).get() as any;

    res.json({ weights: rows, counts: countMap, lastOptimizedAt: lastOpt?.last ?? null });
  });

  // POST /api/predictions/optimize — SSE stream
  app.post("/api/predictions/optimize", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const symbols = sqlite.prepare(`
        SELECT DISTINCT pt.symbol, pt.market
        FROM prediction_tracking pt
        WHERE pt.actual_return IS NOT NULL
        ORDER BY pt.market, pt.symbol
      `).all() as Array<{ symbol: string; market: string }>;

      const indexSymbols = [
        { symbol: "^DJI", market: "INDEX" },
        { symbol: "^GSPC", market: "INDEX" },
        { symbol: "^IXIC", market: "INDEX" },
        { symbol: "^SOX", market: "INDEX" },
      ];
      const allSymbols = [...symbols, ...indexSymbols.filter(i =>
        !symbols.find(s => s.symbol === i.symbol)
      )];

      send({ type: "start", total: allSymbols.length });

      const nowStr = new Date().toISOString().slice(0, 10);

      for (let i = 0; i < allSymbols.length; i++) {
        const { symbol, market } = allSymbols[i];

        try {
          const rows = sqlite.prepare(`
            SELECT pt.horizon, pt.base_price, pt.predicted_return, pt.actual_return,
                   pt.direction_correct,
                   mp.rf_json, mp.gb_json, mp.lr_json
            FROM prediction_tracking pt
            LEFT JOIN modelpredictions mp ON mp.run_id = pt.run_id
            WHERE pt.symbol = ? AND pt.market = ? AND pt.actual_return IS NOT NULL
            ORDER BY pt.run_date ASC
          `).all(symbol, market) as any[];

          if (rows.length < 5) {
            sqlite.prepare(`
              INSERT INTO model_weights (symbol, market, rf_weight, gb_weight, lr_weight,
                                         last_optimized_at, sample_count, notes)
              VALUES (?, ?, 0.20, 0.50, 0.30, ?, ?, 'insufficient_data')
              ON CONFLICT(symbol, market) DO UPDATE SET
                last_optimized_at = excluded.last_optimized_at,
                notes = excluded.notes
            `).run(symbol, market, nowStr, rows.length);

            send({ type: "progress", index: i + 1, total: allSymbols.length,
                   symbol, market, status: "skipped", sampleCount: rows.length });
            continue;
          }

          // Grid search: find best rf/gb/lr weights
          interface GridResult { rf: number; gb: number; lr: number; dirAcc: number }
          let bestResult: GridResult = { rf: 0.20, gb: 0.50, lr: 0.30, dirAcc: 0 };

          const hasRaw = rows.some((r: any) => r.rf_json !== null && r.rf_json !== undefined);

          if (hasRaw) {
            for (let wRf = 0; wRf <= 10; wRf++) {
              for (let wGb = 0; wGb <= 10 - wRf; wGb++) {
                const wLr = 10 - wRf - wGb;
                const rf = wRf / 10, gb = wGb / 10, lr = wLr / 10;

                let correct = 0, total = 0;
                for (const row of rows) {
                  if (!row.rf_json || !row.gb_json) continue;
                  try {
                    const rfPreds = JSON.parse(row.rf_json);
                    const gbPreds = JSON.parse(row.gb_json);
                    const lrPreds = JSON.parse(row.lr_json || "{}");
                    const h = String(row.horizon);
                    const rfP = rfPreds[h] ?? row.predicted_return;
                    const gbP = gbPreds[h] ?? row.predicted_return;
                    const lrP = lrPreds[h] ?? row.predicted_return;
                    const blended = rf * rfP + gb * gbP + lr * lrP;
                    const actual = row.actual_return;
                    if (Math.sign(blended) === Math.sign(actual)) correct++;
                    total++;
                  } catch { continue; }
                }
                if (total > 0) {
                  const dirAcc = correct / total;
                  if (dirAcc > bestResult.dirAcc) {
                    bestResult = { rf, gb, lr, dirAcc };
                  }
                }
              }
            }
          } else {
            bestResult = { rf: 0.20, gb: 0.50, lr: 0.30, dirAcc: 0 };
          }

          const dirAccRf = rows.filter((r: any) => r.direction_correct === 1).length / rows.length;

          sqlite.prepare(`
            INSERT INTO model_weights (symbol, market, rf_weight, gb_weight, lr_weight,
                                       last_optimized_at, sample_count, dir_acc_rf, dir_acc_gb, dir_acc_lr, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, market) DO UPDATE SET
              rf_weight = excluded.rf_weight,
              gb_weight = excluded.gb_weight,
              lr_weight = excluded.lr_weight,
              last_optimized_at = excluded.last_optimized_at,
              sample_count = excluded.sample_count,
              dir_acc_rf = excluded.dir_acc_rf,
              dir_acc_gb = excluded.dir_acc_gb,
              dir_acc_lr = excluded.dir_acc_lr,
              notes = excluded.notes
          `).run(
            symbol, market,
            bestResult.rf, bestResult.gb, bestResult.lr,
            nowStr, rows.length,
            dirAccRf, dirAccRf, dirAccRf,
            hasRaw ? `grid_search_${rows.length}samples` : `default_no_raw`
          );

          send({
            type: "progress", index: i + 1, total: allSymbols.length,
            symbol, market, status: "ok",
            sampleCount: rows.length,
            weights: { rf: bestResult.rf, gb: bestResult.gb, lr: bestResult.lr },
            dirAcc: bestResult.dirAcc,
          });

        } catch (err: any) {
          send({ type: "progress", index: i + 1, total: allSymbols.length,
                 symbol, market, status: "error", error: err.message });
        }
      }

      send({ type: "done", optimizedAt: nowStr });
      res.end();

    } catch (err: any) {
      send({ type: "error", message: err.message });
      res.end();
    }
  });

  // ── Trend Analysis helpers ───────────────────────────────────────────────

  function computeTrendAnalysis(
    bars: Array<{date: string; close: number; high: number; low: number; volume: number}>,
    qqq: Array<{date: string; close: number}>
  ) {
    if (bars.length < 65) return null;

    const closes = bars.map(b => b.close).reverse(); // oldest first
    const vols = bars.map(b => b.volume).reverse();
    const n = closes.length;

    const ma = (arr: number[], period: number, idx: number) => {
      if (idx < period - 1) return null;
      return arr.slice(idx - period + 1, idx + 1).reduce((a, b) => a + b, 0) / period;
    };

    const last = n - 1;
    const ma5  = ma(closes, 5,  last)!;
    const ma20 = ma(closes, 20, last)!;
    const ma60 = ma(closes, 60, last)!;
    const price = closes[last];

    const slope = (period: number, lookback: number = 5) => {
      const cur = ma(closes, period, last);
      const prev = ma(closes, period, last - lookback);
      if (!cur || !prev) return 0;
      return (cur - prev) / prev * 100;
    };

    const ma5slope  = slope(5);
    const ma20slope = slope(20);
    const ma60slope = slope(60);

    // RSI
    const rsiPeriod = 14;
    const gains: number[] = [], losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    const avgGain = gains.slice(-rsiPeriod).reduce((a,b)=>a+b,0)/rsiPeriod;
    const avgLoss = losses.slice(-rsiPeriod).reduce((a,b)=>a+b,0)/rsiPeriod;
    const rsi = avgLoss === 0 ? 100 : 100 - 100/(1 + avgGain/avgLoss);

    // Volume trend
    const vol5  = vols.slice(-5).reduce((a,b)=>a+b,0)/5;
    const vol20 = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
    const volRatio = vol5 / (vol20 || 1);

    // MACD simplified
    const ema = (arr: number[], span: number) => {
      const k = 2/(span+1);
      let e = arr[0];
      for (let i = 1; i < arr.length; i++) e = arr[i]*k + e*(1-k);
      return e;
    };
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdHist = ema12 - ema26;

    // Support/resistance
    const highs5  = bars.slice(0, 5).map(b => b.high);
    const lows5   = bars.slice(0, 5).map(b => b.low);
    const highs20 = bars.slice(0, 20).map(b => b.high);
    const lows20  = bars.slice(0, 20).map(b => b.low);
    const highs60 = bars.slice(0, 60).map(b => b.high);
    const lows60  = bars.slice(0, 60).map(b => b.low);

    const resistance5  = Math.max(...highs5);
    const support5     = Math.min(...lows5);
    const resistance20 = Math.max(...highs20);
    const support20    = Math.min(...lows20);
    const resistance60 = Math.max(...highs60);
    const support60    = Math.min(...lows60);

    function trendLabel(
      priceVal: number, maVal: number, maSlope: number,
      rsiVal: number, _volRatio: number, _period: "short"|"medium"|"long"
    ): { label: string; score: number } {
      const aboveMa = priceVal > maVal;
      const slopeStrong = Math.abs(maSlope) > 0.3;
      const rsiOverbought = rsiVal > 70;
      const rsiOversold = rsiVal < 30;

      if (aboveMa && maSlope > 0.3 && rsiVal > 55) return { label: "強多", score: 85 };
      if (aboveMa && maSlope > 0 && !rsiOverbought) return { label: "偏多趨強", score: 70 };
      if (aboveMa && maSlope <= 0) return { label: "偏多趨弱", score: 55 };
      if (!aboveMa && !slopeStrong) return { label: "盤整", score: 50 };
      if (!aboveMa && maSlope < 0 && !rsiOversold) return { label: "偏空趨弱", score: 35 };
      if (!aboveMa && maSlope < -0.3 && rsiVal < 45) return { label: "強空", score: 20 };
      return { label: "盤整", score: 50 };
    }

    const shortLabel = trendLabel(price, ma5, ma5slope, rsi, volRatio, "short");
    const midLabel   = trendLabel(price, ma20, ma20slope, rsi, volRatio, "medium");
    const longLabel  = trendLabel(price, ma60, ma60slope, rsi, volRatio, "long");

    function buildDesc(
      period: string, _label: string, priceVal: number, maVal: number,
      maSlope: number, rsiVal: number, volR: number,
      support: number, resistance: number
    ): string {
      const distPct = ((priceVal - maVal) / maVal * 100).toFixed(2);
      const slopeTxt = maSlope > 0.3 ? "向上加速" : maSlope > 0 ? "平穩向上" : maSlope > -0.3 ? "趨於平緩" : "向下走軟";
      const rsiTxt = rsiVal > 70 ? `RSI ${rsiVal.toFixed(0)}（超買區）` : rsiVal < 30 ? `RSI ${rsiVal.toFixed(0)}（超賣區）` : `RSI ${rsiVal.toFixed(0)}（中性）`;
      const volTxt = volR > 1.2 ? "成交量明顯放大（動能增強）" : volR < 0.8 ? "成交量萎縮（動能偏弱）" : "成交量正常";
      return `SOX 現價 ${priceVal.toFixed(2)}，${period}MA ${maVal.toFixed(2)}（乖離 ${distPct}%），均線斜率${slopeTxt}。${rsiTxt}，${volTxt}。關鍵支撐 ${support.toFixed(2)}，壓力 ${resistance.toFixed(2)}。`;
    }

    return {
      price, rsi, volRatio, macdHist,
      short: {
        ...shortLabel,
        ma: ma5, maSlope: ma5slope,
        support: support5, resistance: resistance5,
        desc: buildDesc("5日", shortLabel.label, price, ma5, ma5slope, rsi, volRatio, support5, resistance5),
      },
      medium: {
        ...midLabel,
        ma: ma20, maSlope: ma20slope,
        support: support20, resistance: resistance20,
        desc: buildDesc("20日", midLabel.label, price, ma20, ma20slope, rsi, volRatio, support20, resistance20),
      },
      long: {
        ...longLabel,
        ma: ma60, maSlope: ma60slope,
        support: support60, resistance: resistance60,
        desc: buildDesc("60日", longLabel.label, price, ma60, ma60slope, rsi, volRatio, support60, resistance60),
      },
    };
  }

  function computeCrashRisk(
    bars: Array<{date: string; close: number; high: number; low: number; volume: number}>
  ) {
    if (bars.length < 30) return null;

    const closes = bars.map(b => b.close).reverse();
    const vols = bars.map(b => b.volume).reverse();
    const n = closes.length;
    const last = n - 1;

    let totalScore = 0;
    const factors: Array<{name: string; score: number; maxScore: number; detail: string}> = [];

    // 1. VIX (20 pts)
    const vixRow = sqlite.prepare(`SELECT value FROM market_indicators
      WHERE indicator_key='vix' ORDER BY date DESC LIMIT 1`).get() as any;
    const vix5Row = sqlite.prepare(`SELECT value FROM market_indicators
      WHERE indicator_key='vix' AND date <= date('now', '-5 days') ORDER BY date DESC LIMIT 1`).get() as any;
    let vixScore = 0;
    let vixDetail = "VIX 資料不足";
    if (vixRow) {
      const vixVal = vixRow.value;
      const vix5 = vix5Row?.value ?? vixVal;
      const vixSlope = vixVal - vix5;
      if (vixVal > 30) vixScore = 20;
      else if (vixVal > 25) vixScore = 15;
      else if (vixVal > 20) vixScore = 10;
      else if (vixVal > 15) vixScore = 5;
      if (vixSlope > 3) vixScore = Math.min(20, vixScore + 5);
      vixDetail = `VIX ${vixVal.toFixed(1)}（5日前 ${vix5.toFixed(1)}，斜率 ${vixSlope > 0 ? "+" : ""}${vixSlope.toFixed(1)}）`;
    }
    totalScore += vixScore;
    factors.push({ name: "VIX 恐慌指數", score: vixScore, maxScore: 20, detail: vixDetail });

    // 2. RSI divergence (15 pts)
    const gains: number[] = [], losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    const avgGain14 = gains.slice(-14).reduce((a,b)=>a+b,0)/14;
    const avgLoss14 = losses.slice(-14).reduce((a,b)=>a+b,0)/14;
    const crashRsi = avgLoss14 === 0 ? 100 : 100 - 100/(1 + avgGain14/avgLoss14);
    const avgGain14_prev = gains.slice(-28,-14).reduce((a,b)=>a+b,0)/14;
    const avgLoss14_prev = losses.slice(-28,-14).reduce((a,b)=>a+b,0)/14;
    const rsiPrev = avgLoss14_prev === 0 ? 100 : 100 - 100/(1 + avgGain14_prev/avgLoss14_prev);
    const priceDelta = closes[last] - closes[Math.max(0, last-14)];
    const rsiDelta = crashRsi - rsiPrev;
    let rsiScore = 0;
    let rsiDetail = "";
    if (priceDelta > 0 && rsiDelta < -5) {
      rsiScore = 15; rsiDetail = `價格創新高但RSI走弱（背離，RSI ${crashRsi.toFixed(0)} vs 前期 ${rsiPrev.toFixed(0)}）`;
    } else if (crashRsi > 75) {
      rsiScore = 10; rsiDetail = `RSI ${crashRsi.toFixed(0)} 超買`;
    } else if (crashRsi > 65) {
      rsiScore = 5; rsiDetail = `RSI ${crashRsi.toFixed(0)} 偏高`;
    } else {
      rsiDetail = `RSI ${crashRsi.toFixed(0)}（正常）`;
    }
    totalScore += rsiScore;
    factors.push({ name: "RSI 背離", score: rsiScore, maxScore: 15, detail: rsiDetail });

    // 3. Recent crash magnitude (20 pts) — catches actual drops that pre-warning signals miss
    // Use 5-day window: worst single-day drop and cumulative 5-day return
    const worst1d = Math.min(...Array.from({length: Math.min(5, last)}, (_, i) =>
      (closes[last - i] - closes[last - i - 1]) / closes[last - i - 1] * 100
    ));
    const ret5d = (closes[last] - closes[Math.max(0, last - 5)]) / closes[Math.max(0, last - 5)] * 100;
    let crashMagScore = 0;
    let crashMagDetail = "";
    if (worst1d < -8 || ret5d < -12) {
      crashMagScore = 20; crashMagDetail = `激烈崩跌：5日內最大單日 ${worst1d.toFixed(1)}%，5日累計 ${ret5d.toFixed(1)}%`;
    } else if (worst1d < -5 || ret5d < -8) {
      crashMagScore = 14; crashMagDetail = `明顯下跌：5日內最大單日 ${worst1d.toFixed(1)}%，5日累計 ${ret5d.toFixed(1)}%`;
    } else if (worst1d < -3 || ret5d < -5) {
      crashMagScore = 8; crashMagDetail = `小幅跌勢：5日內最大單日 ${worst1d.toFixed(1)}%，5日累計 ${ret5d.toFixed(1)}%`;
    } else {
      crashMagDetail = `近期跌幅正常：5日內最大單日 ${worst1d.toFixed(1)}%，5日累計 ${ret5d.toFixed(1)}%`;
    }
    totalScore += crashMagScore;
    factors.push({ name: "近期跌幅幅度", score: crashMagScore, maxScore: 20, detail: crashMagDetail });

    // 4. Volume divergence (10 pts) — use SOXX ETF volume (real volume proxy for SOX index)
    const soxxVolRows = sqlite.prepare(`SELECT volume FROM historical_prices
      WHERE symbol='SOXX' AND market='US' ORDER BY date DESC LIMIT 25`).all() as any[];
    let volScore = 0;
    let volDetail = "";
    if (soxxVolRows.length >= 10) {
      const cvol5  = soxxVolRows.slice(0, 5).reduce((s: number, r: any) => s + r.volume, 0) / 5;
      const cvol20 = soxxVolRows.slice(0, 20).reduce((s: number, r: any) => s + r.volume, 0) / Math.min(soxxVolRows.length, 20);
      const cvolRatio = cvol5 / (cvol20 || 1);
      const price5d = ret5d;
      if (price5d > 2 && cvolRatio < 0.75) {
        volScore = 10; volDetail = `SOXX 上漲但量縮（量比 ${cvolRatio.toFixed(2)}）— 上漲乏力`;
      } else if (price5d > 0 && cvolRatio < 0.85) {
        volScore = 5; volDetail = `SOXX 上漲但量偏縮（量比 ${cvolRatio.toFixed(2)}）`;
      } else if (price5d < -3 && cvolRatio > 1.5) {
        volScore = 8; volDetail = `SOXX 下跌且量萃（量比 ${cvolRatio.toFixed(2)}）— 抋盤加劇`;
      } else {
        volDetail = `SOXX 量比 ${cvolRatio.toFixed(2)}（正常）`;
      }
    } else {
      volDetail = "成交量資料不足";
    }
    totalScore += volScore;
    factors.push({ name: "成交量背離", score: volScore, maxScore: 10, detail: volDetail });

    // 4. Credit spread HYG/LQD (15 pts)
    const hygBars = sqlite.prepare(`SELECT date, close FROM historical_prices
      WHERE symbol='HYG' AND market='US' ORDER BY date DESC LIMIT 10`).all() as any[];
    const lqdBars = sqlite.prepare(`SELECT date, close FROM historical_prices
      WHERE symbol='LQD' AND market='US' ORDER BY date DESC LIMIT 10`).all() as any[];
    let creditScore = 0;
    let creditDetail = "信用利差資料不足";
    if (hygBars.length >= 5 && lqdBars.length >= 5) {
      const ratioNow  = hygBars[0].close / lqdBars[0].close;
      const ratio5    = hygBars[4].close / lqdBars[4].close;
      const creditChg = (ratioNow - ratio5) / ratio5 * 100;
      if (creditChg < -1.5) { creditScore = 15; creditDetail = `信用利差擴大（HYG/LQD 5日變化 ${creditChg.toFixed(2)}%）— 違約風險升高`; }
      else if (creditChg < -0.5) { creditScore = 8; creditDetail = `信用利差略微擴大（${creditChg.toFixed(2)}%）`; }
      else { creditDetail = `信用利差穩定（${creditChg.toFixed(2)}%）`; }
    }
    totalScore += creditScore;
    factors.push({ name: "信用利差（HYG/LQD）", score: creditScore, maxScore: 15, detail: creditDetail });

    // 5. MACD (10 pts)
    const cema = (arr: number[], span: number, fromEnd: number = 0) => {
      const k = 2/(span+1);
      const slice = fromEnd ? arr.slice(0, arr.length - fromEnd) : arr;
      let e = slice[0];
      for (let i = 1; i < slice.length; i++) e = slice[i]*k + e*(1-k);
      return e;
    };
    const cema12 = cema(closes, 12);
    const cema26 = cema(closes, 26);
    const cema12p = cema(closes, 12, 5);
    const cema26p = cema(closes, 26, 5);
    const macd = cema12 - cema26;
    const macdPrev = cema12p - cema26p;
    let macdScore = 0;
    let macdDetail = "";
    if (macd < 0 && macdPrev >= 0) { macdScore = 10; macdDetail = "MACD 剛發生死叉（中期轉空訊號）"; }
    else if (macd < 0) { macdScore = 6; macdDetail = `MACD 持續負值（${macd.toFixed(2)}）`; }
    else if (macd > 0 && macdPrev <= 0) { macdDetail = "MACD 剛發生金叉（轉多訊號）"; }
    else { macdDetail = `MACD 正值（${macd.toFixed(2)}）`; }
    totalScore += macdScore;
    factors.push({ name: "MACD 狀態", score: macdScore, maxScore: 10, detail: macdDetail });

    // 6. Bollinger band (10 pts)
    const cma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const std20 = Math.sqrt(closes.slice(-20).reduce((a,b)=>a+(b-cma20)**2,0)/20);
    const bbUpper = cma20 + 2*std20;
    let bbScore = 0;
    let bbDetail = "";
    const lastClose = closes[last];
    if (lastClose > bbUpper) { bbScore = 10; bbDetail = "價格突破布林上軌（過熱，均值回歸壓力）"; }
    else if (lastClose > cma20 + 1.5*std20) { bbScore = 5; bbDetail = "價格接近布林上軌（偏高）"; }
    else if ((bbUpper - (cma20 - 2*std20)) / cma20 < 0.04) { bbScore = 5; bbDetail = "布林帶收窄（大波動即將出現）"; }
    else { bbDetail = `布林帶正常（價格 ${((lastClose-cma20)/std20).toFixed(1)} σ）`; }
    totalScore += bbScore;
    factors.push({ name: "布林帶位置", score: bbScore, maxScore: 10, detail: bbDetail });

    const finalScore = Math.min(100, Math.round(totalScore));

    let level: string, color: string;
    if (finalScore >= 80)      { level = "極度危險"; color = "red"; }
    else if (finalScore >= 60) { level = "高度警戒"; color = "orange"; }
    else if (finalScore >= 40) { level = "中度警戒"; color = "yellow"; }
    else if (finalScore >= 20) { level = "低度風險"; color = "blue"; }
    else                       { level = "安全"; color = "green"; }

    return { score: finalScore, level, color, factors };
  }

  // GET /api/market-trend — main data endpoint
  app.get("/api/market-trend", async (_req, res) => {
    try {
      const result: any = {};

      // 1. Sector ETF returns
      const SECTOR_ETFS = [
        { symbol: "SOXX", name: "美國半導體", theme: "科技" },
        { symbol: "SMH",  name: "半導體設備與製造", theme: "科技" },
        { symbol: "XLI",  name: "工業製造", theme: "景氣循環" },
        { symbol: "XBI",  name: "生技醫療", theme: "防禦/成長" },
        { symbol: "IBB",  name: "大型生技", theme: "防禦/成長" },
        { symbol: "CIBR", name: "網路安全", theme: "科技" },
        { symbol: "HACK", name: "資安科技", theme: "科技" },
        { symbol: "ARKX", name: "太空探索", theme: "主題成長" },
        { symbol: "ARKQ", name: "自動化與機器人", theme: "主題成長" },
        { symbol: "XLU",  name: "公用事業（防禦）", theme: "防禦" },
        { symbol: "URNM", name: "鈾與核能", theme: "能源" },
      ];

      const sectorData = [];
      for (const etf of SECTOR_ETFS) {
        const bars = sqlite.prepare(`
          SELECT date, close FROM historical_prices
          WHERE symbol=? AND market='US' ORDER BY date DESC LIMIT 65
        `).all(etf.symbol) as Array<{date: string; close: number}>;

        if (bars.length < 2) {
          sectorData.push({ ...etf, ret1w: null, ret1m: null, ret3m: null, latestClose: null });
          continue;
        }

        const latest = bars[0].close;
        const get = (idx: number) => bars[Math.min(idx, bars.length - 1)]?.close;

        sectorData.push({
          ...etf,
          latestClose: latest,
          ret1w:  get(5)  ? ((latest - get(5))  / get(5)  * 100) : null,
          ret1m:  get(21) ? ((latest - get(21)) / get(21) * 100) : null,
          ret3m:  get(63) ? ((latest - get(63)) / get(63) * 100) : null,
          date: bars[0].date,
        });
      }
      result.sectors = sectorData;

      // Fetch SOX bars once — used for both trend analysis and crash risk
      const soxBars = sqlite.prepare(`
        SELECT date, close, high, low, volume FROM historical_prices
        WHERE symbol='^SOX' AND market='INDEX' ORDER BY date DESC LIMIT 120
      `).all() as Array<{date: string; close: number; high: number; low: number; volume: number}>;

      // 2. Trend analysis — use SOX as primary, QQQ as secondary confirmation
      const spyBars = sqlite.prepare(`
        SELECT date, close, high, low, volume FROM historical_prices
        WHERE symbol='SPY' AND market='US' ORDER BY date DESC LIMIT 120
      `).all() as Array<{date: string; close: number; high: number; low: number; volume: number}>;

      const qqqBars = sqlite.prepare(`
        SELECT date, close FROM historical_prices
        WHERE symbol='QQQ' AND market='US' ORDER BY date DESC LIMIT 120
      `).all() as Array<{date: string; close: number}>;

      result.trendAnalysis = computeTrendAnalysis(
        soxBars.length >= 65 ? soxBars : spyBars,
        qqqBars
      );

      // 3. Crash risk index — use ^SOX (Philadelphia Semiconductor Index) as the primary signal
      result.crashRisk = computeCrashRisk(soxBars.length >= 30 ? soxBars : spyBars);

      // 4. Market sentiment
      const fg = sqlite.prepare(`SELECT value, meta_json, date FROM market_indicators
        WHERE indicator_key='fear_greed' ORDER BY date DESC LIMIT 1`).get() as any;
      // VIX: use historical_prices (^VIX, market=INDEX) for full history; fallback to market_indicators
      const vixHist = sqlite.prepare(`SELECT date, close as value FROM historical_prices
        WHERE symbol='^VIX' AND market='INDEX' ORDER BY date DESC LIMIT 90`).all() as any[];
      const vixIndicator = sqlite.prepare(`SELECT value, date FROM market_indicators
        WHERE indicator_key='vix' ORDER BY date DESC LIMIT 1`).get() as any;
      const vixCurrent = vixHist.length > 0 ? vixHist[0].value : (vixIndicator?.value ?? null);
      const vixHistory = vixHist.length >= 10 ? vixHist.reverse() :
        sqlite.prepare(`SELECT value, date FROM market_indicators
          WHERE indicator_key='vix' ORDER BY date DESC LIMIT 90`).all().reverse() as any[];

      // 10Y yield: use historical_prices (^TNX, market=INDEX) for full history
      const tnyHist = sqlite.prepare(`SELECT date, close as value FROM historical_prices
        WHERE symbol='^TNX' AND market='INDEX' ORDER BY date DESC LIMIT 90`).all() as any[];
      const tnyCurrent = tnyHist.length > 0 ? tnyHist[0].value : null;
      const tnyHistory = tnyHist.length >= 10 ? tnyHist.reverse() :
        sqlite.prepare(`SELECT value, date FROM market_indicators
          WHERE indicator_key='10y_yield' ORDER BY date DESC LIMIT 90`).all().reverse() as any[];

      const macro = sqlite.prepare(`SELECT value, date FROM market_indicators
        WHERE indicator_key='macro_sentiment' ORDER BY date DESC LIMIT 1`).get() as any;

      result.sentiment = {
        fearGreed: fg ? { value: fg.value, label: (() => { try { return JSON.parse(fg.meta_json || "{}").classification ?? ""; } catch { return fg.meta_json ?? ""; } })(), date: fg.date } : null,
        vix: vixCurrent != null ? { current: vixCurrent, history: vixHistory } : null,
        tenYear: tnyCurrent != null ? { current: tnyCurrent, history: tnyHistory } : null,
        macro: macro ? { score: macro.value, date: macro.date } : null,
      };

      // 5. HYG/LQD credit spread
      const hyg = sqlite.prepare(`SELECT date, close FROM historical_prices
        WHERE symbol='HYG' AND market='US' ORDER BY date DESC LIMIT 5`).all() as any[];
      const lqd = sqlite.prepare(`SELECT date, close FROM historical_prices
        WHERE symbol='LQD' AND market='US' ORDER BY date DESC LIMIT 5`).all() as any[];
      result.creditSpread = hyg.length > 0 && lqd.length > 0 ? {
        hygClose: hyg[0].close, lqdClose: lqd[0].close,
        ratio: hyg[0].close / lqd[0].close,
        date: hyg[0].date,
      } : null;

      res.json(result);
    } catch (err: any) {
      console.error("[market-trend] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/market-trend/index-history/:symbol
  // Auto-refreshes via yfinance if DB is stale (missing recent trading days)
  app.get("/api/market-trend/index-history/:symbol", async (req, res) => {
    // sym is the DB/yfinance symbol (always with ^ prefix, e.g. "^GSPC")
    // req.params.symbol may arrive as "^GSPC" or "GSPC" — normalise here
    const rawSym = req.params.symbol;
    const sym = rawSym.startsWith("^") ? rawSym : `^${rawSym}`;
    const yfSym = sym; // already has ^ prefix
    const market = "INDEX";
    try {
      // Gap-fill logic (mirrors getOrSyncHistoricalData for individual stocks):
      // - No data → fetch 2y base history (initial load)
      // - Has data but gap >= 1 US trading day → fetch only the missing range
      // ?reset=1 → wipe all existing bars and force a fresh 2y reload
      if (req.query.reset === "1") {
        sqlite.prepare(`DELETE FROM historical_prices WHERE symbol=? AND market=?`).run(sym, market);
        console.log(`[index-history] reset: cleared all bars for ${sym}`);
      }

      const latest = sqlite.prepare(`
        SELECT MAX(date) as maxDate FROM historical_prices WHERE symbol=? AND market=?
      `).get(sym, market) as any;
      const maxDate: string = latest?.maxDate ?? "";

      const runYfinance = async (script: string) => {
        const { execSync } = await import("child_process");
        const { writeFileSync, unlinkSync } = await import("fs");
        const { tmpdir, platform } = await import("os");
        const { join } = await import("path");
        const py = platform() === "win32" ? "python" : "python3";
        const tmpFile = join(tmpdir(), `idx_hist_${Date.now()}.py`);
        writeFileSync(tmpFile, script, "utf8");
        const raw = execSync(`${py} "${tmpFile}"`, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).toString().trim();
        try { unlinkSync(tmpFile); } catch {}
        const jsonStart = raw.lastIndexOf("[");
        return jsonStart >= 0 ? JSON.parse(raw.slice(jsonStart)) as any[] : [];
      };

      const upsertBars = (rows: any[]) => {
        if (rows.length === 0) return;
        const upsert = sqlite.prepare(`
          INSERT INTO historical_prices (symbol, market, date, open, high, low, close, volume, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol, market, date) DO UPDATE SET
            open=excluded.open, high=excluded.high, low=excluded.low,
            close=excluded.close, volume=excluded.volume, updated_at=excluded.updated_at
        `);
        const now = new Date().toISOString();
        sqlite.transaction((rs: any[]) => {
          for (const r of rs) upsert.run(sym, market, r.date, r.open, r.high, r.low, r.close, r.volume, now);
        })(rows);
      };

      try {
        if (!maxDate) {
          // No data — initial 2y load
          const rows = await runYfinance([
            "import yfinance as yf, json",
            `t = yf.Ticker('${yfSym}')`,
            "hist = t.history(period='2y', auto_adjust=True)",
            "rows = []",
            "for dt, row in hist.iterrows():",
            "    rows.append({'date': str(dt)[:10], 'open': round(float(row['Open']),4), 'high': round(float(row['High']),4), 'low': round(float(row['Low']),4), 'close': round(float(row['Close']),4), 'volume': int(row['Volume'])})",
            "print(json.dumps(rows))",
          ].join("\n"));
          upsertBars(rows);
          console.log(`[index-history] initial load ${sym}: ${rows.length} bars`);
        } else {
          // Count trading day gap (US market)
          const usToday = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10); // EDT approx
          const from = new Date(maxDate + "T00:00:00Z");
          let tradingGap = 0;
          const cur = new Date(from.getTime() + 86400_000);
          while (cur <= new Date(usToday + "T00:00:00Z")) {
            const dow = cur.getUTCDay();
            if (dow !== 0 && dow !== 6) tradingGap++;
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
          if (tradingGap >= 1) {
            // end is exclusive in yfinance, so use tomorrow (usToday+1) to include today's bar
            const usTodayDate = new Date(new Date(usToday + "T00:00:00Z").getTime() + 86400_000)
              .toISOString().slice(0, 10);
            const rows = await runYfinance([
              "import yfinance as yf, json",
              `t = yf.Ticker('${yfSym}')`,
              `hist = t.history(start='${maxDate}', end='${usTodayDate}', auto_adjust=True)`,
              "rows = []",
              "for dt, row in hist.iterrows():",
              "    rows.append({'date': str(dt)[:10], 'open': round(float(row['Open']),4), 'high': round(float(row['High']),4), 'low': round(float(row['Low']),4), 'close': round(float(row['Close']),4), 'volume': int(row['Volume'])})",
              "print(json.dumps(rows))",
            ].join("\n"));
            // Only upsert from maxDate onwards (don't overwrite older bars)
            const filtered = rows.filter((r: any) => r.date >= maxDate);
            upsertBars(filtered);
            console.log(`[index-history] gap-fill ${sym}: ${filtered.length} bars (gap=${tradingGap} days, from ${maxDate})`);
          }
        }
      } catch (fetchErr: any) {
        console.warn(`[index-history] yfinance refresh failed for ${sym}: ${fetchErr.message}`);
      }

      const bars = sqlite.prepare(`
        SELECT date, open, high, low, close, volume FROM historical_prices
        WHERE symbol=? AND market=? ORDER BY date ASC
      `).all(sym, market) as any[];

      if (bars.length === 0) {
        const usBars = sqlite.prepare(`
          SELECT date, open, high, low, close, volume FROM historical_prices
          WHERE symbol=? AND market='US' ORDER BY date ASC
        `).all(sym) as any[];
        return res.json({ symbol: sym, bars: usBars });
      }
      res.json({ symbol: sym, bars });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/market-trend/index-prediction/:symbol
  app.get("/api/market-trend/index-prediction/:symbol", async (req, res) => {
    const sym = decodeURIComponent(req.params.symbol);
    const predMarket = "INDEX";
    try {
      const r = sqlite.prepare(`
        SELECT * FROM modelpredictions
        WHERE symbol=? AND market=?
        ORDER BY run_at DESC, created_at DESC LIMIT 1
      `).get(sym, predMarket) as any;

      if (!r) return res.json({ found: false });

      const meta = r.meta_json ? JSON.parse(r.meta_json) : {};
      let horizons = meta.horizonsJson ? JSON.parse(meta.horizonsJson) : null;

      // Enrich horizons with lowerPrice/upperPrice from lower_path/upper_path
      if (horizons && (r.lower_path || r.lowerPathJson)) {
        const lower: Array<{date:string;price:number}> = JSON.parse(r.lower_path ?? r.lowerPathJson ?? "[]");
        const upper: Array<{date:string;price:number}> = JSON.parse(r.upper_path ?? r.upperPathJson ?? "[]");
        const keys = Object.keys(horizons).map(Number).sort((a, b) => a - b);
        keys.forEach((k, i) => {
          if (horizons[String(k)]) {
            horizons[String(k)].lowerPrice = lower[i]?.price ?? horizons[String(k)].medianPrice;
            horizons[String(k)].upperPrice = upper[i]?.price ?? horizons[String(k)].medianPrice;
          }
        });
      }

      // Also fetch recent past predictions for history comparison
      const pastRuns = sqlite.prepare(`
        SELECT run_at, base_date, base_price, median_path, lower_path, upper_path, meta_json
        FROM modelpredictions
        WHERE symbol=? AND market=?
        ORDER BY run_at DESC, created_at DESC LIMIT 30
      `).all(sym, predMarket) as any[];

      const pastPredictions = pastRuns.map((pr: any) => {
        const prMeta = pr.meta_json ? JSON.parse(pr.meta_json) : {};
        const prHorizons = prMeta.horizonsJson ? JSON.parse(prMeta.horizonsJson) : {};
        const median: Array<{date:string;price:number}> = pr.median_path ? JSON.parse(pr.median_path) : [];
        return {
          runAt: pr.run_at,
          baseDate: pr.base_date,
          basePrice: pr.base_price,
          // day-1 prediction (next day price)
          day1: prHorizons['1'] ?? (median[0] ? { medianPrice: median[0].price, targetDate: median[0].date } : null),
          day5: prHorizons['5'] ?? (median[4] ? { medianPrice: median[4].price, targetDate: median[4].date } : null),
          day20: prHorizons['20'] ?? (median[19] ? { medianPrice: median[19].price, targetDate: median[19].date } : null),
        };
      }).filter((p: any) => p.day1 || p.day5);

      res.json({
        found: true,
        symbol: sym,
        runAt: r.run_at,
        baseDate: r.base_date,
        basePrice: r.base_price,
        horizons,
        medianPath: r.median_path ? JSON.parse(r.median_path) : [],
        pastPredictions,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}
