/**
 * marketOverviewService.ts  v4.2
 *
 * DB-first incremental update + data assembly for the market overview page.
 * v4.2 changes:
 *  - tw_adv_dec: now stores limitUp(value3) and limitDown(value4) via metaJson
 *  - tw_margin: renamed label to 融資金額, stores marginChange in value2
 *  - taiexSignal: now combined with trade volume for better signal
 *  - foreignRows & marginRows: 3-month history from fetchers stored in DB
 */

import { storage } from "./storage";
import type { InsertMarketIndicator } from "@shared/schema";
import {
  fetchTWseTaiex,
  fetchTWseAdvDecline,
  fetchTWseForeignNet,
  fetchTWseMargin,
  fetchUSDTWD,
  fetchSP500,
  fetchNasdaq,
  fetchSOX,
  fetchDJIA,
  fetchVIX,
  fetchUS10Y,
  fetchUSCPI,
  fetchFearGreed,
  fetchFinmindForeignNet,
  fetchFinmindMargin,
} from "./marketIndicatorSources";
import {
  taiexCombinedSignal,
  foreignNetSignal,
  advDeclineSignal,
  marginSignal,
  usdtwdSignal,
  usIndexSignal,
  vixSignal,
  fearGreedSignal,
  us10YSignal,
  usCpiSignal,
  signalText,
  generateSummary,
  type SignalLevel,
} from "./marketIndicatorRules";

const NOW_MS = () => Date.now();
const TODAY = () => new Date().toISOString().slice(0, 10);

function sparkline(rows: { value: number }[], n = 30): number[] {
  return rows.slice(-n).map(r => r.value);
}

async function refreshIndicator(
  key: string,
  market: "TW" | "US",
  frequency: "daily" | "monthly",
  rows: Array<{ date: string; value: number; value2?: number | null; meta?: string | null }>,
  source: string,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  const now = NOW_MS();
  const inserts: InsertMarketIndicator[] = rows.map(r => ({
    indicatorKey: key,
    market,
    frequency,
    date: r.date,
    value: r.value,
    value2: r.value2 ?? null,
    metaJson: r.meta ?? null,
    source,
    createdAt: now,
    updatedAt: now,
  }));
  await storage.upsertIndicatorHistory(inserts);
}

