import {
  type Holding, type InsertHolding, holdings,
  type Alert, type InsertAlert, alerts,
  type WatchlistItem, type InsertWatchlist, watchlist,
  type Transaction, type InsertTransaction, transactions,
  type HistoricalPrice, type InsertHistoricalPrice, historicalPrices,
  type MarketIndicator, type InsertMarketIndicator, marketIndicators,
  type DailyNewsDigest, type InsertDailyNewsDigest, dailyNewsDigest,
  type DailyNewsSource, type InsertDailyNewsSource, dailyNewsSources,
  type WatchlistSectorTag, watchlistSectorTags,
  type AnalystTarget, type InsertAnalystTarget, analystTargets,
  type FundamentalDataRow, type InsertFundamentalData, fundamentalData,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, asc, and, gte, lte, max, desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

// Ensure core tables exist (fresh DB on first run)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    shares REAL NOT NULL,
    avg_cost REAL NOT NULL,
    market TEXT NOT NULL
  )`);
} catch { /* ignore */ }

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    target_price REAL NOT NULL,
    direction TEXT NOT NULL,
    triggered INTEGER NOT NULL DEFAULT 0,
    market TEXT NOT NULL
  )`);
} catch { /* ignore */ }

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    market TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
} catch { /* ignore */ }

// Ensure transactions table exists (migration for existing DBs)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    market TEXT NOT NULL,
    side TEXT NOT NULL,
    shares REAL NOT NULL,
    price REAL NOT NULL,
    total_cost REAL NOT NULL,
    currency TEXT NOT NULL
  )`);
} catch {
  // Already exists — ignore
}

// Ensure historical_prices table exists (migration for existing DBs)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS historical_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS hist_sym_market_date ON historical_prices (symbol, market, date)`);
} catch {
  // Already exists — ignore
}

export const db = drizzle(sqlite);

export interface IStorage {
  // Holdings
  getHoldings(): Promise<Holding[]>;
  addHolding(holding: InsertHolding): Promise<Holding>;
  deleteHolding(id: number): Promise<void>;
  clearAllHoldings(): Promise<void>;

  // Transactions
  getTransactions(): Promise<Transaction[]>;
  getTransactionsBySymbol(symbol: string, market: string): Promise<Transaction[]>;
  importTransactions(rows: InsertTransaction[]): Promise<number>; // returns inserted count
  clearAllTransactions(): Promise<void>;
  getPortfolioSymbols(): Promise<{ symbol: string; name: string; market: string }[]>;

  // Alerts
  getAlerts(): Promise<Alert[]>;
  addAlert(alert: InsertAlert): Promise<Alert>;
  deleteAlert(id: number): Promise<void>;
  triggerAlert(id: number): Promise<void>;

  // Watchlist
  getWatchlist(): Promise<WatchlistItem[]>;
  addToWatchlist(item: InsertWatchlist): Promise<WatchlistItem>;
  removeFromWatchlist(id: number): Promise<void>;
  updateWatchlistOrder(id: number, sortOrder: number): Promise<void>;
  seedDefaultWatchlist(defaults: Array<{ symbol: string; name: string; market: string }>): Promise<void>;

  // Historical Prices
  getHistoricalPrices(symbol: string, market: string): Promise<HistoricalPrice[]>;
  getHistoricalPricesByRange(symbol: string, market: string, fromDate: string, toDate: string): Promise<HistoricalPrice[]>;
  getLatestHistoricalDate(symbol: string, market: string): Promise<string | null>;
  upsertHistoricalPrices(rows: InsertHistoricalPrice[]): Promise<void>;
  deleteHistoricalPrices(symbol: string, market: string): Promise<void>;

  // Market Indicators
  getIndicatorHistory(indicatorKey: string, fromDate?: string): Promise<MarketIndicator[]>;
  getLatestIndicatorDate(indicatorKey: string): Promise<string | null>;
  upsertIndicatorHistory(rows: InsertMarketIndicator[]): Promise<void>;

