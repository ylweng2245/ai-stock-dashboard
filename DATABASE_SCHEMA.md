# AI Stock Dashboard — Database Schema

資料庫：SQLite (`data.db`)，由 `server/storage.ts` 在啟動時自動建立與遷移。

---

## 版本變更記錄

### v5.4（2026-04-26）
- 新增 `ALTER TABLE` 統一防護區塊（`safeAlter`），確保舊 DB 升級時欄位自動補齊
- 無新增資料表或欄位

### v5.0（2026-04-25）
- 新增資料表：`watchlist_sector_tags`
- 新增資料表：`daily_news_digest`
- 新增資料表：`daily_news_sources`

### v4.9（2026-04-24）
- `watchlist` 新增欄位：`sort_order`
- 新增資料表：`transactions`
- 新增資料表：`historical_prices`
- 新增資料表：`market_indicators`

### v1.0（初始版本）
- 新增資料表：`holdings`
- 新增資料表：`alerts`
- 新增資料表：`watchlist`

---

## 現有資料表定義（v5.4 現況）

### `holdings`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| symbol | TEXT NOT NULL | 股票代號 |
| name | TEXT NOT NULL | 股票名稱 |
| shares | REAL NOT NULL | 持股數量 |
| avg_cost | REAL NOT NULL | 平均成本 |
| market | TEXT NOT NULL | `TW` / `US` |

---

### `alerts`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| symbol | TEXT NOT NULL | |
| name | TEXT NOT NULL | |
| target_price | REAL NOT NULL | 目標價 |
| direction | TEXT NOT NULL | `above` / `below` |
| triggered | INTEGER NOT NULL DEFAULT 0 | 0=未觸發, 1=已觸發 |
| market | TEXT NOT NULL | `TW` / `US` |

---

### `watchlist`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| symbol | TEXT NOT NULL | |
| name | TEXT NOT NULL | |
| market | TEXT NOT NULL | `TW` / `US` |
| sort_order | INTEGER NOT NULL DEFAULT 0 | 顯示排序（v4.9 新增） |

---

### `transactions`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| trade_date | TEXT NOT NULL | `YYYY-MM-DD` |
| symbol | TEXT NOT NULL | |
| name | TEXT NOT NULL | |
| market | TEXT NOT NULL | `TW` / `US` |
| side | TEXT NOT NULL | `buy` / `sell` |
| shares | REAL NOT NULL | |
| price | REAL NOT NULL | 成交價格 |
| total_cost | REAL NOT NULL | 總成本（買入為負） |
| currency | TEXT NOT NULL | `TWD` / `USD` |

---

### `historical_prices`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| symbol | TEXT NOT NULL | |
| market | TEXT NOT NULL | |
| date | TEXT NOT NULL | `YYYY-MM-DD` |
| open | REAL NOT NULL | |
| high | REAL NOT NULL | |
| low | REAL NOT NULL | |
| close | REAL NOT NULL | |
| volume | INTEGER NOT NULL DEFAULT 0 | |
| updated_at | INTEGER NOT NULL | Unix ms |

UNIQUE INDEX: `hist_sym_market_date` ON `(symbol, market, date)`

---

### `market_indicators`
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| indicator_key | TEXT NOT NULL | e.g. `fear_greed`, `cpi_us` |
| market | TEXT NOT NULL | `US` / `TW` / `GLOBAL` |
| frequency | TEXT NOT NULL | `daily` / `monthly` |
| date | TEXT NOT NULL | `YYYY-MM-DD` |
| value | REAL NOT NULL | 主要數值 |
| value2 | REAL | 次要數值（選填） |
| meta_json | TEXT | 額外 JSON 資料 |
| source | TEXT NOT NULL DEFAULT '' | 資料來源名稱 |
| created_at | INTEGER NOT NULL | Unix ms |
| updated_at | INTEGER NOT NULL | Unix ms |

UNIQUE INDEX: `mkt_indicator_key_date` ON `(indicator_key, date)`

---

### `watchlist_sector_tags`（v5.0）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| symbol | TEXT NOT NULL UNIQUE | 股票代號（唯一） |
| sector_tag | TEXT NOT NULL DEFAULT '' | 自訂板塊標籤 |

---

### `daily_news_digest`（v5.0）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| ticker | TEXT NOT NULL | 美股代號 |
| digest_date | TEXT NOT NULL | `YYYY-MM-DD`（ET 時區） |
| generated_at | INTEGER NOT NULL | 生成時間 Unix ms |
| price_close | REAL | 當日收盤價（選填） |
| price_change_pct | REAL | 漲跌幅%（選填） |
| summary_text | TEXT NOT NULL DEFAULT '' | Claude 生成的中文摘要 |
| ai_takeaway | TEXT NOT NULL DEFAULT '' | 已棄用（v5.2 移除，保留相容） |
| sentiment_label | TEXT NOT NULL DEFAULT 'neutral' | `positive`/`negative`/`neutral` |
| source_count | INTEGER NOT NULL DEFAULT 0 | 引用新聞來源數 |
| status | TEXT NOT NULL DEFAULT 'ok' | `ok` / `error` |

UNIQUE INDEX: `digest_ticker_date` ON `(ticker, digest_date)`

---

### `daily_news_sources`（v5.0）
| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| digest_id | INTEGER NOT NULL | FK → `daily_news_digest.id` |
| source_name | TEXT NOT NULL DEFAULT '' | 媒體名稱（e.g. Reuters） |
| article_title | TEXT NOT NULL DEFAULT '' | 文章標題 |
| article_url | TEXT NOT NULL DEFAULT '' | 原始連結 |
| published_at | TEXT NOT NULL DEFAULT '' | `YYYY-MM-DD HH:mm` |
| source_domain | TEXT NOT NULL DEFAULT '' | e.g. `reuters.com` |
| sort_order | INTEGER NOT NULL DEFAULT 0 | 顯示排序 |

---

## 新增欄位作業指引

未來若需新增欄位至現有資料表，請在 `server/storage.ts` 的 `safeAlter` 區塊加入：

```typescript
safeAlter("ALTER TABLE <table> ADD COLUMN <col> <type> DEFAULT <value>");
```

並在本文件的「版本變更記錄」新增一筆記錄。

> `safeAlter` 會在欄位已存在時靜默忽略錯誤，對現有資料完全安全。
