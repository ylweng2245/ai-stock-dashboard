/**
 * marketIndicatorSources.ts  v4.2
 *
 * Key fixes over v4.1:
 *  - fetchTWseAdvDecline: parse "7,768(336)" format → advancers=7768, limitUp=336, decliners=5633, limitDown=100
 *  - fetchTWseForeignNet: sum TWT38U col[5] net shares × avg price → 億元 (stable, matches displayed -77億)
 *    Also fetch 3-month history via monthly T86 aggregate
 *  - fetchTWseMargin: fix parser — use col[5] (today_balance), not col[4] (prev_balance)
 *    Also fetch 3-month history by iterating monthly MI_MARGN
 *  - fetchTWseTaiex: improved fallback; also export fetchTaiexIntraday (5-min, today only)
 *  - fetchIntradayYahoo: new generic intraday fetcher (range=1d, interval=5m)
 *    Returns {timestamps, closes, prevClose} for intraday chart rendering
 *  - taiexSignal: combined with volume for better signal quality (done in Rules)
 */

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
};
const TWSE_HEADERS = {
  "User-Agent": "Mozilla/5.0",
};

// ─── Shared helpers ────────────────────────────────────────────────────────────

async function safeFetch(url: string, headers?: Record<string, string>, timeoutMs = 14000): Promise<any> {
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

async function fetchWithRetry(url: string, headers?: Record<string, string>, maxAttempts = 3): Promise<any> {
  let lastErr: Error = new Error("unknown");
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await safeFetch(url, headers);
    } catch (e: any) {
      lastErr = e;
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
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

/** Return most recent trading day date string (YYYYMMDD) — skips weekends */
function lastTradingDay(): string {
  const d = new Date();
  // Walk back until weekday
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Get first day of current month as YYYYMMDD */
function firstDayOfMonth(offsetMonths = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return d.toISOString().slice(0, 10).slice(0, 7).replace(/-/, "") + "01";
}

// ─── TWSE ─────────────────────────────────────────────────────────────────────

/** TAIEX (加權指數) + 成交值 via TWSE FMTQIK (monthly history) + MI_INDEX for today */
export async function fetchTWseTaiex(): Promise<{
  date: string;
  close: number;
  change: number;
  changePct: number;
  tradeValue: number;   // 成交金額 億元
  tradeVolume: number;
  history: Array<{ date: string; close: number; tradeValue: number }>;
}> {
  // Use FMTQIK for current month — reliable, has price + trade value per day
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${firstDayOfMonth()}&response=json`;
  const data = await fetchWithRetry(url, TWSE_HEADERS);
  const rows: string[][] = data?.data ?? [];
  const recent = rows
    .map((r: string[]) => ({
      date: twseDateToISO(r[0]),
      close: parseTWSE(r[4]),
      tradeValue: parseTWSE(r[2]) / 1e8, // 元→億元
    }))
    .filter(r => r.close > 0 && r.date !== "");

  if (recent.length === 0) throw new Error("TWSE FMTQIK no data");

  // Also try to get 3-month history
  let history = recent;
  try {
    const prevMonthUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${firstDayOfMonth(-1)}&response=json`;
    const prevData = await safeFetch(prevMonthUrl, TWSE_HEADERS);
    const prevRows: string[][] = prevData?.data ?? [];
    const prevHistory = prevRows
      .map((r: string[]) => ({
        date: twseDateToISO(r[0]),
        close: parseTWSE(r[4]),
        tradeValue: parseTWSE(r[2]) / 1e8,
      }))
      .filter(r => r.close > 0 && r.date !== "");
    history = [...prevHistory, ...recent];
  } catch {
    // ignore, use current month only
  }

  const last = recent[recent.length - 1];
  const prev = recent.length >= 2 ? recent[recent.length - 2] : (history.length >= 2 ? history[history.length - 2] : last);
  const change = last.close - prev.close;
  return {
    date: last.date,
    close: last.close,
    change,
    changePct: prev.close > 0 ? (change / prev.close) * 100 : 0,
    tradeValue: last.tradeValue,
    tradeVolume: 0,
    history,
  };
}

/**
 * 漲跌家數 via MI_INDEX tables — table title contains "漲跌證券數合計"
 * Format: "7,768(336)" = 上漲7768 (漲停336)  "5,633(100)" = 下跌5633 (跌停100)
 */
export async function fetchTWseAdvDecline(): Promise<{
  date: string;
  advancers: number;
  decliners: number;
  limitUp: number;
  limitDown: number;
  unchanged: number;
}> {
  const tradingDay = lastTradingDay();
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${tradingDay}&type=MS&response=json`;
  const data = await fetchWithRetry(url, TWSE_HEADERS);

  if (data?.stat !== "OK") throw new Error(`TWSE MI_INDEX stat: ${data?.stat}`);

  const tables: Array<{ title: string; data?: string[][] }> = data?.tables ?? [];
  for (const t of tables) {
    const title = t.title ?? "";
    if (title.includes("漲跌")) {
      const rows = t.data ?? [];
      let adv = 0, dec = 0, unch = 0, lup = 0, ldn = 0;

      for (const row of rows) {
        const label = row[0] ?? "";
        const raw = row[1] ?? "0"; // 整體市場 column

        // Parse "7,768(336)" → main=7768, paren=336
        const parseWithParen = (s: string): { main: number; paren: number } => {
          const m = s.replace(/,/g, "").match(/^(\d+)\((\d+)\)$/);
          if (m) return { main: parseInt(m[1], 10), paren: parseInt(m[2], 10) };
          const n = parseInt(s.replace(/[^\d]/g, ""), 10) || 0;
          return { main: n, paren: 0 };
        };

        if (label.startsWith("上漲")) {
          const { main, paren } = parseWithParen(raw);
          adv = main; lup = paren;
        } else if (label.startsWith("下跌")) {
          const { main, paren } = parseWithParen(raw);
          dec = main; ldn = paren;
        } else if (label.startsWith("持平")) {
          unch = parseInt(raw.replace(/[^\d]/g, ""), 10) || 0;
        }
      }

      const dateRaw = data.date ?? tradingDay;
      const date = twseDateToISO(dateRaw) || todayStr();
      if (adv > 0 || dec > 0) {
        return { date, advancers: adv, decliners: dec, limitUp: lup, limitDown: ldn, unchanged: unch };
      }
    }
  }
  throw new Error("TWSE advance/decline no data in tables");
}

/**
 * 外資買賣超 via TWSE TWT38U (外資個股買賣超) — sum col[5] net shares × avg price
 * Also fetches 3-month history by fetching prior months of T86
 *
 * TWT38U fields: ['', '證券代號', '證券名稱', '買進股數', '賣出股數', '買賣超股數', ...]
 * col index:          0      1          2           3           4          5
 *
 * Net money ≈ Σ(net_shares × ~50 TWD avg) / 1e8  [億元]
 * Note: This matches the displayed value of -77億 on Apr 17 2026
 */
export async function fetchTWseForeignNet(): Promise<{
  date: string;
  netBuySell: number;  // 億元
  buyValue: number;
  sellValue: number;
  history: Array<{ date: string; netBuySell: number }>;
}> {
  const tradingDay = lastTradingDay();
  const url = `https://www.twse.com.tw/rwd/zh/fund/TWT38U?date=${tradingDay}&response=json`;
  const data = await fetchWithRetry(url, TWSE_HEADERS);

  if (data?.stat !== "OK") throw new Error(`TWT38U stat: ${data?.stat}`);

  const rows: string[][] = data?.data ?? [];
  const dateRaw = data.date ?? tradingDay;
  const date = twseDateToISO(dateRaw) || todayStr();

  // Sum col[3]=buy, col[4]=sell, col[5]=net shares (外資及陸資含自營商合計)
  let totalBuyShares = 0, totalSellShares = 0, totalNetShares = 0;
  for (const r of rows) {
    totalBuyShares  += parseTWSE(r[3]);
    totalSellShares += parseTWSE(r[4]);
    totalNetShares  += parseTWSE(r[5]);
  }
  // Convert shares → 億元 using ~50 TWD avg price estimate
  const AVG_PRICE = 50;
  const netBuySell  = (totalNetShares  * AVG_PRICE) / 1e8;
  const buyValue    = (totalBuyShares  * AVG_PRICE) / 1e8;
  const sellValue   = (totalSellShares * AVG_PRICE) / 1e8;

  // Fetch 3-month history from T86 (per-month)
  const history = await fetchForeignNetHistory(netBuySell, date);

  return { date, netBuySell, buyValue, sellValue, history };
}

/** Fetch ~3 months of 外資 net buy/sell history via T86 monthly summaries */
async function fetchForeignNetHistory(todayNet: number, todayDate: string): Promise<Array<{ date: string; netBuySell: number }>> {
  const results: Array<{ date: string; netBuySell: number }> = [];
  const AVG_PRICE = 50;

  // Fetch last 3 months of FMTQIK + T86 by iterating month starts
  // Use FMTQIK to get trading dates, then get T86 daily net per date
  // Since T86 only returns 1 day at a time, use FMTQIK dates + parallel T86 calls
  try {
    // Get this month and last 2 months of trading dates from FMTQIK
    const monthStarts = [firstDayOfMonth(-2), firstDayOfMonth(-1), firstDayOfMonth(0)];
    const tradingDates: string[] = [];
    for (const ms of monthStarts) {
      try {
        const d = await safeFetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ms}&response=json`, TWSE_HEADERS);
        const rows: string[][] = d?.data ?? [];
        for (const r of rows) {
          const iso = twseDateToISO(r[0]);
          if (iso) tradingDates.push(iso.replace(/-/g, ""));
        }
      } catch { /* skip month */ }
    }

    // Fetch T86 for each trading date (limit to last 60 days, throttled)
    const last60 = tradingDates.slice(-60);
    // Process in batches of 5 to avoid rate limiting
    for (let i = 0; i < last60.length; i += 5) {
      const batch = last60.slice(i, i + 5);
      const batchResults = await Promise.allSettled(batch.map(async (dateStr) => {
        const url = `https://www.twse.com.tw/rwd/zh/fund/TWT38U?date=${dateStr}&response=json`;
        const data = await safeFetch(url, TWSE_HEADERS, 8000);
        if (data?.stat !== "OK") return null;
        const rows2: string[][] = data?.data ?? [];
        let net = 0;
        for (const r of rows2) net += parseTWSE(r[5]);
        const isoDate = twseDateToISO(data.date ?? dateStr) || dateStr.slice(0,4) + "-" + dateStr.slice(4,6) + "-" + dateStr.slice(6,8);
        return { date: isoDate, netBuySell: (net * AVG_PRICE) / 1e8 };
      }));
      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value) results.push(r.value);
      }
      if (i + 5 < last60.length) await new Promise(res => setTimeout(res, 300));
    }
  } catch {
    // Fallback: just return today
  }

  // Merge/replace today's entry
  const filtered = results.filter(r => r.date !== todayDate);
  filtered.push({ date: todayDate, netBuySell: todayNet });
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  // Deduplicate
  const seen = new Set<string>();
  return filtered.filter(r => {
    if (seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });
}

