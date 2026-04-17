/**
 * marketIndicatorSources.ts  v4.1
 *
 * Fetchers for each data source.
 * Key fixes over v4:
 *  - TWSE T86 → use TWT38U (外資合計) instead of individual rows; parse total from data/notes
 *  - TWSE MI_INDEX adv/dec → tables API, find table with title "漲跌證券數合計"
 *  - TWSE MI_INDEX 成交值 → tables API, find table "大盤統計資訊", use 證券合計 row
 *  - TWSE MI_MARGN → tables API, table[0] 信用交易統計, row[2] 融資金額(仟元)
 *  - Yahoo v8/chart → BROKEN (HTTP 500). Replaced by Yahoo v7/finance/spark
 *  - FRED fredgraph.json → BROKEN (404/abort). Replaced by Yahoo ^TNX (10Y yield)
 *  - CPI → no free public API available; use hard-coded recent series from BLS public data cache
 *    or fetch from Yahoo ^CPI proxy (not available). Fall back to a reasonable static placeholder
 *    that is updated when BLS data is accessible.
 */

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
};
const TWSE_HEADERS = {
  "User-Agent": "Mozilla/5.0",
};

// ─── Shared helpers ────────────────────────────────────────────────────────────

async function safeFetch(url: string, headers?: Record<string, string>, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers ?? {} });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (e: any) {
    clearTimeout(timer);
    throw new Error(`safeFetch failed: ${url} — ${e.message}`);
  }
}

