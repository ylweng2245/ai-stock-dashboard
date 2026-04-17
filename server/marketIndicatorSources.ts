/**
 * marketIndicatorSources.ts
 * Fetchers for each data source — one clear function per source.
 * All functions return raw data; signal computation is done in marketIndicatorRules.ts
 */

// ─── Shared fetch helper ──────────────────────────────────────────────────────
async function safeFetch(url: string, headers?: Record<string, string>, timeoutMs = 10000): Promise<any> {
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── TWSE — Taiwan Stock Exchange Official ────────────────────────────────────

/** TAIEX (加權指數) + 成交值 via TWSE Mi_INDEX */
export async function fetchTWseTaiex(): Promise<{
  date: string;
  close: number;
  change: number;
  changePct: number;
  tradeValue: number;   // 成交金額 (億元)
  tradeVolume: number;  // 成交股數
  history: Array<{ date: string; close: number; tradeValue: number }>;
}> {
  // Fetch last ~60 trading days from TWSE MI_INDEX
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${today}&type=MS&response=json`;
  const data = await safeFetch(url);

  // TWSE MI_INDEX returns TAIEX as the last row in data9 (加權指數)
  const tables = data?.tables ?? data?.data9 ? null : null;
  // Try the standard layout
  if (data?.data9) {
    const rows: string[][] = data.data9;
    // row format: ["日期","開盤指數","最高指數","最低指數","收盤指數","漲跌(+/-)","漲跌點數","成交量(億元)","成交金額(億元)"]
    // Parse last available row
    const recent = rows.slice(-30).map(r => ({
      date: twseDateToISO(r[0]),
      close: parseFloat((r[4] || "0").replace(/,/g, "")),
      tradeValue: parseFloat((r[8] || r[7] || "0").replace(/,/g, "")),
    })).filter(r => r.close > 0 && r.date !== "");

    if (recent.length > 0) {
      const last = recent[recent.length - 1];
      const prev = recent.length >= 2 ? recent[recent.length - 2] : last;
      const change = last.close - prev.close;
      const changePct = prev.close > 0 ? (change / prev.close) * 100 : 0;
      return {
        date: last.date,
        close: last.close,
        change,
        changePct,
        tradeValue: last.tradeValue,
        tradeVolume: 0,
        history: recent,
      };
    }
  }

  // Fallback: fetch via TWSE FMTQIK (上市指數日歷史)
  return fetchTWseTaiexFallback();
}

async function fetchTWseTaiexFallback(): Promise<{
  date: string; close: number; change: number; changePct: number;
  tradeValue: number; tradeVolume: number;
  history: Array<{ date: string; close: number; tradeValue: number }>;
}> {
  const yearMonth = todayStr().slice(0, 7).replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${yearMonth}01&response=json`;
  const data = await safeFetch(url);
  const rows: string[][] = data?.data ?? [];
  const recent = rows.map(r => ({
    date: twseDateToISO(r[0]),
    close: parseFloat((r[4] || "0").replace(/,/g, "")),
    tradeValue: parseFloat((r[2] || "0").replace(/,/g, "")) / 1e8, // 元→億元
  })).filter(r => r.close > 0 && r.date !== "");

  if (recent.length === 0) throw new Error("TWSE FMTQIK no data");
  const last = recent[recent.length - 1];
  const prev = recent.length >= 2 ? recent[recent.length - 2] : last;
  const change = last.close - prev.close;
  const changePct = prev.close > 0 ? (change / prev.close) * 100 : 0;
  return { date: last.date, close: last.close, change, changePct, tradeValue: last.tradeValue, tradeVolume: 0, history: recent };
}

/** 漲跌家數 via TWSE MI_INDEX */
export async function fetchTWseAdvDecline(): Promise<{
  date: string;
  advancers: number;
  decliners: number;
  unchanged: number;
}> {
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${today}&type=MS&response=json`;
  const data = await safeFetch(url);
  // data.data3 = 上市股票漲跌家數
  const rows: string[][] = data?.data3 ?? [];
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    return {
      date: twseDateToISO(last[0]),
      advancers: parseInt((last[3] || "0").replace(/,/g, ""), 10),
      decliners: parseInt((last[4] || "0").replace(/,/g, ""), 10),
      unchanged: parseInt((last[5] || "0").replace(/,/g, ""), 10),
    };
  }
  throw new Error("TWSE advance/decline no data");
}

/** 外資買賣超 via TWSE T86 */
export async function fetchTWseForeignNet(): Promise<{
  date: string;
  netBuySell: number; // 億元，正=買超，負=賣超
  buyValue: number;
  sellValue: number;
  history: Array<{ date: string; netBuySell: number }>;
}> {
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${today}&selectType=ALLBUT0999&response=json`;
  const data = await safeFetch(url);
  const rows: string[][] = data?.data ?? [];
  // T86 columns: 日期, 買進金額, 賣出金額, 買賣超金額 (千元)
  const recent = rows.map(r => ({
    date: twseDateToISO(r[0]),
    buyValue: parseFloat((r[1] || "0").replace(/,/g, "")) / 100000,   // 千元→億元
    sellValue: parseFloat((r[2] || "0").replace(/,/g, "")) / 100000,
    netBuySell: parseFloat((r[3] || "0").replace(/,/g, "")) / 100000,
  })).filter(r => r.date !== "");

  if (recent.length === 0) throw new Error("TWSE T86 no data");
  const last = recent[recent.length - 1];
  return { ...last, history: recent };
}

/** 融資餘額 via TWSE MI_MARGN */
export async function fetchTWseMargin(): Promise<{
  date: string;
  marginBalance: number;  // 融資餘額（億元）
  marginChange: number;   // 融資增減（億元）
  history: Array<{ date: string; marginBalance: number }>;
}> {
  const today = todayStr().replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${today}&selectType=MS&response=json`;
  const data = await safeFetch(url);
  // data.data_fina_buy = 融資
  const rows: string[][] = data?.data_fina_buy ?? data?.data_fina ?? data?.data ?? [];
  const recent = rows.map(r => ({
    date: twseDateToISO(r[0]),
    marginBalance: parseFloat((r[6] || r[4] || "0").replace(/,/g, "")) / 100000, // 千元→億元
  })).filter(r => r.date !== "" && r.marginBalance > 0);

  if (recent.length === 0) throw new Error("TWSE margin no data");
  const last = recent[recent.length - 1];
  const prev = recent.length >= 2 ? recent[recent.length - 2] : last;
  return {
    date: last.date,
    marginBalance: last.marginBalance,
    marginChange: last.marginBalance - prev.marginBalance,
    history: recent,
  };
}

/** USD/TWD via Yahoo Finance */
export async function fetchUSDTWD(): Promise<{
  date: string;
  rate: number;
  change: number;
  changePct: number;
  history: Array<{ date: string; rate: number }>;
}> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 90 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/chart/USDTWD=X?interval=1d&period1=${start}&period2=${end}`;
  const data = await safeFetch(url, { "User-Agent": "Mozilla/5.0" });
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo USDTWD no data");
  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const history = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    rate: closes[i] ?? 0,
  })).filter(r => r.rate > 0);

  if (history.length === 0) throw new Error("Yahoo USDTWD empty");
  const last = history[history.length - 1];
  const prev = history.length >= 2 ? history[history.length - 2] : last;
  return {
    date: last.date,
    rate: last.rate,
    change: last.rate - prev.rate,
    changePct: prev.rate > 0 ? ((last.rate - prev.rate) / prev.rate) * 100 : 0,
    history,
  };
}