  // Analyst Targets
  getAnalystTargetsBySymbol(symbol: string, market: string): Promise<AnalystTarget[]>;
  replaceAnalystTargetsForSymbol(symbol: string, market: string, rows: InsertAnalystTarget[]): Promise<void>;
  upsertAnalystTargets(rows: InsertAnalystTarget[]): Promise<void>;
  getLatestAnalystConsensusBySymbol(symbol: string, market: string): Promise<AnalystTarget[]>;

  // Fundamental Data (sync, not async — SQLite is synchronous)
  getFundamental(symbol: string, market: string): FundamentalDataRow | undefined;
  upsertFundamental(row: InsertFundamentalData): void;
  getAllFundamentals(): FundamentalDataRow[];
  clearAllFundamentals(): void;
}

export class DatabaseStorage implements IStorage {
  async getHoldings(): Promise<Holding[]> {
    return db.select().from(holdings).all();
  }

  async addHolding(holding: InsertHolding): Promise<Holding> {
    return db.insert(holdings).values(holding).returning().get();
  }

  async deleteHolding(id: number): Promise<void> {
    db.delete(holdings).where(eq(holdings.id, id)).run();
  }

  async clearAllHoldings(): Promise<void> {
    db.delete(holdings).run();
  }

  async getTransactions(): Promise<Transaction[]> {
    return db.select().from(transactions).orderBy(asc(transactions.tradeDate)).all();
  }

  async getTransactionsBySymbol(symbol: string, market: string): Promise<Transaction[]> {
    return db.select().from(transactions)
      .where(eq(transactions.symbol, symbol))
      .orderBy(asc(transactions.tradeDate))
      .all();
  }

  async importTransactions(rows: InsertTransaction[]): Promise<number> {
    if (rows.length === 0) return 0;
    for (const row of rows) {
      db.insert(transactions).values(row).run();
    }
    return rows.length;
  }

  async clearAllTransactions(): Promise<void> {
    db.delete(transactions).run();
  }

  async getPortfolioSymbols(): Promise<{ symbol: string; name: string; market: string }[]> {
    // Return distinct symbols that have a net positive position (buys > sells)
    // Use sqlite (raw better-sqlite3) because Drizzle ORM doesn't support HAVING on aggregates easily
    const rows = sqlite.prepare(`
      SELECT symbol, name, market,
             SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) AS net_shares
      FROM transactions
      GROUP BY symbol, market
      HAVING net_shares > 0
    `).all() as { symbol: string; name: string; market: string; net_shares: number }[];
    return rows.map(r => ({ symbol: r.symbol, name: r.name, market: r.market }));
  }

  async getAlerts(): Promise<Alert[]> {
    return db.select().from(alerts).all();
  }

  async addAlert(alert: InsertAlert): Promise<Alert> {
    return db.insert(alerts).values({ ...alert, triggered: false }).returning().get();
  }

  async deleteAlert(id: number): Promise<void> {
    db.delete(alerts).where(eq(alerts.id, id)).run();
  }

  async triggerAlert(id: number): Promise<void> {
    db.update(alerts).set({ triggered: true }).where(eq(alerts.id, id)).run();
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    return db.select().from(watchlist).orderBy(asc(watchlist.sortOrder)).all();
  }

  async addToWatchlist(item: InsertWatchlist): Promise<WatchlistItem> {
    // Assign sortOrder = max existing + 1 so new items appear at the bottom
    const existing = db.select().from(watchlist).all();
    const maxOrder = existing.reduce((m, w) => Math.max(m, w.sortOrder), -1);
    return db.insert(watchlist).values({ ...item, sortOrder: maxOrder + 1 }).returning().get();
  }

  async removeFromWatchlist(id: number): Promise<void> {
    db.delete(watchlist).where(eq(watchlist.id, id)).run();
  }

  async updateWatchlistOrder(id: number, sortOrder: number): Promise<void> {
    db.update(watchlist).set({ sortOrder }).where(eq(watchlist.id, id)).run();
  }