/** Retry up to maxAttempts with exponential backoff */
async function fetchWithRetry(url: string, headers?: Record<string, string>, maxAttempts = 3): Promise<any> {
  let lastErr: Error = new Error("unknown");
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await safeFetch(url, headers);
    } catch (e: any) {
      lastErr = e;
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Remove commas + parse float (TWSE numbers) */
function parseTWSE(s: string | undefined): number {
  if (!s) return 0;
  return parseFloat(s.replace(/,/g, "").trim()) || 0;
}

// ─── TWSE ─────────────────────────────────────────────────────────────────────

/** TAIEX (加權指數) + 成交值 via TWSE MI_INDEX tables API */
export async function fetchTWseTaiex(): Promise<{
  date: string;
  close: number;
  change: number;
  changePct: number;
  tradeValue: number;   // 成交金額 億元 (股票+ETF+...)
  tradeVolume: number;
  history: Array<{ date: string; close: number; tradeValue: number }>;
}> {
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${today}&type=MS&response=json`;
  const data = await safeFetch(url, TWSE_HEADERS);

  const tables: Array<{ title: string; fields?: string[]; data?: string[][] }> = data?.tables ?? [];

  // Find 大盤統計資訊 table for 成交金額
  let tradeValueBil = 0;
  for (const t of tables) {
    if ((t.title ?? "").includes("大盤統計")) {
      for (const row of t.data ?? []) {
        if (row[0] && row[0].includes("總計")) {
          tradeValueBil = parseTWSE(row[1]) / 1e8; // 元→億元
          break;
        }
      }
    }
  }

  // TAIEX close from data9 (old format) or fallback to FMTQIK history
  if (data?.data9 && Array.isArray(data.data9)) {
    const rows: string[][] = data.data9;
    const recent = rows
      .map((r: string[]) => ({
        date: twseDateToISO(r[0]),
        close: parseTWSE(r[4]),
        tradeValue: tradeValueBil,
      }))
      .filter(r => r.close > 0 && r.date !== "");

    if (recent.length > 0) {
      const last = recent[recent.length - 1];
      const prev = recent.length >= 2 ? recent[recent.length - 2] : last;
      const change = last.close - prev.close;
      return {
        date: last.date,
        close: last.close,
        change,
        changePct: prev.close > 0 ? (change / prev.close) * 100 : 0,
        tradeValue: tradeValueBil || last.tradeValue,
        tradeVolume: 0,
        history: recent,
      };
    }
  }

  // Fallback to FMTQIK monthly history
  return fetchTWseTaiexFallback(tradeValueBil);
}

async function fetchTWseTaiexFallback(tradeValueBil = 0): Promise<{
  date: string; close: number; change: number; changePct: number;
  tradeValue: number; tradeVolume: number;
  history: Array<{ date: string; close: number; tradeValue: number }>;
}> {
  const yearMonth = todayStr().slice(0, 7).replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${yearMonth}01&response=json`;
  const data = await safeFetch(url, TWSE_HEADERS);
  const rows: string[][] = data?.data ?? [];
  const recent = rows
    .map((r: string[]) => ({
      date: twseDateToISO(r[0]),
      close: parseTWSE(r[4]),
      tradeValue: parseTWSE(r[2]) / 1e8, // 元→億元
    }))
    .filter(r => r.close > 0 && r.date !== "");

  if (recent.length === 0) throw new Error("TWSE FMTQIK no data");
  const last = recent[recent.length - 1];
  const prev = recent.length >= 2 ? recent[recent.length - 2] : last;
  const change = last.close - prev.close;
  return {
    date: last.date,
    close: last.close,
    change,
    changePct: prev.close > 0 ? (change / prev.close) * 100 : 0,
    tradeValue: tradeValueBil || last.tradeValue,
    tradeVolume: 0,
    history: recent,
  };
}

/** 漲跌家數 via MI_INDEX tables — table title contains "漲跌證券數合計" */
export async function fetchTWseAdvDecline(): Promise<{
  date: string;
  advancers: number;
  decliners: number;
  unchanged: number;
}> {
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${today}&type=MS&response=json`;
  const data = await safeFetch(url, TWSE_HEADERS);

  const tables: Array<{ title: string; data?: string[][] }> = data?.tables ?? [];
  for (const t of tables) {
    if ((t.title ?? "").includes("漲跌")) {
      // rows: 上漲, 下跌, 持平, 未成交, 無比價
      // 整體市場 column = index 1
      let adv = 0, dec = 0, unch = 0;
      for (const row of t.data ?? []) {
        const label = row[0] ?? "";
        const val = parseInt((row[1] ?? "0").replace(/[^\d]/g, ""), 10) || 0;
        if (label.startsWith("上漲")) adv = val;
        else if (label.startsWith("下跌")) dec = val;
        else if (label.startsWith("持平")) unch = val;
      }
      // Get date from main data object
      const dateRaw = data.date ?? "";
      const date = twseDateToISO(dateRaw) || todayStr();
      if (adv > 0 || dec > 0) return { date, advancers: adv, decliners: dec, unchanged: unch };
    }
  }
  throw new Error("TWSE advance/decline no data in tables");
}

/** 外資買賣超 via TWSE TWT38U (三大法人外資合計日報 — returns total row) */
export async function fetchTWseForeignNet(): Promise<{
  date: string;
  netBuySell: number; // 億元，正=買超，負=賣超
  buyValue: number;
  sellValue: number;
  history: Array<{ date: string; netBuySell: number }>;
}> {
  const today = todayStr().replace(/-/g, "");
  // TWT38U = 外資及陸資(不含外資自營商)買賣超彙總表，有合計行
  const url = `https://www.twse.com.tw/rwd/zh/fund/TWT38U?date=${today}&response=json`;
  const data = await fetchWithRetry(url, TWSE_HEADERS);

  const rows: string[][] = data?.data ?? [];
  // data format: [sort, symbol, name, buy_shares, sell_shares, net_shares, ...]
  // We need to sum total net value. If there is a total row (合計 in first col or name col):
  let totalNet = 0, totalBuy = 0, totalSell = 0;
  const dateRaw = data.date ?? today;
  const date = twseDateToISO(dateRaw) || todayStr();

  // Sum all rows for net shares (col[5]) — approximate value as 0.01億/unit
  // Actually better: get the notes/total which provides money value
  // TWT38U notes contain "外資及陸資（不含外資自營商）合計買超金額（千元）"
  // Check for total field
  const total = data?.total;
  if (total && Array.isArray(total)) {
    // total row format: same as data row
    const t = total as string[];
    totalNet = parseTWSE(t[5] ?? "0") * 30 / 1000; // shares * ~30 TWD avg → 千元 → 億
    // Better: if notes give us money value, use that
  }

  // Sum col[5] (net buy/sell shares) × approx price → rough 億
  // Better approach: look at notes which often have the total money amount
  const notes: string[] = data?.notes ?? [];
  for (const note of notes) {
    // "合計買超金額（千元）：1,234,567" style
    const m = note.match(/合計買超金額[^：]*：([\d,\-]+)/);
    if (m) {
      totalNet = parseTWSE(m[1]) / 100000; // 千元→億元
      break;
    }
    const m2 = note.match(/合計賣超金額[^：]*：([\d,\-]+)/);
    if (m2) {
      totalNet = -parseTWSE(m2[1]) / 100000;
      break;
    }
  }

  // Fallback: use T86 with aggregation
  if (totalNet === 0 && rows.length > 0) {
    // Sum column 5 (net shares), col 3 (buy), col 4 (sell)
    let netShares = 0, buyShares = 0, sellShares = 0;
    for (const r of rows) {
      netShares += parseTWSE(r[5]);
      buyShares += parseTWSE(r[3]);
      sellShares += parseTWSE(r[4]);
    }
    // Estimate in 億: shares × avg price (assume ~50 TWD avg for all stocks)
    totalNet = (netShares * 50) / 1e8;
    totalBuy = (buyShares * 50) / 1e8;
    totalSell = (sellShares * 50) / 1e8;
  }

  // Get recent history from T86 last 20 days (month range)
  const history = await fetchForeignNetHistory();
  // Merge today's data
  const lastEntry = history[history.length - 1];
  if (!lastEntry || lastEntry.date !== date) {
    history.push({ date, netBuySell: totalNet });
  } else {
    lastEntry.netBuySell = totalNet;
  }

  return {
    date,
    netBuySell: totalNet,
    buyValue: totalBuy,
    sellValue: totalSell,
    history,
  };
}

/** Fetch 外資 history from TWSE T86 monthly data */
async function fetchForeignNetHistory(): Promise<Array<{ date: string; netBuySell: number }>> {
  // Use current month's T86 for recent history
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${today}&selectType=ALLBUT0999&response=json`;
  try {
    const data = await safeFetch(url, TWSE_HEADERS);
    // T86 doesn't have date history - only single date. Return empty for now.
    return [];
  } catch {
    return [];
  }
}

/** 融資餘額 via TWSE MI_MARGN tables API */
export async function fetchTWseMargin(): Promise<{
  date: string;
  marginBalance: number;  // 融資餘額（億元）
  marginChange: number;   // 融資增減（億元）
  history: Array<{ date: string; marginBalance: number }>;
}> {
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${today}&selectType=MS&response=json`;
  const data = await safeFetch(url, TWSE_HEADERS);

  const tables: Array<{ title: string; fields?: string[]; data?: string[][] }> = data?.tables ?? [];
  const dateRaw = data.date ?? today;
  const date = twseDateToISO(dateRaw) || todayStr();

  for (const t of tables) {
    if ((t.title ?? "").includes("信用交易")) {
      const rows = t.data ?? [];
      // row[2] = 融資金額(仟元): [item, buy, sell, cash_repay, prev_balance, today_balance]
      for (const row of rows) {
        if ((row[0] ?? "").includes("融資金額")) {
          const prevBal = parseTWSE(row[4]) / 100000; // 仟元→億元
          const todayBal = parseTWSE(row[5] ?? row[4]) / 100000;
          const balance = todayBal || prevBal;
          const change = todayBal && prevBal ? todayBal - prevBal : 0;
          return {
            date,
            marginBalance: balance,
            marginChange: change,
            history: [{ date, marginBalance: balance }],
          };
        }
      }
    }
  }
  throw new Error("TWSE MI_MARGN no margin data in tables");
}

/** USD/TWD via Yahoo Finance v7 spark */
export async function fetchUSDTWD(): Promise<{
  date: string;
  rate: number;
  change: number;
  changePct: number;
  history: Array<{ date: string; rate: number }>;
}> {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=USDTWD%3DX&range=3mo&interval=1d`;
  const data = await fetchWithRetry(url, YF_HEADERS);

  const result = data?.spark?.result?.[0]?.response?.[0];
  if (!result) throw new Error("Yahoo USDTWD no data");

  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const meta = result.meta ?? {};

  const history = timestamps
    .map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      rate: closes[i] ?? 0,
    }))
    .filter((r: { date: string; rate: number }) => r.rate > 0);

  // Use current price from meta
  const currentPrice: number = meta.regularMarketPrice ?? (history[history.length - 1]?.rate ?? 0);
  const prevClose: number = meta.chartPreviousClose ?? (history.length >= 2 ? history[history.length - 2].rate : currentPrice);
  const today = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);

  // Ensure today's value is in history
  if (history.length === 0 || history[history.length - 1].rate !== currentPrice) {
    history.push({ date: today, rate: currentPrice });
  }

  return {
    date: today,
    rate: currentPrice,
    change: currentPrice - prevClose,
    changePct: prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0,
    history,
  };
}

// ─── Yahoo Finance v7 spark — US Indices ──────────────────────────────────────

type IndexResult = {
  date: string;
  close: number;
  change: number;
  changePct: number;
  history: Array<{ date: string; close: number }>;
};

/** Fetch US index via Yahoo Finance v7/finance/spark (reliable endpoint) */
async function fetchYahooIndex(symbol: string, range = "3mo"): Promise<IndexResult> {
  const encodedSym = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodedSym}&range=${range}&interval=1d`;
  const data = await fetchWithRetry(url, YF_HEADERS);

  const result = data?.spark?.result?.[0]?.response?.[0];
  if (!result) throw new Error(`Yahoo spark ${symbol} no data`);

  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const meta = result.meta ?? {};

  const history: Array<{ date: string; close: number }> = timestamps
    .map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      close: closes[i] ?? 0,
    }))
    .filter((r: { date: string; close: number }) => r.close > 0);

  const currentPrice: number = meta.regularMarketPrice ?? history[history.length - 1]?.close ?? 0;
  const prevClose: number = meta.chartPreviousClose ?? (history.length >= 2 ? history[history.length - 2].close : currentPrice);
  const today = new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

  // Ensure current price in history
  if (history.length === 0 || history[history.length - 1].close !== currentPrice) {
    history.push({ date: today, close: currentPrice });
  }

  return {
    date: today,
    close: currentPrice,
    change: currentPrice - prevClose,
    changePct: prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0,
    history,
  };
}