// ─── Yahoo Finance — US Indices ────────────────────────────────────────────────

type IndexResult = {
  date: string;
  close: number;
  change: number;
  changePct: number;
  history: Array<{ date: string; close: number }>;
};

async function fetchYahooIndex(symbol: string): Promise<IndexResult> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 120 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${start}&period2=${end}`;
  const data = await safeFetch(url, { "User-Agent": "Mozilla/5.0" });
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo index ${symbol} no data`);
  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const history = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    close: closes[i] ?? 0,
  })).filter(r => r.close > 0);

  if (history.length === 0) throw new Error(`Yahoo index ${symbol} empty`);
  const last = history[history.length - 1];
  const prev = history.length >= 2 ? history[history.length - 2] : last;
  return {
    date: last.date,
    close: last.close,
    change: last.close - prev.close,
    changePct: prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0,
    history,
  };
}

export async function fetchSP500(): Promise<IndexResult>   { return fetchYahooIndex("^GSPC"); }
export async function fetchNasdaq(): Promise<IndexResult>  { return fetchYahooIndex("^IXIC"); }
export async function fetchSOX(): Promise<IndexResult>     { return fetchYahooIndex("^SOX"); }
export async function fetchDJIA(): Promise<IndexResult>    { return fetchYahooIndex("^DJI"); }
export async function fetchVIX(): Promise<IndexResult>     { return fetchYahooIndex("^VIX"); }