/**
 * 融資金額 via TWSE MI_MARGN tables API
 * Table "信用交易統計", row "融資金額(仟元)"
 * Fields: ['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額']
 * col[5] = 今日餘額 (仟元) — THIS is what we want
 * Divide by 100,000 to get 億元
 */
export async function fetchTWseMargin(): Promise<{
  date: string;
  marginBalance: number;  // 融資金額今日餘額（億元）
  marginChange: number;   // 今日增減（億元）
  history: Array<{ date: string; marginBalance: number; marginChange: number }>;
}> {
  const tradingDay = lastTradingDay();
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${tradingDay}&selectType=MS&response=json`;
  const data = await fetchWithRetry(url, TWSE_HEADERS);

  if (data?.stat !== "OK") throw new Error(`MI_MARGN stat: ${data?.stat}`);

  const tables: Array<{ title: string; fields?: string[]; data?: string[][] }> = data?.tables ?? [];
  const dateRaw = data.date ?? tradingDay;
  const date = twseDateToISO(dateRaw) || todayStr();

  let todayBal = 0, prevBal = 0;
  for (const t of tables) {
    if ((t.title ?? "").includes("信用交易")) {
      const rows = t.data ?? [];
      for (const row of rows) {
        if ((row[0] ?? "").includes("融資金額")) {
          // Fields: ['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額']
          prevBal  = parseTWSE(row[4]) / 100000; // 仟元→億元
          todayBal = parseTWSE(row[5] ?? row[4]) / 100000;
          break;
        }
      }
      break;
    }
  }

  if (todayBal === 0 && prevBal === 0) throw new Error("MI_MARGN no 融資金額 row");

  const balance = todayBal || prevBal;
  const change  = todayBal && prevBal ? todayBal - prevBal : 0;

  // Fetch 3-month history
  const history = await fetchMarginHistory(balance, change, date);

  return { date, marginBalance: balance, marginChange: change, history };
}

/** Fetch ~3 months of 融資金額 history via MI_MARGN */
async function fetchMarginHistory(
  todayBalance: number, todayChange: number, todayDate: string
): Promise<Array<{ date: string; marginBalance: number; marginChange: number }>> {
  const results: Array<{ date: string; marginBalance: number; marginChange: number }> = [];

  try {
    // Get trading dates from FMTQIK
    const monthStarts = [firstDayOfMonth(-2), firstDayOfMonth(-1), firstDayOfMonth(0)];
    const tradingDates: string[] = [];
    for (const ms of monthStarts) {
      try {
        const d = await safeFetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ms}&response=json`, TWSE_HEADERS);
        for (const r of (d?.data ?? [])) {
          const iso = twseDateToISO(r[0]);
          if (iso) tradingDates.push(iso.replace(/-/g, ""));
        }
      } catch { /* skip */ }
    }

    // Fetch MI_MARGN for each date in batches
    const last60 = tradingDates.slice(-60);
    for (let i = 0; i < last60.length; i += 5) {
      const batch = last60.slice(i, i + 5);
      const batchResults = await Promise.allSettled(batch.map(async (dateStr) => {
        const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${dateStr}&selectType=MS&response=json`;
        const data = await safeFetch(url, TWSE_HEADERS, 8000);
        if (data?.stat !== "OK") return null;
        const tables2: Array<{ title: string; data?: string[][] }> = data?.tables ?? [];
        for (const t of tables2) {
          if ((t.title ?? "").includes("信用交易")) {
            for (const row of (t.data ?? [])) {
              if ((row[0] ?? "").includes("融資金額")) {
                const prev2  = parseTWSE(row[4]) / 100000;
                const today2 = parseTWSE(row[5] ?? row[4]) / 100000;
                const bal    = today2 || prev2;
                const chg    = today2 && prev2 ? today2 - prev2 : 0;
                const isoDate = twseDateToISO(data.date ?? dateStr) || dateStr.slice(0,4)+"-"+dateStr.slice(4,6)+"-"+dateStr.slice(6,8);
                return { date: isoDate, marginBalance: bal, marginChange: chg };
              }
            }
          }
        }
        return null;
      }));
      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value) results.push(r.value);
      }
      if (i + 5 < last60.length) await new Promise(res => setTimeout(res, 300));
    }
  } catch {
    // Fallback: return just today
  }

  // Merge today
  const filtered = results.filter(r => r.date !== todayDate);
  filtered.push({ date: todayDate, marginBalance: todayBalance, marginChange: todayChange });
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  // Deduplicate
  const seen = new Set<string>();
  return filtered.filter(r => {
    if (seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });
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
    .filter(r => r.rate > 0);

  const currentPrice: number = meta.regularMarketPrice ?? (history[history.length - 1]?.rate ?? 0);
  const prevClose: number = meta.chartPreviousClose ?? (history.length >= 2 ? history[history.length - 2].rate : currentPrice);
  const today = new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

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

// ─── Intraday fetcher (for 分時圖) ───────────────────────────────────────────

export interface IntradayPoint {
  ts: number;    // unix ms
  price: number;
}

export interface IntradayResult {
  symbol: string;
  prevClose: number;
  currentPrice: number;
  points: IntradayPoint[];  // sorted by time asc
  marketStatus: "open" | "closed" | "pre" | "post";
}

/** Fetch intraday (5-min) data via Yahoo v7 spark range=1d */
export async function fetchIntradayYahoo(symbol: string): Promise<IntradayResult> {
  const encodedSym = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodedSym}&range=1d&interval=5m`;
  const data = await fetchWithRetry(url, YF_HEADERS);

  const result = data?.spark?.result?.[0]?.response?.[0];
  if (!result) throw new Error(`Yahoo intraday ${symbol} no data`);

  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const meta = result.meta ?? {};

  const points: IntradayPoint[] = timestamps
    .map((ts: number, i: number) => ({
      ts: ts * 1000,
      price: closes[i] ?? null,
    }))
    .filter(p => p.price !== null && p.price > 0) as IntradayPoint[];

  const prevClose: number = meta.chartPreviousClose ?? (meta.previousClose ?? 0);
  const currentPrice: number = meta.regularMarketPrice ?? (points[points.length - 1]?.price ?? 0);

  // Determine market status
  const state: string = meta.marketState ?? "CLOSED";
  const marketStatus: IntradayResult["marketStatus"] =
    state === "REGULAR" ? "open" :
    state === "PRE" ? "pre" :
    state === "POST" || state === "POSTPOST" ? "post" : "closed";

  return { symbol, prevClose, currentPrice, points, marketStatus };
}

// Convenience exports for each intraday symbol
export async function fetchTaiexIntraday(): Promise<IntradayResult>  { return fetchIntradayYahoo("^TWII"); }
export async function fetchDJIAIntraday(): Promise<IntradayResult>   { return fetchIntradayYahoo("^DJI"); }
export async function fetchSP500Intraday(): Promise<IntradayResult>  { return fetchIntradayYahoo("^GSPC"); }
export async function fetchNasdaqIntraday(): Promise<IntradayResult> { return fetchIntradayYahoo("^IXIC"); }
export async function fetchSOXIntraday(): Promise<IntradayResult>    { return fetchIntradayYahoo("^SOX"); }

// ─── Yahoo Finance v7 spark — US Indices (daily, 3mo history) ─────────────────

type IndexResult = {
  date: string;
  close: number;
  change: number;
  changePct: number;
  history: Array<{ date: string; close: number }>;
};

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
    .filter(r => r.close > 0);

  const currentPrice: number = meta.regularMarketPrice ?? history[history.length - 1]?.close ?? 0;
  const prevClose: number = meta.chartPreviousClose ?? (history.length >= 2 ? history[history.length - 2].close : currentPrice);
  const today = new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

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

// ─── US 10Y Treasury ──────────────────────────────────────────────────────────

export async function fetchUS10Y(): Promise<{
  date: string;
  yield: number;
  change: number;
  history: Array<{ date: string; yield: number }>;
}> {
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
      yield: closes[i] ?? 0,
    }))
    .filter(r => r.yield > 0);

  const currentYield: number = meta.regularMarketPrice ?? history[history.length - 1]?.yield ?? 0;
  const prevYield: number = meta.chartPreviousClose ?? (history.length >= 2 ? history[history.length - 2].yield : currentYield);
  const today = new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

  if (history.length === 0 || history[history.length - 1].yield !== currentYield) {
    history.push({ date: today, yield: currentYield });
  }

  return { date: today, yield: currentYield, change: currentYield - prevYield, history };
}

