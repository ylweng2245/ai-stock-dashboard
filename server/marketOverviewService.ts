/**
 * marketOverviewService.ts
 *
 * DB-first incremental update + data assembly for the market overview page.
 * Fetches latest data from upstream, merges into DB, then assembles the payload.
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
} from "./marketIndicatorSources";
import {
  taiexSignal,
  twseVolumeSignal,
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

/** Sparkline: last N values from history rows */
function sparkline(rows: { value: number }[], n = 30): number[] {
  return rows.slice(-n).map(r => r.value);
}

/** Safe fetch+upsert: fetches upstream, upserts new rows into DB.
 *  All fetchers take no args — they always return latest available data.
 *  We deduplicate via upsert (ON CONFLICT ... DO UPDATE). */
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

/** Refresh all indicators (best-effort, non-fatal on individual failures) */
export async function refreshAllIndicators(): Promise<void> {
  const results = await Promise.allSettled([
    // ── TW ──────────────────────────────────────────────────────────────────
    fetchTWseTaiex().then(r =>
      refreshIndicator("taiex", "TW", "daily",
        r.history.map(h => ({ date: h.date, value: h.close, value2: h.tradeValue })),
        "TWSE MI_INDEX",
      )
    ),

    fetchTWseAdvDecline().then(r =>
      refreshIndicator("tw_adv_dec", "TW", "daily",
        [{ date: r.date, value: r.advancers, value2: r.decliners }],
        "TWSE MI_INDEX data3",
      )
    ),

    fetchTWseForeignNet().then(r =>
      refreshIndicator("tw_foreign_net", "TW", "daily",
        r.history.map(h => ({ date: h.date, value: h.netBuySell })),
        "TWSE T86",
      )
    ),

    fetchTWseMargin().then(r =>
      refreshIndicator("tw_margin", "TW", "daily",
        r.history.map(h => ({ date: h.date, value: h.marginBalance })),
        "TWSE MI_MARGN",
      )
    ),

    fetchUSDTWD().then(r =>
      refreshIndicator("usdtwd", "TW", "daily",
        r.history.map(h => ({ date: h.date, value: h.rate })),
        "Yahoo Finance USDTWD=X",
      )
    ),

    // ── US (DJIA first) ──────────────────────────────────────────────────────
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

    // Fear & Greed — history has value only (no label on history items)
    fetchFearGreed().then(r =>
      refreshIndicator("fear_greed", "US", "daily",
        // Store the label in meta only for the latest point via separate upsert below
        r.history.map(h => ({ date: h.date, value: h.value })),
        "Alternative.me FNG",
      ).then(() =>
        // Upsert latest with label in metaJson
        refreshIndicator("fear_greed", "US", "daily",
          [{ date: r.date, value: r.value, meta: r.label }],
          "Alternative.me FNG",
        )
      )
    ),

    fetchUS10Y().then(r =>
      refreshIndicator("us_10y", "US", "daily",
        r.history.map(h => ({ date: h.date, value: h.yield })),
        "FRED DGS10",
      )
    ),

    // CPI monthly — skip if current month already stored
    (async () => {
      const lastCpi = await storage.getLatestIndicatorDate("us_cpi");
      const curMonth = TODAY().slice(0, 7);
      if (lastCpi && lastCpi.slice(0, 7) >= curMonth) return; // already fresh
      const r = await fetchUSCPI();
      await refreshIndicator("us_cpi", "US", "monthly",
        r.history.map(h => ({ date: h.date, value: h.yoy })),
        "FRED CPIAUCSL",
      );
    })(),
  ]);

  // Log failures (non-fatal)
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[marketOverview] refresh task ${i} failed:`, r.reason?.message ?? r.reason);
    }
  });
}

// ─── Assemble the full market overview payload ──────────────────────────────

export interface IndicatorCard {
  key: string;
  label: string;
  value: number | null;
  value2?: number | null;
  meta?: string | null;       // e.g. Fear&Greed label
  change?: number | null;     // absolute change
  changePct?: number | null;  // % change
  date: string | null;
  signal: SignalLevel | null;
  signalText: string | null;
  sparkline: number[];
  stale: boolean;             // true if data is > 3 trading days old
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
  return diff > 3 * 24 * 60 * 60 * 1000; // 3 days
}

function lastTwo(rows: { date: string; value: number; value2?: number | null; metaJson?: string | null }[]) {
  const last = rows[rows.length - 1] ?? null;
  const prev = rows[rows.length - 2] ?? null;
  return { last, prev };
}

export async function assembleMarketOverview(): Promise<MarketOverviewPayload> {
  // Load histories in parallel
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

  // ─── TW cards ────────────────────────────────────────────────────────────

  // TAIEX
  const { last: tLast, prev: tPrev } = lastTwo(taiexRows);
  const taiexChangePct = tLast && tPrev ? ((tLast.value - tPrev.value) / tPrev.value) * 100 : null;
  const taiexSig = taiexChangePct !== null ? taiexSignal(taiexChangePct) : null;

  const taiexCard: IndicatorCard = {
    key: "taiex",
    label: "加權指數",
    value: tLast?.value ?? null,
    value2: tLast?.value2 ?? null,
    date: tLast?.date ?? null,
    change: tLast && tPrev ? tLast.value - tPrev.value : null,
    changePct: taiexChangePct,
    signal: taiexSig,
    signalText: taiexSig ? signalText(taiexSig) : null,
    sparkline: sparkline(taiexRows),
    stale: isStale(tLast?.date ?? null),
  };

  // 成交值 (value2 of taiex = tradeValue in 億 TWD)
  const twVolume = tLast?.value2 ?? null;
  const twVolumeSig = twVolume !== null ? twseVolumeSignal(twVolume) : null;
  const volumeCard: IndicatorCard = {
    key: "tw_volume",
    label: "成交值",
    value: twVolume,
    date: tLast?.date ?? null,
    signal: twVolumeSig,
    signalText: twVolumeSig ? signalText(twVolumeSig) : null,
    sparkline: [],
    stale: isStale(tLast?.date ?? null),
  };

  // 漲跌家數
  const { last: adLast } = lastTwo(advDecRows);
  const adSig = adLast ? advDeclineSignal(adLast.value, adLast.value2 ?? 0) : null;
  const advDecCard: IndicatorCard = {
    key: "tw_adv_dec",
    label: "漲跌家數",
    value: adLast?.value ?? null,
    value2: adLast?.value2 ?? null,
    date: adLast?.date ?? null,
    signal: adSig,
    signalText: adSig ? signalText(adSig) : null,
    sparkline: [],
    stale: isStale(adLast?.date ?? null),
  };

  // 外資買賣超
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
    stale: isStale(fLast?.date ?? null),
  };

  // 融資餘額 — value = marginBalance, value2 = marginChange (computed from consecutive rows)
  const { last: mLast, prev: mPrev } = lastTwo(marginRows);
  const marginChange = mLast && mPrev ? mLast.value - mPrev.value : null;
  const mSig = marginChange !== null ? marginSignal(marginChange) : null;
  const marginCard: IndicatorCard = {
    key: "tw_margin",
    label: "融資餘額",
    value: mLast?.value ?? null,
    value2: marginChange,
    date: mLast?.date ?? null,
    signal: mSig,
    signalText: mSig ? signalText(mSig) : null,
    sparkline: sparkline(marginRows),
    stale: isStale(mLast?.date ?? null),
  };

  // USD/TWD
  const { last: uLast, prev: uPrev } = lastTwo(usdtwdRows);
  const usdtwdSig = uLast && uPrev ? usdtwdSignal(uLast.value, uPrev.value) : null;
  const usdtwdCard: IndicatorCard = {
    key: "usdtwd",
    label: "美元/台幣",
    value: uLast?.value ?? null,
    change: uLast && uPrev ? uLast.value - uPrev.value : null,
    date: uLast?.date ?? null,
    signal: usdtwdSig,
    signalText: usdtwdSig ? signalText(usdtwdSig) : null,
    sparkline: sparkline(usdtwdRows),
    stale: isStale(uLast?.date ?? null),
  };

  // ─── US cards (DJIA first) ────────────────────────────────────────────────

  // DJIA
  const { last: djLast, prev: djPrev } = lastTwo(djiaRows);
  const djChangePct = djLast && djPrev ? ((djLast.value - djPrev.value) / djPrev.value) * 100 : null;
  const djSig = djChangePct !== null ? usIndexSignal(djChangePct) : null;
  const djiaCard: IndicatorCard = {
    key: "djia",
    label: "道瓊工業",
    value: djLast?.value ?? null,
    change: djLast && djPrev ? djLast.value - djPrev.value : null,
    changePct: djChangePct,
    date: djLast?.date ?? null,
    signal: djSig,
    signalText: djSig ? signalText(djSig) : null,
    sparkline: sparkline(djiaRows),
    stale: isStale(djLast?.date ?? null),
  };

  // S&P500
  const { last: spLast, prev: spPrev } = lastTwo(sp500Rows);
  const spChangePct = spLast && spPrev ? ((spLast.value - spPrev.value) / spPrev.value) * 100 : null;
  const spSig = spChangePct !== null ? usIndexSignal(spChangePct) : null;
  const sp500Card: IndicatorCard = {
    key: "sp500",
    label: "S&P 500",
    value: spLast?.value ?? null,
    change: spLast && spPrev ? spLast.value - spPrev.value : null,
    changePct: spChangePct,
    date: spLast?.date ?? null,
    signal: spSig,
    signalText: spSig ? signalText(spSig) : null,
    sparkline: sparkline(sp500Rows),
    stale: isStale(spLast?.date ?? null),
  };

  // Nasdaq
  const { last: nqLast, prev: nqPrev } = lastTwo(nasdaqRows);
  const nqChangePct = nqLast && nqPrev ? ((nqLast.value - nqPrev.value) / nqPrev.value) * 100 : null;
  const nqSig = nqChangePct !== null ? usIndexSignal(nqChangePct) : null;
  const nasdaqCard: IndicatorCard = {
    key: "nasdaq",
    label: "Nasdaq",
    value: nqLast?.value ?? null,
    change: nqLast && nqPrev ? nqLast.value - nqPrev.value : null,
    changePct: nqChangePct,
    date: nqLast?.date ?? null,
    signal: nqSig,
    signalText: nqSig ? signalText(nqSig) : null,
    sparkline: sparkline(nasdaqRows),
    stale: isStale(nqLast?.date ?? null),
  };

  // SOX
  const { last: soxLast, prev: soxPrev } = lastTwo(soxRows);
  const soxChangePct = soxLast && soxPrev ? ((soxLast.value - soxPrev.value) / soxPrev.value) * 100 : null;
  const soxSig = soxChangePct !== null ? usIndexSignal(soxChangePct) : null;
  const soxCard: IndicatorCard = {
    key: "sox",
    label: "費城半導體",
    value: soxLast?.value ?? null,
    change: soxLast && soxPrev ? soxLast.value - soxPrev.value : null,
    changePct: soxChangePct,
    date: soxLast?.date ?? null,
    signal: soxSig,
    signalText: soxSig ? signalText(soxSig) : null,
    sparkline: sparkline(soxRows),
    stale: isStale(soxLast?.date ?? null),
  };

  // VIX
  const { last: vixLast, prev: vixPrev } = lastTwo(vixRows);
  const vixSig = vixLast ? vixSignal(vixLast.value) : null;
  const vixCard: IndicatorCard = {
    key: "vix",
    label: "VIX 恐慌指數",
    value: vixLast?.value ?? null,
    change: vixLast && vixPrev ? vixLast.value - vixPrev.value : null,
    date: vixLast?.date ?? null,
    signal: vixSig,
    signalText: vixSig ? signalText(vixSig) : null,
    sparkline: sparkline(vixRows),
    stale: isStale(vixLast?.date ?? null),
  };

  // Fear & Greed
  const { last: fgLast } = lastTwo(fgRows);
  const fgSig = fgLast ? fearGreedSignal(fgLast.value) : null;
  const fgCard: IndicatorCard = {
    key: "fear_greed",
    label: "恐懼貪婪指數",
    value: fgLast?.value ?? null,
    meta: fgLast?.metaJson ?? null,
    date: fgLast?.date ?? null,
    signal: fgSig,
    signalText: fgSig ? signalText(fgSig) : null,
    sparkline: [],
    stale: isStale(fgLast?.date ?? null),
  };

  // US 10Y
  const { last: y10Last, prev: y10Prev } = lastTwo(us10yRows);
  const y10Sig = y10Last ? us10YSignal(y10Last.value) : null;
  const us10yCard: IndicatorCard = {
    key: "us_10y",
    label: "美10年期公債",
    value: y10Last?.value ?? null,
    change: y10Last && y10Prev ? y10Last.value - y10Prev.value : null,
    date: y10Last?.date ?? null,
    signal: y10Sig,
    signalText: y10Sig ? signalText(y10Sig) : null,
    sparkline: sparkline(us10yRows),
    stale: isStale(y10Last?.date ?? null),
  };

  // US CPI
  const { last: cpiLast, prev: cpiPrev } = lastTwo(cpiRows);
  const cpiSig = cpiLast ? usCpiSignal(cpiLast.value) : null;
  const cpiCard: IndicatorCard = {
    key: "us_cpi",
    label: "美國 CPI (YoY)",
    value: cpiLast?.value ?? null,
    change: cpiLast && cpiPrev ? cpiLast.value - cpiPrev.value : null,
    date: cpiLast?.date ?? null,
    signal: cpiSig,
    signalText: cpiSig ? signalText(cpiSig) : null,
    sparkline: sparkline(cpiRows, 24),
    stale: isStale(cpiLast?.date ?? null),
  };

  // ─── Summary ─────────────────────────────────────────────────────────────
  const twSignals = [
    taiexCard.signal,
    twVolumeSig,
    fSig,
    adSig,
    mSig,
    usdtwdSig,
  ].filter((s): s is SignalLevel => s !== null);

  const usSignals = [
    djSig,
    spSig,
    nqSig,
    soxSig,
    vixSig,
    fgSig,
    y10Sig,
    cpiSig,
  ].filter((s): s is SignalLevel => s !== null);

  const summary = generateSummary(twSignals, usSignals);

  return {
    tw: [taiexCard, volumeCard, foreignCard, advDecCard, marginCard, usdtwdCard],
    // US order: DJIA first, then SP500, Nasdaq, SOX, VIX, F&G, 10Y, CPI
    us: [djiaCard, sp500Card, nasdaqCard, soxCard, vixCard, fgCard, us10yCard, cpiCard],
    summary,
    updatedAt: new Date().toISOString(),
  };
}
