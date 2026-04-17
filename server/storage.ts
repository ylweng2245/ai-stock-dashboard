import {
  type Holding, type InsertHolding, holdings,
  type Alert, type InsertAlert, alerts,
  type WatchlistItem, type InsertWatchlist, watchlist,
  type Transaction, type InsertTransaction, transactions,
  type HistoricalPrice, type InsertHistoricalPrice, historicalPrices,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, asc, and, gte, lte, max, desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

// Ensure sort_order column exists (migration for existing DBs)
try {
  sqlite.exec("ALTER TABLE watchlist ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
} catch {
  // Column already exists — ignore
}

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
    const existingKeys = new Set(existing.map((w) => `${w.symbol}_${w.market}`));
    let nextOrder = existing.reduce((m, w) => Math.max(m, w.sortOrder), -1) + 1;

    for (const d of defaults) {
      const key = `${d.symbol}_${d.market}`;
      if (!existingKeys.has(key)) {
        db.insert(watchlist).values({ symbol: d.symbol, name: d.name, market: d.market, sortOrder: nextOrder++ }).run();
        existingKeys.add(key);
      }
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
}

export const storage = new DatabaseStorage();