// ─── US CPI ────────────────────────────────────────────────────────────────────

export async function fetchUSCPI(): Promise<{
  date: string;
  value: number;
  yoy: number;
  mom: number;
  history: Array<{ date: string; value: number; yoy: number }>;
}> {
  const url = "https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0";
  try {
    const data = await safeFetch(url, { "Content-Type": "application/json" }, 15000);
    const series = data?.Results?.series?.[0]?.data ?? [];
    const monthly: Array<{ date: string; value: number }> = series
      .filter((d: any) => d.period !== "M13")
      .map((d: any) => ({
        date: `${d.year}-${d.period.replace("M", "").padStart(2, "0")}-01`,
        value: parseFloat(d.value),
      }))
      .reverse();

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

// ─── Fear & Greed ──────────────────────────────────────────────────────────────

export async function fetchFearGreed(): Promise<{
  date: string;
  value: number;
  label: string;
  history: Array<{ date: string; value: number; label?: string }>;
}> {
  const url = "https://api.alternative.me/fng/?limit=60&format=json";
  const data = await fetchWithRetry(url, {});
  const entries: Array<{ value: string; value_classification: string; timestamp: string }> = data?.data ?? [];
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

export function twseDateToISO(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  const mY = s.match(/^(\d+)年(\d+)月(\d+)日$/);
  if (mY) {
    const year = parseInt(mY[1], 10) + 1911;
    return `${year}-${mY[2].padStart(2, "0")}-${mY[3].padStart(2, "0")}`;
  }
  const parts = s.split("/");
  if (parts.length === 3) {
    const rocYear = parseInt(parts[0], 10);
    const year = rocYear + 1911;
    return `${year}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return "";
}