  async seedDefaultWatchlist(
    defaults: Array<{ symbol: string; name: string; market: string }>
  ): Promise<void> {
    const existing = db.select().from(watchlist).all();

    // Only seed when the watchlist table is completely empty (first-time install).
    // If the user has already added/removed stocks, we must NOT re-insert anything —
    // otherwise deleted stocks would reappear every time the server restarts.
    if (existing.length > 0) return;

    let nextOrder = 0;
    for (const d of defaults) {
      db.insert(watchlist).values({ symbol: d.symbol, name: d.name, market: d.market, sortOrder: nextOrder++ }).run();
    }
  }

  // ---------------------------------------------------------------------------
  // Historical Prices
  // ---------------------------------------------------------------------------

  async getHistoricalPrices(symbol: string, market: string): Promise<HistoricalPrice[]> {
    return db.select().from(historicalPrices)
      .where(and(eq(historicalPrices.symbol, symbol), eq(historicalPrices.market, market)))
      .orderBy(asc(historicalPrices.date))
      .all();
  }

  async getHistoricalPricesByRange(
    symbol: string,
    market: string,
    fromDate: string,
    toDate: string
  ): Promise<HistoricalPrice[]> {
    return db.select().from(historicalPrices)
      .where(
        and(
          eq(historicalPrices.symbol, symbol),
          eq(historicalPrices.market, market),
          gte(historicalPrices.date, fromDate),
          lte(historicalPrices.date, toDate)
        )
      )
      .orderBy(asc(historicalPrices.date))
      .all();
  }

  async getLatestHistoricalDate(symbol: string, market: string): Promise<string | null> {
    const row = db.select({ maxDate: max(historicalPrices.date) })
      .from(historicalPrices)
      .where(and(eq(historicalPrices.symbol, symbol), eq(historicalPrices.market, market)))
      .get();
    return row?.maxDate ?? null;
  }

  async upsertHistoricalPrices(rows: InsertHistoricalPrice[]): Promise<void> {
    if (rows.length === 0) return;
    // Use raw SQL for SQLite INSERT OR REPLACE for efficient upsert
    const stmt = sqlite.prepare(`
      INSERT INTO historical_prices (symbol, market, date, open, high, low, close, volume, updated_at)
      VALUES (@symbol, @market, @date, @open, @high, @low, @close, @volume, @updatedAt)
      ON CONFLICT (symbol, market, date) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        updated_at = excluded.updated_at
    `);
    const upsertMany = sqlite.transaction((items: InsertHistoricalPrice[]) => {
      for (const row of items) {
        stmt.run(row);
      }
    });
    upsertMany(rows);
  }

  async deleteHistoricalPrices(symbol: string, market: string): Promise<void> {
    db.delete(historicalPrices)
      .where(and(eq(historicalPrices.symbol, symbol), eq(historicalPrices.market, market)))
      .run();
  }

  // ---------------------------------------------------------------------------
  // Market Indicators
  // ---------------------------------------------------------------------------

  async getIndicatorHistory(indicatorKey: string, fromDate?: string): Promise<MarketIndicator[]> {
    if (fromDate) {
      return db.select().from(marketIndicators)
        .where(and(eq(marketIndicators.indicatorKey, indicatorKey), gte(marketIndicators.date, fromDate)))
        .orderBy(asc(marketIndicators.date))
        .all();
    }
    return db.select().from(marketIndicators)
      .where(eq(marketIndicators.indicatorKey, indicatorKey))
      .orderBy(asc(marketIndicators.date))
      .all();
  }

  async getLatestIndicatorDate(indicatorKey: string): Promise<string | null> {
    const row = db.select({ maxDate: max(marketIndicators.date) })
      .from(marketIndicators)
      .where(eq(marketIndicators.indicatorKey, indicatorKey))
      .get();
    return row?.maxDate ?? null;
  }