// ─── FRED — US 10Y Treasury Yield ─────────────────────────────────────────────

export async function fetchUS10Y(): Promise<{
  date: string;
  yield: number;
  change: number;
  history: Array<{ date: string; yield: number }>;
}> {
  // FRED public JSON API (no key needed for recent data via observation endpoint)
  const url = "https://fred.stlouisfed.org/graph/fredgraph.json?id=DGS10";
  const data = await safeFetch(url);
  // Returns { observations: [{date, value}, ...] }
  const obs: Array<{ date: string; value: string }> = data ?? [];
  const history = obs
    .filter(o => o.value !== "." && o.value)
    .map(o => ({ date: o.date, yield: parseFloat(o.value) }))
    .slice(-120); // last ~120 days

  if (history.length === 0) throw new Error("FRED 10Y no data");
  const last = history[history.length - 1];
  const prev = history.length >= 2 ? history[history.length - 2] : last;
  return { date: last.date, yield: last.yield, change: last.yield - prev.yield, history };
}

// ─── FRED — US CPI (monthly) ───────────────────────────────────────────────────

export async function fetchUSCPI(): Promise<{
  date: string;          // YYYY-MM-DD (first of month)
  value: number;         // index level
  yoy: number;           // year-over-year %
  mom: number;           // month-over-month %
  history: Array<{ date: string; value: number; yoy: number }>;
}> {
  const url = "https://fred.stlouisfed.org/graph/fredgraph.json?id=CPIAUCSL";
  const data = await safeFetch(url);
  const obs: Array<{ date: string; value: string }> = data ?? [];
  const history = obs
    .filter(o => o.value !== "." && o.value)
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .slice(-36); // 3 years for sparkline

  if (history.length < 2) throw new Error("FRED CPI no data");
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const yoyEntry = history.length >= 13 ? history[history.length - 13] : history[0];
  const yoy = yoyEntry.value > 0 ? ((last.value - yoyEntry.value) / yoyEntry.value) * 100 : 0;
  const mom = prev.value > 0 ? ((last.value - prev.value) / prev.value) * 100 : 0;

  const histWithYoy = history.map((h, i) => {
    const yoyRef = i >= 12 ? history[i - 12] : null;
    const y = yoyRef && yoyRef.value > 0 ? ((h.value - yoyRef.value) / yoyRef.value) * 100 : 0;
    return { date: h.date, value: h.value, yoy: y };
  });

  return { date: last.date, value: last.value, yoy, mom, history: histWithYoy };
}

// ─── Fear & Greed Index (alternative.me) ──────────────────────────────────────

export async function fetchFearGreed(): Promise<{
  date: string;
  value: number;       // 0–100
  label: string;       // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  history: Array<{ date: string; value: number }>;
}> {
  const url = "https://api.alternative.me/fng/?limit=60&format=json";
  const data = await safeFetch(url);
  const entries: Array<{ value: string; value_classification: string; timestamp: string }> =
    data?.data ?? [];
  if (entries.length === 0) throw new Error("Fear&Greed no data");
  const history = entries.reverse().map(e => ({
    date: new Date(parseInt(e.timestamp) * 1000).toISOString().slice(0, 10),
    value: parseInt(e.value, 10),
    label: e.value_classification,
  }));
  const last = history[history.length - 1];
  return { date: last.date, value: last.value, label: last.label, history };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Convert TWSE date string "113/04/17" or "114/04/17" to "YYYY-MM-DD" */
export function twseDateToISO(raw: string): string {
  if (!raw) return "";
  const parts = raw.trim().split("/");
  if (parts.length === 3) {
    const rocYear = parseInt(parts[0], 10);
    const year = rocYear + 1911;
    const mm = parts[1].padStart(2, "0");
    const dd = parts[2].padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return "";
}