export async function refreshAllIndicators(): Promise<void> {
  const results = await Promise.allSettled([
    // ── TW ──────────────────────────────────────────────────────────────────
    fetchTWseTaiex().then(r =>
      refreshIndicator("taiex", "TW", "daily",
        r.history.map(h => ({ date: h.date, value: h.close, value2: h.tradeValue })),
        "TWSE FMTQIK",
      )
    ),

    fetchTWseAdvDecline().then(r =>
      refreshIndicator("tw_adv_dec", "TW", "daily",
        [{
          date: r.date,
          value: r.advancers,
          value2: r.decliners,
          meta: JSON.stringify({ limitUp: r.limitUp, limitDown: r.limitDown, unchanged: r.unchanged }),
        }],
        "TWSE MI_INDEX tables",
      )
    ),

    // 外資買賣超 — 改用 Finmind（不受 TWSE IP 封鎖）
    // 主力來源：Finmind TaiwanStockTotalInstitutionalInvestors
    // Fallback：TWSE TWT38U（本機環境可用時）
    fetchFinmindForeignNet(dateNMonthsAgo(3))
      .catch(() => fetchTWseForeignNet().then(r =>
        r.history.map(h => ({ date: h.date, netBuySell: h.netBuySell }))
      ))
      .then(rows =>
        refreshIndicator("tw_foreign_net", "TW", "daily",
          rows.map(h => ({ date: h.date, value: h.netBuySell })),
          "Finmind TaiwanStockTotalInstitutionalInvestors",
        )
      ),

    // 融資餘額/增減 — 改用 Finmind（不受 TWSE IP 封鎖）
    fetchFinmindMargin(dateNMonthsAgo(3))
      .catch(() => fetchTWseMargin().then(r =>
        r.history.map(h => ({ date: h.date, marginBalance: h.marginBalance, marginChange: h.marginChange }))
      ))
      .then(rows =>
        refreshIndicator("tw_margin", "TW", "daily",
          rows.map(h => ({ date: h.date, value: h.marginBalance, value2: h.marginChange })),
          "Finmind TaiwanStockTotalMarginPurchaseShortSale",
        )
      ),

    fetchUSDTWD().then(r =>
      refreshIndicator("usdtwd", "TW", "daily",
        r.history.map(h => ({ date: h.date, value: h.rate })),
        "Yahoo Finance USDTWD=X",
      )
    ),

    // ── US ───────────────────────────────────────────────────────────────────
    fetchDJIA().then(r =>
      refreshIndicator("djia", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.close })),
        "Yahoo Finance ^DJI",
      )
    ),

    fetchSP500().then(r =>
      refreshIndicator("sp500", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.close })),
        "Yahoo Finance ^GSPC",
      )
    ),

    fetchNasdaq().then(r =>
      refreshIndicator("nasdaq", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.close })),
        "Yahoo Finance ^IXIC",
      )
    ),

    fetchSOX().then(r =>
      refreshIndicator("sox", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.close })),
        "Yahoo Finance ^SOX",
      )
    ),

    fetchVIX().then(r =>
      refreshIndicator("vix", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.close })),
        "Yahoo Finance ^VIX",
      )
    ),

    fetchFearGreed().then(r =>
      // Only write CNN historical data (trading days only — no weekend gap-fill)
      // r.history already contains the most recent trading day as last entry
      refreshIndicator("fear_greed", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.value, meta: h.label })),
        "CNN Fear&Greed",
      )
    ),

    fetchUS10Y().then(r =>
      refreshIndicator("us_10y", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.yield })),
        "Yahoo Finance ^TNX",
      )
    ).then(() =>
      fetchUS10Y().then(r =>
        // store referenceValue (3M avg) in value2 of the latest row
        refreshIndicator("us_10y", "US", "daily",
          [{ date: r.date, value: r.yield, value2: r.referenceValue }],
          "Yahoo Finance ^TNX",
        )
      ).catch(() => {})
    ),

    (async () => {
      const lastCpi = await storage.getLatestIndicatorDate("us_cpi");
      const curMonth = TODAY().slice(0, 7);
      if (lastCpi && lastCpi.slice(0, 7) >= curMonth) return;
      const r = await fetchUSCPI();
      await refreshIndicator("us_cpi", "US", "monthly",
        r.history.map(h => ({ date: h.date, value: h.yoy })),
        "Alpha Vantage CPI",
      );
    })(),
  ]);

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[marketOverview] refresh task ${i} failed:`, r.reason?.message ?? r.reason);
    }
  });
}

// ─── Payload types ──────────────────────────────────────────────────────────

export interface IndicatorCard {
  key: string;
  label: string;
  value: number | null;
  value2?: number | null;
  meta?: string | null;
  change?: number | null;
  changePct?: number | null;
  date: string | null;
  signal: SignalLevel | null;
  signalText: string | null;
  sparkline: number[];
  history?: Array<{ date: string; value: number }>;  // for bar charts
  referenceValue?: number | null;  // e.g. 1-year average for USD/TWD baseline
  stale: boolean;
}

export interface MarketOverviewPayload {
  tw: IndicatorCard[];
  us: IndicatorCard[];
  summary: { tw: string; us: string };
  updatedAt: string;
}

function isStale(dateStr: string | null): boolean {
  if (!dateStr) return true;
  const diff = Date.now() - new Date(dateStr).getTime();
  return diff > 3 * 24 * 60 * 60 * 1000;
}

function lastTwo(rows: { date: string; value: number; value2?: number | null; metaJson?: string | null }[]) {
  const last = rows[rows.length - 1] ?? null;
  const prev = rows[rows.length - 2] ?? null;
  return { last, prev };
}
// Returns ISO date string for N months ago
function dateNMonthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

// Filter, sort, deduplicate rows to daily within last 3 months
function dailyLast3Mo<T extends { date: string }>(rows: T[]): T[] {
  const cutoff = dateNMonthsAgo(3);
  const seen = new Set<string>();
  return rows
    .filter(r => r.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter(r => { if (seen.has(r.date)) return false; seen.add(r.date); return true; });
}

export async function assembleMarketOverview(): Promise<MarketOverviewPayload> {
  const [
    taiexRows, advDecRows, foreignRows, marginRows, usdtwdRows,
    djiaRows, sp500Rows, nasdaqRows, soxRows, vixRows,
    fgRows, us10yRows, cpiRows,
  ] = await Promise.all([
    storage.getIndicatorHistory("taiex"),
    storage.getIndicatorHistory("tw_adv_dec"),
    storage.getIndicatorHistory("tw_foreign_net"),
    storage.getIndicatorHistory("tw_margin"),
    storage.getIndicatorHistory("usdtwd"),
    storage.getIndicatorHistory("djia"),
    storage.getIndicatorHistory("sp500"),
    storage.getIndicatorHistory("nasdaq"),
    storage.getIndicatorHistory("sox"),
    storage.getIndicatorHistory("vix"),
    storage.getIndicatorHistory("fear_greed"),
    storage.getIndicatorHistory("us_10y"),
    storage.getIndicatorHistory("us_cpi"),
  ]);

  // ─── TW cards ──────────────────────────────────────────────────────────────

  // TAIEX — signal uses both price change AND trade volume
  const { last: tLast, prev: tPrev } = lastTwo(taiexRows);
  const taiexChangePct = tLast && tPrev ? ((tLast.value - tPrev.value) / tPrev.value) * 100 : null;
  const tradeValue = tLast?.value2 ?? null;  // 億元
  const taiexSig = taiexChangePct !== null
    ? taiexCombinedSignal(taiexChangePct, tradeValue)
    : null;

  const taiexCard: IndicatorCard = {
    key: "taiex",
    label: "加權指數",
    value: tLast?.value ?? null,
    value2: tradeValue,          // 成交值 億元 (shown inside taiex card)
    date: tLast?.date ?? null,
    change: tLast && tPrev ? tLast.value - tPrev.value : null,
    changePct: taiexChangePct,
    signal: taiexSig,
    signalText: taiexSig ? signalText(taiexSig) : null,
    sparkline: sparkline(taiexRows),
    stale: isStale(tLast?.date ?? null),
  };

  // 漲跌家數 — value=advancers, value2=decliners, meta has limitUp/limitDown/unchanged
  const { last: adLast } = lastTwo(advDecRows);
  let limitUp = 0, limitDown = 0, unchanged = 0;
  if (adLast?.metaJson) {
    try {
      const m = JSON.parse(adLast.metaJson);
      limitUp = m.limitUp ?? 0;
      limitDown = m.limitDown ?? 0;
      unchanged = m.unchanged ?? 0;
    } catch { /* ignore */ }
  }
  const adSig = adLast ? advDeclineSignal(adLast.value, adLast.value2 ?? 0) : null;
  const advDecCard: IndicatorCard = {
    key: "tw_adv_dec",
    label: "漲跌家數",
    value: adLast?.value ?? null,       // 上漲
    value2: adLast?.value2 ?? null,     // 下跌
    meta: adLast?.metaJson ?? null,     // JSON: {limitUp, limitDown, unchanged}
    date: adLast?.date ?? null,
    signal: adSig,
    signalText: adSig ? signalText(adSig) : null,
    sparkline: [],
    stale: isStale(adLast?.date ?? null),
  };

  // 外資買賣超 — history for bar chart
  const { last: fLast } = lastTwo(foreignRows);
  const fSig = fLast ? foreignNetSignal(fLast.value) : null;
  const foreignCard: IndicatorCard = {
    key: "tw_foreign_net",
    label: "外資買賣超",
    value: fLast?.value ?? null,
    date: fLast?.date ?? null,
    signal: fSig,
    signalText: fSig ? signalText(fSig) : null,
    sparkline: sparkline(foreignRows),
    history: dailyLast3Mo(foreignRows).map(r => ({ date: r.date, value: r.value })),
    stale: isStale(fLast?.date ?? null),
  };

  // 融資金額 — value=balance, value2=change
  const { last: mLast, prev: mPrev } = lastTwo(marginRows);
  const marginChange = mLast?.value2 !== null && mLast?.value2 !== undefined
    ? mLast.value2
    : (mLast && mPrev ? mLast.value - mPrev.value : null);
  const mSig = marginChange !== null ? marginSignal(marginChange) : null;
  const marginCard: IndicatorCard = {
    key: "tw_margin",
    label: "融資增減",        // v4.6: primary = daily change, secondary = balance
    value: marginChange,       // primary: 每日融資增減 (value2 from DB)
    value2: mLast?.value ?? null, // secondary: 融資餘額
    date: mLast?.date ?? null,
    signal: mSig,
    signalText: mSig ? signalText(mSig) : null,
    sparkline: sparkline(marginRows),
    history: dailyLast3Mo(marginRows).map(r => ({ date: r.date, value: r.value2 ?? 0 })), // daily change
    stale: isStale(mLast?.date ?? null),
  };

  // USD/TWD
  const { last: uLast, prev: uPrev } = lastTwo(usdtwdRows);
  const usdtwdSig = uLast && uPrev ? usdtwdSignal(uLast.value, uPrev.value) : null;
  // Compute 1y average from DB history for baseline
  const usdtwd1yAgo = dateNMonthsAgo(12);
  const usdtwd1yRows = usdtwdRows.filter(r => r.date >= usdtwd1yAgo);
  const usdtwdYearAvg = usdtwd1yRows.length > 0
    ? Math.round((usdtwd1yRows.reduce((s, r) => s + r.value, 0) / usdtwd1yRows.length) * 1000) / 1000
    : null;
  const usdtwdCard: IndicatorCard = {
    key: "usdtwd",
    label: "美元/台幣",
    value: uLast?.value ?? null,
    change: uLast && uPrev ? uLast.value - uPrev.value : null,
    date: uLast?.date ?? null,
    signal: usdtwdSig,
    signalText: usdtwdSig ? signalText(usdtwdSig) : null,
    sparkline: sparkline(usdtwdRows),
    history: dailyLast3Mo(usdtwdRows).map(r => ({ date: r.date, value: r.value })),
    referenceValue: usdtwdYearAvg,  // 1-year average for baseline
    stale: isStale(uLast?.date ?? null),
  };

  // ─── US cards ──────────────────────────────────────────────────────────────

  const makeIndexCard = (
    key: string, label: string,
    rows: { date: string; value: number; value2?: number | null; metaJson?: string | null }[],
  ): IndicatorCard => {
    const { last, prev } = lastTwo(rows);
    const changePct = last && prev ? ((last.value - prev.value) / prev.value) * 100 : null;
    const sig = changePct !== null ? usIndexSignal(changePct) : null;
    return {
      key, label,
      value: last?.value ?? null,
      change: last && prev ? last.value - prev.value : null,
      changePct,
      date: last?.date ?? null,
      signal: sig,
      signalText: sig ? signalText(sig) : null,
      sparkline: sparkline(rows),
      stale: isStale(last?.date ?? null),
    };
  };

  const djiaCard  = makeIndexCard("djia",   "道瓊工業",   djiaRows);
  const sp500Card = makeIndexCard("sp500",  "S&P 500",    sp500Rows);
  const nasdaqCard = makeIndexCard("nasdaq", "Nasdaq",    nasdaqRows);
  const soxCard   = makeIndexCard("sox",    "費城半導體", soxRows);

  // VIX
  const { last: vixLast, prev: vixPrev } = lastTwo(vixRows);
  const vixSig = vixLast ? vixSignal(vixLast.value) : null;
  const vixCard: IndicatorCard = {
    key: "vix", label: "VIX 恐慌指數",
    value: vixLast?.value ?? null,
    change: vixLast && vixPrev ? vixLast.value - vixPrev.value : null,
    date: vixLast?.date ?? null,
    signal: vixSig,
    signalText: vixSig ? signalText(vixSig) : null,
    sparkline: sparkline(vixRows),
    history: dailyLast3Mo(vixRows).map(r => ({ date: r.date, value: r.value })),
    stale: isStale(vixLast?.date ?? null),
  };

  // Fear & Greed (CNN)  — history sliced to last 60 days for RegimeChart
  const { last: fgLast } = lastTwo(fgRows);
  const fgSig = fgLast ? fearGreedSignal(fgLast.value) : null;
  const fgCard: IndicatorCard = {
    key: "fear_greed", label: "CNN 恐懼貪婪指數",
    value: fgLast?.value ?? null,
    meta: fgLast?.metaJson ?? null,
    date: fgLast?.date ?? null,
    signal: fgSig,
    signalText: fgSig ? signalText(fgSig) : null,
    sparkline: [],
    history: dailyLast3Mo(fgRows).slice(-60).map(r => ({ date: r.date, value: r.value })),
    stale: isStale(fgLast?.date ?? null),
  };

  // US 10Y — with 3M history + referenceValue (3M average stored in value2 of latest row)
  const { last: y10Last, prev: y10Prev } = lastTwo(us10yRows);
  const y10Sig = y10Last ? us10YSignal(y10Last.value) : null;
  // Compute 3M average from DB history as fallback if value2 not stored
  const y10HistoryRows = dailyLast3Mo(us10yRows);
  const y10ValidYields = y10HistoryRows.map(r => r.value).filter(v => v > 0);
  const y10RefFromDB = y10ValidYields.length > 0
    ? Math.round((y10ValidYields.reduce((a, b) => a + b, 0) / y10ValidYields.length) * 1000) / 1000
    : null;
  const y10Ref = y10Last?.value2 ?? y10RefFromDB;
  const us10yCard: IndicatorCard = {
    key: "us_10y", label: "美10年期公債",
    value: y10Last?.value ?? null,
    change: y10Last && y10Prev ? y10Last.value - y10Prev.value : null,
    date: y10Last?.date ?? null,
    signal: y10Sig,
    signalText: y10Sig ? signalText(y10Sig) : null,
    sparkline: sparkline(us10yRows),
    history: y10HistoryRows.map(r => ({ date: r.date, value: r.value })),
    referenceValue: y10Ref,
    stale: isStale(y10Last?.date ?? null),
  };

  // US CPI — with 24-month monthly history (values are YoY%)
  const cpiSorted = [...cpiRows].sort((a, b) => a.date.localeCompare(b.date));
  const { last: cpiLast, prev: cpiPrev } = lastTwo(cpiSorted);
  const cpiSig = cpiLast ? usCpiSignal(cpiLast.value) : null;
  // Format date as "Mar 2026" for CPI (monthly)
  const cpiDateFormatted = cpiLast?.date
    ? (() => {
        const [y, m] = cpiLast.date.split("-");
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${months[parseInt(m, 10) - 1]} ${y}`;
      })()
    : null;
  const cpiCard: IndicatorCard = {
    key: "us_cpi", label: "美國 CPI (YoY)",
    value: cpiLast?.value ?? null,
    change: cpiLast && cpiPrev ? cpiLast.value - cpiPrev.value : null,
    date: cpiDateFormatted ?? cpiLast?.date ?? null,
    signal: cpiSig,
    signalText: cpiSig ? signalText(cpiSig) : null,
    sparkline: sparkline(cpiSorted, 24),
    history: cpiSorted.slice(-24).map(r => ({ date: r.date, value: r.value })),
    stale: isStale(cpiLast?.date ?? null),
  };

  // ─── Summary ───────────────────────────────────────────────────────────────
  const twSignals = [taiexSig, fSig, adSig, mSig, usdtwdSig].filter((s): s is SignalLevel => s !== null);
  const usSignals = [djiaCard.signal, sp500Card.signal, nasdaqCard.signal, soxCard.signal,
                     vixSig, fgSig, y10Sig, cpiSig].filter((s): s is SignalLevel => s !== null);
  const summary = generateSummary(twSignals, usSignals);

  return {
    // TW order: taiex(含成交值), 漲跌家數, 外資買賣超, 融資金額, USD/TWD
    tw: [taiexCard, advDecCard, foreignCard, marginCard, usdtwdCard],
    us: [djiaCard, sp500Card, nasdaqCard, soxCard, vixCard, fgCard, us10yCard, cpiCard],
    summary,
    updatedAt: new Date().toISOString(),
  };
}