  async upsertIndicatorHistory(rows: InsertMarketIndicator[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = sqlite.prepare(`
      INSERT INTO market_indicators
        (indicator_key, market, frequency, date, value, value2, meta_json, source, created_at, updated_at)
      VALUES
        (@indicatorKey, @market, @frequency, @date, @value, @value2, @metaJson, @source, @createdAt, @updatedAt)
      ON CONFLICT (indicator_key, date) DO UPDATE SET
        value = excluded.value,
        value2 = excluded.value2,
        meta_json = excluded.meta_json,
        updated_at = excluded.updated_at
    `);
    const upsertMany = sqlite.transaction((items: InsertMarketIndicator[]) => {
      for (const r of items) {
        stmt.run({
          indicatorKey: r.indicatorKey,
          market: r.market,
          frequency: r.frequency,
          date: r.date,
          value: r.value,
          value2: r.value2 ?? null,
          metaJson: r.metaJson ?? null,
          source: r.source ?? "",
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      }
    });
    upsertMany(rows);
  }

  // ── News Digest CRUD ────────────────────────────────────────────────────

  getSectorTag(symbol: string): string {
    const row = db.select().from(watchlistSectorTags).where(eq(watchlistSectorTags.symbol, symbol)).get();
    return row?.sectorTag ?? "";
  }

  upsertSectorTag(symbol: string, sectorTag: string): void {
    const existing = db.select().from(watchlistSectorTags).where(eq(watchlistSectorTags.symbol, symbol)).get();
    if (existing) {
      db.update(watchlistSectorTags).set({ sectorTag }).where(eq(watchlistSectorTags.symbol, symbol)).run();
    } else {
      db.insert(watchlistSectorTags).values({ symbol, sectorTag }).run();
    }
  }

  getDigestsForTickers(tickers: string[], days = 30): DailyNewsDigest[] {
    if (tickers.length === 0) return [];
    const rows = db.select().from(dailyNewsDigest)
      .orderBy(desc(dailyNewsDigest.digestDate))
      .all();
    const byTicker = new Map<string, DailyNewsDigest[]>();
    for (const r of rows) {
      if (!tickers.includes(r.ticker)) continue;
      const arr = byTicker.get(r.ticker) ?? [];
      if (arr.length < days) arr.push(r);
      byTicker.set(r.ticker, arr);
    }
    return tickers.flatMap(t => byTicker.get(t) ?? []);
  }

  getDigestsForTicker(ticker: string, days = 30): DailyNewsDigest[] {
    return db.select().from(dailyNewsDigest)
      .where(eq(dailyNewsDigest.ticker, ticker))
      .orderBy(desc(dailyNewsDigest.digestDate))
      .limit(days)
      .all();
  }

  upsertDigest(data: InsertDailyNewsDigest): DailyNewsDigest {
    const existing = db.select().from(dailyNewsDigest)
      .where(and(
        eq(dailyNewsDigest.ticker, data.ticker),
        eq(dailyNewsDigest.digestDate, data.digestDate)
      )).get();
    if (existing) {
      db.update(dailyNewsDigest).set(data).where(eq(dailyNewsDigest.id, existing.id)).run();
      return db.select().from(dailyNewsDigest).where(eq(dailyNewsDigest.id, existing.id)).get()!;
    }
    return db.insert(dailyNewsDigest).values(data).returning().get();
  }

  getSourcesForDigest(digestId: number): DailyNewsSource[] {
    return db.select().from(dailyNewsSources)
      .where(eq(dailyNewsSources.digestId, digestId))
      .orderBy(asc(dailyNewsSources.sortOrder))
      .all();
  }

  replaceSourcesForDigest(digestId: number, sources: Omit<InsertDailyNewsSource, "digestId">[]): void {
    db.delete(dailyNewsSources).where(eq(dailyNewsSources.digestId, digestId)).run();
    sources.forEach((s, i) => {
      db.insert(dailyNewsSources).values({ ...s, digestId, sortOrder: i }).run();
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Analyst Targets
  // ───────────────────────────────────────────────────────────────────

  /** All analyst target rows for a symbol, newest first */
  async getAnalystTargetsBySymbol(symbol: string, market: string): Promise<AnalystTarget[]> {
    return db.select().from(analystTargets)
      .where(and(eq(analystTargets.symbol, symbol), eq(analystTargets.market, market)))
      .orderBy(desc(analystTargets.analystDate))
      .all();
  }

  /** Replace all analyst target rows for a specific symbol (full reimport) */
  async replaceAnalystTargetsForSymbol(
    symbol: string,
    market: string,
    rows: InsertAnalystTarget[]
  ): Promise<void> {
    db.delete(analystTargets)
      .where(and(eq(analystTargets.symbol, symbol), eq(analystTargets.market, market)))
      .run();
    if (rows.length === 0) return;
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO analyst_targets
        (symbol, market, institution, rating, rating_category, score,
         target_price, previous_target_price, analyst_date, source_sheet, created_at, updated_at)
      VALUES
        (@symbol, @market, @institution, @rating, @ratingCategory, @score,
         @targetPrice, @previousTargetPrice, @analystDate, @sourceSheet, @createdAt, @updatedAt)
    `);
    const insertAll = sqlite.transaction((items: InsertAnalystTarget[]) => {
      for (const r of items) stmt.run(r);
    });
    insertAll(rows);
  }

  /** Upsert analyst target rows (used for incremental imports) */
  async upsertAnalystTargets(rows: InsertAnalystTarget[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = sqlite.prepare(`
      INSERT INTO analyst_targets
        (symbol, market, institution, rating, rating_category, score,
         target_price, previous_target_price, analyst_date, source_sheet, created_at, updated_at)
      VALUES
        (@symbol, @market, @institution, @rating, @ratingCategory, @score,
         @targetPrice, @previousTargetPrice, @analystDate, @sourceSheet, @createdAt, @updatedAt)
      ON CONFLICT (symbol, market, institution, analyst_date) DO UPDATE SET
        rating          = excluded.rating,
        rating_category = excluded.rating_category,
        score           = excluded.score,
        target_price    = excluded.target_price,
        previous_target_price = excluded.previous_target_price,
        source_sheet    = excluded.source_sheet,
        updated_at      = excluded.updated_at
    `);
    const upsertAll = sqlite.transaction((items: InsertAnalystTarget[]) => {
      for (const r of items) stmt.run(r);
    });
    upsertAll(rows);
  }

  /**
   * Returns near-6-month rows, deduplicated to the most-recent entry per institution.
   * Used directly for consensus calculation.
   */
  async getLatestAnalystConsensusBySymbol(symbol: string, market: string): Promise<AnalystTarget[]> {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const cutoff = sixMonthsAgo.toISOString().slice(0, 10);

    // Raw SQL: within 6 months, pick latest row per institution
    // better-sqlite3 returns snake_case column names; map to camelCase to match AnalystTarget type.
    const raw = sqlite.prepare(`
      SELECT *
      FROM analyst_targets
      WHERE symbol = ? AND market = ? AND analyst_date >= ?
        AND analyst_date = (
          SELECT MAX(a2.analyst_date)
          FROM analyst_targets a2
          WHERE a2.symbol = analyst_targets.symbol
            AND a2.market = analyst_targets.market
            AND a2.institution = analyst_targets.institution
            AND a2.analyst_date >= ?
        )
      ORDER BY analyst_date DESC
    `).all(symbol, market, cutoff, cutoff) as any[];

    const rows: AnalystTarget[] = raw.map(r => ({
      id:                   r.id,
      symbol:               r.symbol,
      market:               r.market,
      institution:          r.institution,
      rating:               r.rating,
      ratingCategory:       r.rating_category,
      score:                r.score,
      targetPrice:          r.target_price,
      previousTargetPrice:  r.previous_target_price ?? null,
      analystDate:          r.analyst_date,
      sourceSheet:          r.source_sheet,
      createdAt:            r.created_at,
      updatedAt:            r.updated_at,
    }));

    return rows;
  }

  // ── Fundamental Data ──────────────────────────────────────────────────────
  getFundamental(symbol: string, market: string): FundamentalDataRow | undefined {
    const raw = sqlite.prepare(
      "SELECT * FROM fundamental_data WHERE symbol = ? AND market = ? LIMIT 1"
    ).get(symbol, market) as any;
    if (!raw) return undefined;
    return {
      id:                   raw.id,
      symbol:               raw.symbol,
      market:               raw.market,
      infoJson:             raw.info_json,
      quarterlyIncomeJson:  raw.quarterly_income_json,
      epsHistoryJson:       raw.eps_history_json,
      calendarJson:         raw.calendar_json,
      fetchedAt:            raw.fetched_at,
      updatedAt:            raw.updated_at,
    };
  }

  /**
   * Full upsert — used ONLY by cron (/api/internal/fundamentals-sync).
   * Writes all columns including quarterlyIncomeJson and epsHistoryJson.
   */
  upsertFundamental(row: InsertFundamentalData): void {
    sqlite.prepare(`
      INSERT INTO fundamental_data (symbol, market, info_json, quarterly_income_json, eps_history_json, calendar_json, fetched_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, market) DO UPDATE SET
        info_json             = excluded.info_json,
        quarterly_income_json = excluded.quarterly_income_json,
        eps_history_json      = excluded.eps_history_json,
        calendar_json         = excluded.calendar_json,
        fetched_at            = excluded.fetched_at,
        updated_at            = excluded.updated_at
    `).run(
      row.symbol, row.market,
      row.infoJson, row.quarterlyIncomeJson, row.epsHistoryJson, row.calendarJson,
      row.fetchedAt, row.updatedAt
    );
  }

  /**
   * Partial update — used by Yahoo fetcher (resync / bg-refresh / scheduled refresh).
   * Updates ONLY infoJson + calendarJson + fetchedAt/updatedAt.
   * Never touches quarterlyIncomeJson or epsHistoryJson (cron owns those).
   * Preserves all existing finnhub* keys in calendarJson (Finnhub owns those).
   * If no row exists yet, does a full insert with empty quarterly/eps data.
   */
  updateYahooData(symbol: string, market: string, infoJson: string, yahooCalendarJson: string, now: number): void {
    // Merge: start with existing calendar, overlay Yahoo fields, keep finnhub* keys
    const existing = this.getFundamental(symbol, market);
    let mergedCalendar: any = {};
    if (existing) {
      try { mergedCalendar = JSON.parse(existing.calendarJson || "{}"); } catch { /* */ }
    }
    let yahooFields: any = {};
    try { yahooFields = JSON.parse(yahooCalendarJson || "{}"); } catch { /* */ }
    // Overlay Yahoo fields (non-finnhub), preserve existing finnhub* keys
    for (const [k, v] of Object.entries(yahooFields)) {
      if (!k.startsWith("finnhub")) mergedCalendar[k] = v;
    }
    const calendarJson = JSON.stringify(mergedCalendar);

    sqlite.prepare(`
      INSERT INTO fundamental_data (symbol, market, info_json, quarterly_income_json, eps_history_json, calendar_json, fetched_at, updated_at)
      VALUES (?, ?, ?, '', '', ?, ?, ?)
      ON CONFLICT(symbol, market) DO UPDATE SET
        info_json     = excluded.info_json,
        calendar_json = excluded.calendar_json,
        fetched_at    = excluded.fetched_at,
        updated_at    = excluded.updated_at
    `).run(symbol, market, infoJson, calendarJson, now, now);
  }

  /**
   * Finnhub calendar patch — merges finnhub* keys into calendarJson only.
   * Never touches any other column.
   */
  patchCalendarFinnhub(symbol: string, market: string, finnhubFields: Record<string, any>): void {
    const existing = this.getFundamental(symbol, market);
    if (!existing) return;
    let cal: any = {};
    try { cal = JSON.parse(existing.calendarJson || "{}"); } catch { /* */ }
    const merged = { ...cal, ...finnhubFields };
    sqlite.prepare(`
      UPDATE fundamental_data SET calendar_json = ?, updated_at = ?
      WHERE symbol = ? AND market = ?
    `).run(JSON.stringify(merged), Date.now(), symbol, market);
  }

  clearAllFundamentals(): void {
    sqlite.prepare("DELETE FROM fundamental_data").run();
  }

  getAllFundamentals(): FundamentalDataRow[] {
    const rows = sqlite.prepare("SELECT * FROM fundamental_data").all() as any[];
    return rows.map(raw => ({
      id:                   raw.id,
      symbol:               raw.symbol,
      market:               raw.market,
      infoJson:             raw.info_json,
      quarterlyIncomeJson:  raw.quarterly_income_json,
      epsHistoryJson:       raw.eps_history_json,
      calendarJson:         raw.calendar_json,
      fetchedAt:            raw.fetched_at,
      updatedAt:            raw.updated_at,
    }));
  }
}

// ─── ALTER TABLE safety guards ─────────────────────────────────────────────
// Each try/catch adds a column only if it doesn't exist yet.
// Add new entries here whenever a future version adds columns to existing tables.
// Format: ALTER TABLE <table> ADD COLUMN <col> <type> <default>

const safeAlter = (sql: string) => { try { sqlite.exec(sql); } catch { /* column exists */ } };

// watchlist
safeAlter("ALTER TABLE watchlist ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");

// daily_news_digest
safeAlter("ALTER TABLE daily_news_digest ADD COLUMN ai_takeaway TEXT NOT NULL DEFAULT ''");
safeAlter("ALTER TABLE daily_news_digest ADD COLUMN price_close REAL");
safeAlter("ALTER TABLE daily_news_digest ADD COLUMN price_change_pct REAL");
safeAlter("ALTER TABLE daily_news_digest ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0");
safeAlter("ALTER TABLE daily_news_digest ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'");

// ─────────────────────────────────────────────────────────────────────────────

// Ensure news digest tables exist (fresh DB or migration)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS watchlist_sector_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL UNIQUE,
    sector_tag TEXT NOT NULL DEFAULT ''
  )`);
} catch { /* ignore */ }

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS daily_news_digest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    digest_date TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    price_close REAL,
    price_change_pct REAL,
    summary_text TEXT NOT NULL DEFAULT '',
    ai_takeaway TEXT NOT NULL DEFAULT '',
    sentiment_label TEXT NOT NULL DEFAULT 'neutral',
    source_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok'
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS digest_ticker_date ON daily_news_digest (ticker, digest_date)`);
} catch { /* ignore */ }

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS daily_news_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_id INTEGER NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    article_title TEXT NOT NULL DEFAULT '',
    article_url TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    source_domain TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
} catch { /* ignore */ }

// Ensure market_indicators table + index exist (migration-safe)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS market_indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    indicator_key TEXT NOT NULL,
    market TEXT NOT NULL,
    frequency TEXT NOT NULL,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    value2 REAL,
    meta_json TEXT,
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_indicator_key_date ON market_indicators (indicator_key, date)`);
} catch {
  // Already exists — ignore
}

// Ensure analyst_targets table exists (migration-safe)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS analyst_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    institution TEXT NOT NULL,
    rating TEXT NOT NULL,
    rating_category TEXT NOT NULL,
    score INTEGER NOT NULL,
    target_price REAL NOT NULL,
    previous_target_price REAL,
    analyst_date TEXT NOT NULL,
    source_sheet TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS analyst_symbol_date_inst
    ON analyst_targets (symbol, market, institution, analyst_date)`);
} catch {
  // Already exists
}

// Ensure fundamental_data table exists (migration-safe)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS fundamental_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    info_json TEXT NOT NULL DEFAULT '{}',
    quarterly_income_json TEXT NOT NULL DEFAULT '[]',
    eps_history_json TEXT NOT NULL DEFAULT '[]',
    calendar_json TEXT NOT NULL DEFAULT '{}',
    fetched_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS fund_sym_market ON fundamental_data (symbol, market)`);
} catch {
  // Already exists
}

export const storage = new DatabaseStorage();