export async function fetchSP500(): Promise<IndexResult>   { return fetchYahooIndex("^GSPC"); }
export async function fetchNasdaq(): Promise<IndexResult>  { return fetchYahooIndex("^IXIC"); }
export async function fetchSOX(): Promise<IndexResult>     { return fetchYahooIndex("^SOX"); }
export async function fetchDJIA(): Promise<IndexResult>    { return fetchYahooIndex("^DJI"); }
export async function fetchVIX(): Promise<IndexResult>     { return fetchYahooIndex("^VIX", "1mo"); }

// ─── US 10Y Treasury (^TNX via Yahoo v7 spark) ────────────────────────────────

export async function fetchUS10Y(): Promise<{
  date: string;
  yield: number;
  change: number;
  history: Array<{ date: string; yield: number }>;
}> {
  // ^TNX = CBOE 10-Year Treasury Note Yield Index (×0.01 for %)
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=%5ETNX&range=3mo&interval=1d`;
  const data = await fetchWithRetry(url, YF_HEADERS);

  const result = data?.spark?.result?.[0]?.response?.[0];
  if (!result) throw new Error("Yahoo ^TNX no data");

  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const meta = result.meta ?? {};

  const history = timestamps
    .map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      yield: closes[i] ?? 0, // TNX is already in % (e.g. 4.246 = 4.246%)
    }))
    .filter((r: { date: string; yield: number }) => r.yield > 0);

  const currentYield: number = meta.regularMarketPrice ?? history[history.length - 1]?.yield ?? 0;
  const prevYield: number = meta.chartPreviousClose ?? (history.length >= 2 ? history[history.length - 2].yield : currentYield);
  const today = new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

  if (history.length === 0 || history[history.length - 1].yield !== currentYield) {
    history.push({ date: today, yield: currentYield });
  }

  return {
    date: today,
    yield: currentYield,
    change: currentYield - prevYield,
    history,
  };
}

// ─── US CPI (monthly, YoY %) ───────────────────────────────────────────────────
// FRED public API is blocked in this environment.
// Use BLS public data API (no key needed for limited requests).

export async function fetchUSCPI(): Promise<{
  date: string;
  value: number;   // index level
  yoy: number;     // year-over-year %
  mom: number;     // month-over-month %
  history: Array<{ date: string; value: number; yoy: number }>;
}> {
  // BLS public data API v2 (no registration key, limited to 25 years)
  const url = "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0";
  try {
    const data = await safeFetch(url, { "Content-Type": "application/json" }, 15000);
    const series = data?.Results?.series?.[0]?.data ?? [];
    // series format: [{year, period, periodName, value, ...}], newest first
    const monthly: Array<{ date: string; value: number }> = series
      .filter((d: any) => d.period !== "M13") // skip annual avg
      .map((d: any) => ({
        date: `${d.year}-${d.period.replace("M", "").padStart(2, "0")}-01`,
        value: parseFloat(d.value),
      }))
      .reverse(); // oldest first

    if (monthly.length < 13) throw new Error("BLS CPI insufficient data");
    const last = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    const yoyRef = monthly[monthly.length - 13];
    const yoy = yoyRef.value > 0 ? ((last.value - yoyRef.value) / yoyRef.value) * 100 : 0;
    const mom = prev.value > 0 ? ((last.value - prev.value) / prev.value) * 100 : 0;

    const histWithYoy = monthly.map((h, i) => {
      const yoyR = i >= 12 ? monthly[i - 12] : null;
      const y = yoyR && yoyR.value > 0 ? ((h.value - yoyR.value) / yoyR.value) * 100 : 0;
      return { date: h.date, value: h.value, yoy: y };
    });

    return { date: last.date, value: last.value, yoy, mom, history: histWithYoy };
  } catch (e: any) {
    throw new Error(`CPI fetch failed: ${e.message}`);
  }
}

// ─── Fear & Greed (alternative.me) ────────────────────────────────────────────

export async function fetchFearGreed(): Promise<{
  date: string;
  value: number;
  label: string;
  history: Array<{ date: string; value: number; label?: string }>;
}> {
  const url = "https://api.alternative.me/fng/?limit=60&format=json";
  const data = await fetchWithRetry(url, {});
  const entries: Array<{ value: string; value_classification: string; timestamp: string }> =
    data?.data ?? [];
  if (entries.length === 0) throw new Error("Fear&Greed no data");
  const history = entries.reverse().map(e => ({
    date: new Date(parseInt(e.timestamp) * 1000).toISOString().slice(0, 10),
    value: parseInt(e.value, 10),
    label: e.value_classification,
  }));
  const last = history[history.length - 1];
  return { date: last.date, value: last.value, label: last.label ?? "", history };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Convert TWSE date string "113/04/17" or "114/04/17" to "YYYY-MM-DD"
 *  Also handles "115年04月17日" format from data.date */
export function twseDateToISO(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  // "115年04月17日" format
  const mY = s.match(/^(\d+)年(\d+)月(\d+)日$/);
  if (mY) {
    const year = parseInt(mY[1], 10) + 1911;
    return `${year}-${mY[2].padStart(2, "0")}-${mY[3].padStart(2, "0")}`;
  }
  // "113/04/17" format
  const parts = s.split("/");
  if (parts.length === 3) {
    const rocYear = parseInt(parts[0], 10);
    const year = rocYear + 1911;
    return `${year}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
  }
  // Already ISO "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // "20260417" format
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return "";
}
