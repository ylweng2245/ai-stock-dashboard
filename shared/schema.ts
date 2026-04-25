import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Portfolio holdings
export const holdings = sqliteTable("holdings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  shares: real("shares").notNull(),
  avgCost: real("avg_cost").notNull(),
  market: text("market").notNull(), // "TW" or "US"
});

export const insertHoldingSchema = createInsertSchema(holdings).omit({ id: true });
export type InsertHolding = z.infer<typeof insertHoldingSchema>;
export type Holding = typeof holdings.$inferSelect;

// Price alerts
export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  targetPrice: real("target_price").notNull(),
  direction: text("direction").notNull(), // "above" or "below"
  triggered: integer("triggered", { mode: "boolean" }).notNull().default(false),
  market: text("market").notNull(),
});

export const insertAlertSchema = createInsertSchema(alerts).omit({ id: true, triggered: true });
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alerts.$inferSelect;

// Transactions — raw trade records imported from Excel
export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tradeDate: text("trade_date").notNull(),   // "YYYY-MM-DD"
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  market: text("market").notNull(),           // "TW" or "US"
  side: text("side").notNull(),               // "buy" or "sell"
  shares: real("shares").notNull(),
  price: real("price").notNull(),             // price per share in native currency
  totalCost: real("total_cost").notNull(),    // actual amount paid/received (incl. fees, negative = paid)
  currency: text("currency").notNull(),       // "TWD" or "USD"
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({ id: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

// Watchlist
export const watchlist = sqliteTable("watchlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const insertWatchlistSchema = createInsertSchema(watchlist).omit({ id: true, sortOrder: true });
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type WatchlistItem = typeof watchlist.$inferSelect;

// Historical OHLCV prices (DB-backed — avoids repeated Yahoo Finance calls per range switch)
export const historicalPrices = sqliteTable("historical_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  market: text("market").notNull(),   // "TW" or "US"
  date: text("date").notNull(),        // "YYYY-MM-DD"
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: integer("volume").notNull().default(0),
  updatedAt: integer("updated_at").notNull(), // Unix ms — last upsert time
}, (t) => ({
  symMarketDateIdx: uniqueIndex("hist_sym_market_date").on(t.symbol, t.market, t.date),
}));

export const insertHistoricalPriceSchema = createInsertSchema(historicalPrices).omit({ id: true });
export type InsertHistoricalPrice = z.infer<typeof insertHistoricalPriceSchema>;
export type HistoricalPrice = typeof historicalPrices.$inferSelect;

// Market overview indicators (TAIEX, VIX, US10Y, CPI, etc.)
export const marketIndicators = sqliteTable("market_indicators", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  indicatorKey: text("indicator_key").notNull(),   // e.g. 'TAIEX', 'VIX', 'US10Y', 'US_CPI'
  market: text("market").notNull(),                // 'TW' | 'US'
  frequency: text("frequency").notNull(),          // 'daily' | 'monthly'
  date: text("date").notNull(),                    // 'YYYY-MM-DD'
  value: real("value").notNull(),                  // main value
  value2: real("value2"),                          // optional secondary value
  metaJson: text("meta_json"),                     // JSON string for extra fields
  source: text("source").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  indicatorDateIdx: uniqueIndex("mkt_indicator_key_date").on(t.indicatorKey, t.date),
}));

export const insertMarketIndicatorSchema = createInsertSchema(marketIndicators).omit({ id: true });
export type InsertMarketIndicator = z.infer<typeof insertMarketIndicatorSchema>;
export type MarketIndicator = typeof marketIndicators.$inferSelect;

// ── News Digest ─────────────────────────────────────────────────────────────

// Sector tag extension for watchlist (stored separately to avoid breaking existing schema)
export const watchlistSectorTags = sqliteTable("watchlist_sector_tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull().unique(),
  sectorTag: text("sector_tag").notNull().default(""),
});
export type WatchlistSectorTag = typeof watchlistSectorTags.$inferSelect;

// One digest snapshot per ticker per day
export const dailyNewsDigest = sqliteTable("daily_news_digest", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  digestDate: text("digest_date").notNull(),      // "YYYY-MM-DD"
  generatedAt: integer("generated_at").notNull(), // Unix ms
  priceClose: real("price_close"),
  priceChangePct: real("price_change_pct"),
  summaryText: text("summary_text").notNull().default(""),
  aiTakeaway: text("ai_takeaway").notNull().default(""),
  sentimentLabel: text("sentiment_label").notNull().default("neutral"), // positive | negative | neutral
  sourceCount: integer("source_count").notNull().default(0),
  status: text("status").notNull().default("ok"), // ok | error | pending
}, (t) => ({
  tickerDateIdx: uniqueIndex("digest_ticker_date").on(t.ticker, t.digestDate),
}));

export const insertDailyNewsDigestSchema = createInsertSchema(dailyNewsDigest).omit({ id: true });
export type InsertDailyNewsDigest = z.infer<typeof insertDailyNewsDigestSchema>;
export type DailyNewsDigest = typeof dailyNewsDigest.$inferSelect;

// Source articles linked to each digest
export const dailyNewsSources = sqliteTable("daily_news_sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  digestId: integer("digest_id").notNull(),
  sourceName: text("source_name").notNull().default(""),
  articleTitle: text("article_title").notNull().default(""),
  articleUrl: text("article_url").notNull().default(""),
  publishedAt: text("published_at").notNull().default(""),
  sourceDomain: text("source_domain").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const insertDailyNewsSourceSchema = createInsertSchema(dailyNewsSources).omit({ id: true });
export type InsertDailyNewsSource = z.infer<typeof insertDailyNewsSourceSchema>;
export type DailyNewsSource = typeof dailyNewsSources.$inferSelect;
