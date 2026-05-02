/**
 * fundamentalService.ts — Fundamental data via yahoo-finance2 (pure Node.js)
 *
 * Data source: yahoo-finance2 npm package (no Python required)
 *   - US stocks: symbol as-is  (e.g. LLY, PANW)
 *   - TW stocks: symbol + ".TW" suffix  (e.g. 2330.TW)
 *
 * Update strategy:
 *   - TTL: 1 day (auto-refreshed daily before market open via scheduled job)
 *   - Manual resync always bypasses TTL
 *   - Always full-replace on upsert
 *
 * Scoring:
 *   - 成長性 (Growth):      revenueGrowth, earningsGrowth, 4Q CAGR, fwd estimate
 *   - 財務體質 (Quality):    grossMargins, operatingMargins, FCF margin, debt/equity
 *   - 價值評估 (Valuation):  trailingPE, forwardPE, PEG, dividendYield (vs sector benchmarks)
 */

import YahooFinance from "yahoo-finance2";
import { storage } from "./storage";
import type { InsertFundamentalData } from "@shared/schema";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FundamentalRating = "excellent" | "good" | "neutral" | "weak" | "poor";

export interface MetricItem {
  name: string;
  value: string;          // display string e.g. "+31%", "80.2%", "58.4x"
  numericValue?: number;  // raw number for chart use
  rating: FundamentalRating;
  commentary: string;
}

export interface PillarCard {
  pillar: "growth" | "quality" | "valuation";
  title: string;
  score: number;           // 0–100
  summary: string;
  metrics: MetricItem[];
}

export interface QuarterlyBar {
  quarter: string;         // e.g. "2025Q4"
  revenue: number;         // in native currency (USD or TWD)
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
}

export interface EpsPoint {
  quarter: string;         // "2025Q4"
  actual: number;
  estimate: number;
  surprise: number;        // percentage
}

export interface FinancialEvent {
  date: string;            // "YYYY-MM-DD"
  type: "earnings" | "dividend" | "fiscalYearEnd";
  label: string;
  daysFromNow: number;
}

export interface SummaryRow {
  dimension: string;
  rating: FundamentalRating;
  commentary: string;
}

export interface FundamentalResult {
  symbol: string;
  market: "TW" | "US";
  name: string;
  sector: string;
  industry: string;
  currency: string;

  pillars: PillarCard[];
  quarterlyBars: QuarterlyBar[];
  epsHistory: EpsPoint[];
  financialEvents: FinancialEvent[];
  summaryRows: SummaryRow[];

  // Raw ratios for value chart
  trailingPE?: number;
  forwardPE?: number;
  pegRatio?: number;
  grossMargins?: number;
  operatingMargins?: number;
  profitMargins?: number;

  fetchedAt: number;
  isStale: boolean;        // true if > 1 day old
}

// ---------------------------------------------------------------------------
// Yahoo Finance fetcher (pure Node.js, no Python)
// ---------------------------------------------------------------------------

async function fetchFromYahooFinance(symbol: string, market: "TW" | "US"): Promise<any> {
  const ySymbol = market === "TW" ? `${symbol}.TW` : symbol;

  // Fetch quoteSummary for ratios + EPS history + calendar
  const summary = await yf.quoteSummary(ySymbol, {
    modules: [
      "financialData",
      "defaultKeyStatistics",
      "summaryDetail",
      "assetProfile",
      "price",
      "earningsHistory",
      "calendarEvents",
    ],
  });

  // Fetch quarterly income via fundamentalsTimeSeries (more reliable post-Nov 2024)
  let quarterlyIncome: any[] = [];
  try {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 3); // last 3 years (12 quarters)
    const ts = await yf.fundamentalsTimeSeries(ySymbol, {
      period1: period1.toISOString().slice(0, 10),
      type: "quarterly",
      module: "financials",
    });
    // Normalize to simple objects sorted newest-first
    quarterlyIncome = (ts as any[])
      .map((q: any) => ({
        date: q.date instanceof Date ? q.date.toISOString().slice(0, 10) : String(q.date).slice(0, 10),
        totalRevenue:     q.totalRevenue     ?? q.operatingRevenue ?? null,
        grossProfit:      q.grossProfit      ?? null,
        operatingIncome:  q.operatingIncome  ?? q.EBIT             ?? null,
        netIncome:        q.netIncome        ?? null,
      }))
      .filter((q: any) => q.totalRevenue != null)
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 12);
  } catch (e: any) {
    console.warn(`[fundamentalService] fundamentalsTimeSeries failed for ${ySymbol}:`, e.message);
    // Fallback: use incomeStatementHistoryQuarterly (older data, may be incomplete)
    try {
      const fallback = await yf.quoteSummary(ySymbol, {
        modules: ["incomeStatementHistoryQuarterly"],
      });
      const hist = fallback.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [];
      quarterlyIncome = hist
        .map((q: any) => ({
          date: q.endDate instanceof Date ? q.endDate.toISOString().slice(0, 10) : String(q.endDate).slice(0, 10),
          totalRevenue:    q.totalRevenue    ?? null,
          grossProfit:     q.grossProfit     ?? null,
          operatingIncome: q.operatingIncome ?? null,
          netIncome:       q.netIncome       ?? null,
        }))
        .filter((q: any) => q.totalRevenue != null)
        .slice(0, 12);
    } catch { /* ignore */ }
  }

  // Build info object compatible with scoring functions
  const fd  = summary.financialData        ?? {};
  const ks  = summary.defaultKeyStatistics ?? {};
  const sd  = summary.summaryDetail        ?? {};
  const ap  = (summary as any).assetProfile ?? {};
  const pr  = (summary as any).price        ?? {};
  const cal = summary.calendarEvents       ?? {};
  const eh  = summary.earningsHistory?.history ?? [];

  const info: any = {
    // Names — longName/shortName from price module; sector/industry from assetProfile
    longName:  pr.longName  ?? pr.shortName  ?? ySymbol,
    shortName: pr.shortName ?? pr.longName   ?? ySymbol,
    sector:    ap.sector    ?? "",
    industry:  ap.industry  ?? "",
    currency:  pr.currency  ?? (fd as any).financialCurrency ?? (market === "TW" ? "TWD" : "USD"),

    // Ratios from summaryDetail (most reliable source)
    trailingPE:  (sd as any).trailingPE  ?? null,
    forwardPE:   (sd as any).forwardPE   ?? null,
    dividendYield: (sd as any).dividendYield ?? (sd as any).trailingAnnualDividendYield ?? null,

    // Ratios from defaultKeyStatistics
    pegRatio:    (ks as any).pegRatio    ?? null,
    trailingEps: (ks as any).trailingEps ?? null,
    forwardEps:  (ks as any).forwardEps  ?? null,
    priceToBook: (ks as any).priceToBook ?? null,

    // Growth & margins from financialData
    grossMargins:      (fd as any).grossMargins      ?? null,
    operatingMargins:  (fd as any).operatingMargins  ?? null,
    profitMargins:     (fd as any).profitMargins      ?? null,
    revenueGrowth:     (fd as any).revenueGrowth     ?? null,
    earningsGrowth:    (fd as any).earningsGrowth    ?? null,
    freeCashflow:      (fd as any).freeCashflow       ?? null,
    operatingCashflow: (fd as any).operatingCashflow  ?? null,
    totalRevenue:      (fd as any).totalRevenue       ?? null,
    debtToEquity:      (fd as any).debtToEquity       ?? null,
    currentRatio:      (fd as any).currentRatio       ?? null,
    marketCap:         (sd as any).marketCap          ?? null,
  };

  // Parse calendar
  const earningsArr = (cal as any).earnings?.earningsDate ?? [];
  const earningsDate = earningsArr.length > 0
    ? (earningsArr[0] instanceof Date ? earningsArr[0].toISOString().slice(0,10) : String(earningsArr[0]).slice(0,10))
    : null;
  const exDiv = (cal as any).exDividendDate;
  const exDividendDate = exDiv instanceof Date ? exDiv.toISOString().slice(0,10) : (exDiv ? String(exDiv).slice(0,10) : null);

  const calendarData: any = {
    earningsDate,
    exDividendDate,
    earningsAverage:  (cal as any).earnings?.earningsAverage   ?? null,
    revenueAverage:   (cal as any).earnings?.revenueAverage    ?? null,
  };

  // EPS history
  const epsRows = eh.slice(0, 12).map((row: any) => ({
    quarter:         row.quarter instanceof Date ? row.quarter.toISOString().slice(0,10) : String(row.quarter ?? ""),
    epsActual:       row.epsActual      ?? 0,
    epsEstimate:     row.epsEstimate    ?? 0,
    surprisePercent: row.surprisePercent ?? 0,
  }));

  return { info, quarterlyIncome, epsHistory: epsRows, calendar: calendarData };
}

// ---------------------------------------------------------------------------
// Sector benchmark PE/yield for relative valuation
// ---------------------------------------------------------------------------

interface SectorBenchmarks {
  trailingPE: number;
  forwardPE: number;
  dividendYield: number;  // as fraction e.g. 0.023
  label: string;
}

const SECTOR_BENCHMARKS: Record<string, SectorBenchmarks> = {
  "Drug Manufacturers - General": { trailingPE: 26, forwardPE: 19, dividendYield: 0.023, label: "大型製藥" },
  "Biotechnology":               { trailingPE: 22, forwardPE: 16, dividendYield: 0.008, label: "生技" },
  "Semiconductors":              { trailingPE: 25, forwardPE: 18, dividendYield: 0.015, label: "半導體" },
  "Technology":                  { trailingPE: 28, forwardPE: 20, dividendYield: 0.010, label: "科技" },
  "Software - Application":      { trailingPE: 35, forwardPE: 25, dividendYield: 0.005, label: "軟體" },
  "Software - Infrastructure":   { trailingPE: 40, forwardPE: 28, dividendYield: 0.005, label: "基礎軟體" },
  "Cybersecurity":               { trailingPE: 60, forwardPE: 38, dividendYield: 0.000, label: "資安" },
  "Aerospace & Defense":         { trailingPE: 23, forwardPE: 17, dividendYield: 0.020, label: "航太國防" },
  "Utilities - Regulated Electric": { trailingPE: 18, forwardPE: 15, dividendYield: 0.035, label: "公用事業" },
  "Electronics":                 { trailingPE: 20, forwardPE: 15, dividendYield: 0.020, label: "電子" },
  "Computer Hardware":           { trailingPE: 22, forwardPE: 16, dividendYield: 0.012, label: "電腦硬體" },
  // Default fallback
  "DEFAULT":                     { trailingPE: 22, forwardPE: 16, dividendYield: 0.020, label: "同業" },
};

function getBenchmark(industry: string, sector: string): SectorBenchmarks {
  return SECTOR_BENCHMARKS[industry]
    ?? SECTOR_BENCHMARKS[sector]
    ?? SECTOR_BENCHMARKS["DEFAULT"];
}

// ---------------------------------------------------------------------------
// Rating helpers
// ---------------------------------------------------------------------------

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

/** Score 0–100 from thresholds [excellent, good, neutral, weak] */
function scoreFromThresholds(
  value: number,
  thresholds: [number, number, number, number],  // [excellent, good, neutral, weak]
  higherIsBetter: boolean
): { score: number; rating: FundamentalRating } {
  const [t1, t2, t3, t4] = thresholds;
  const v = value;

  let score: number;
  let rating: FundamentalRating;

  if (higherIsBetter) {
    if (v >= t1)      { rating = "excellent"; score = 90 + clamp((v - t1) / t1 * 10, 0, 10); }
    else if (v >= t2) { rating = "good";      score = 75 + clamp((v - t2) / (t1 - t2) * 15, 0, 15); }
    else if (v >= t3) { rating = "neutral";   score = 55 + clamp((v - t3) / (t2 - t3) * 20, 0, 20); }
    else if (v >= t4) { rating = "weak";      score = 30 + clamp((v - t4) / (t3 - t4) * 25, 0, 25); }
    else              { rating = "poor";      score = clamp(v / t4 * 30, 0, 30); }
  } else {
    // Lower is better (e.g. PE, debt)
    if (v <= t1)      { rating = "excellent"; score = 90; }
    else if (v <= t2) { rating = "good";      score = 75 + clamp((t2 - v) / (t2 - t1) * 15, 0, 15); }
    else if (v <= t3) { rating = "neutral";   score = 55 + clamp((t3 - v) / (t3 - t2) * 20, 0, 20); }
    else if (v <= t4) { rating = "weak";      score = 30 + clamp((t4 - v) / (t4 - t3) * 25, 0, 25); }
    else              { rating = "poor";      score = clamp(30 - (v - t4) / t4 * 30, 0, 30); }
  }

  return { score: Math.round(score), rating };
}

function pct(v?: number | null): string {
  if (v == null) return "N/A";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtX(v?: number | null, digits = 1): string {
  if (v == null) return "N/A";
  return `${v.toFixed(digits)}x`;
}

function yoyPct(values: number[]): number | null {
  // values sorted newest-first
  if (values.length < 5) return null;
  const recent = values[0];
  const yearAgo = values[4];
  if (!yearAgo || yearAgo === 0) return null;
  return (recent - yearAgo) / Math.abs(yearAgo);
}

function cagr4q(values: number[]): number | null {
  // values sorted newest-first, need at least 4+1
  if (values.length < 5) return null;
  const latest = values[0];
  const base = values[4];
  if (!base || base <= 0) return null;
  return Math.pow(latest / base, 1) - 1; // 4Q / 4Q = 1 year CAGR approximation
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

function computeGrowthPillar(
  info: any,
  quarters: any[],
  calendar: any
): PillarCard {
  const metrics: MetricItem[] = [];
  const scores: number[] = [];

  // 1. 季度營收 YoY
  const revValues = quarters
    .map((q: any) => q["totalRevenue"])
    .filter((v: any): v is number => v != null && v > 0);
  let revYoY = info.revenueGrowth as number | null;
  if (revYoY == null && revValues.length >= 5) revYoY = yoyPct(revValues);

  if (revYoY != null) {
    const { score, rating } = scoreFromThresholds(revYoY, [0.25, 0.12, 0.04, -0.03], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "高於常態成長區間，屬強成長。",
      good: "成長力道正向，優於整體市場均值。",
      neutral: "溫和成長，符合穩健企業常態。",
      weak: "成長趨緩，需追蹤後續季度表現。",
      poor: "負成長，需關注基本面是否惡化。",
    };
    metrics.push({
      name: "季度營收 YoY",
      value: pct(revYoY),
      numericValue: revYoY,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 2. EPS YoY
  const epsGrowth = info.earningsGrowth as number | null;
  if (epsGrowth != null) {
    const { score, rating } = scoreFromThresholds(epsGrowth, [0.30, 0.15, 0.05, -0.03], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "獲利增速快於營收，顯示營運槓桿改善。",
      good: "EPS 穩定成長，獲利結構健康。",
      neutral: "獲利成長溫和，無顯著異常。",
      weak: "獲利成長放緩，需留意費用端壓力。",
      poor: "EPS 下滑，獲利能力受壓。",
    };
    metrics.push({
      name: "EPS YoY",
      value: pct(epsGrowth),
      numericValue: epsGrowth,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 3. 近 4 季營收 CAGR
  const cagr = cagr4q(revValues);
  if (cagr != null) {
    const { score, rating } = scoreFromThresholds(cagr, [0.20, 0.10, 0.03, -0.02], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "不只單季爆發，成長趨勢具強延續性。",
      good: "成長具延續性，非單季曇花一現。",
      neutral: "成長趨勢平穩，沒有顯著加速或減速。",
      weak: "成長持續性不足，留意是否走弱。",
      poor: "近四季整體趨勢向下，需深入評估。",
    };
    metrics.push({
      name: "近 4 季營收 CAGR",
      value: pct(cagr),
      numericValue: cagr,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 4. 下季共識成長 (from calendar revenueAverage vs latest quarter)
  const fwdRevAvg = calendar?.revenueAverage as number | null;
  const latestRev = revValues[0];
  let fwdGrowth: number | null = null;
  if (fwdRevAvg && latestRev && latestRev > 0) {
    fwdGrowth = (fwdRevAvg - latestRev) / latestRev;
  }
  if (fwdGrowth != null) {
    const { score, rating } = scoreFromThresholds(fwdGrowth, [0.20, 0.10, 0.03, -0.02], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "市場對下季仍抱有強烈成長預期。",
      good: "共識預估仍正成長，方向良好。",
      neutral: "成長預期溫和，基期效應可能影響。",
      weak: "共識預估成長動能趨緩。",
      poor: "共識預估下修，後市需謹慎。",
    };
    metrics.push({
      name: "下季共識成長",
      value: pct(fwdGrowth),
      numericValue: fwdGrowth,
      rating,
      commentary: commentaries[rating],
    });
  }

  const score = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b) / scores.length) : 50;

  const summaries: Record<string, string> = {
    high: "近期營收與 EPS 維持強勁成長，且成長具有連續性。若後續共識預估仍能上修，分數可維持高檔。",
    mid: "成長動能穩健，具延續性，但不及高速成長企業。持續追蹤共識預估與財報節奏。",
    low: "成長趨勢放緩或出現負成長，需觀察是否為暫時性因素或結構轉變。",
  };

  return {
    pillar: "growth",
    title: "成長性",
    score,
    summary: score >= 70 ? summaries.high : score >= 45 ? summaries.mid : summaries.low,
    metrics,
  };
}

function computeQualityPillar(info: any, quarters: any[]): PillarCard {
  const metrics: MetricItem[] = [];
  const scores: number[] = [];

  // 1. 毛利率
  const gm = info.grossMargins as number | null;
  if (gm != null) {
    const { score, rating } = scoreFromThresholds(gm, [0.60, 0.40, 0.25, 0.15], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "極高毛利，反映強大定價能力或輕資產商業模式。",
      good: "毛利率良好，產品附加價值高。",
      neutral: "毛利率中等，競爭環境普通。",
      weak: "毛利率偏低，需觀察成本控制能力。",
      poor: "毛利率過低，盈利能力結構性承壓。",
    };
    metrics.push({
      name: "毛利率",
      value: pct(gm),
      numericValue: gm,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 2. 營業利益率
  const om = info.operatingMargins as number | null;
  if (om != null) {
    const { score, rating } = scoreFromThresholds(om, [0.30, 0.18, 0.08, 0.02], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "營收高效率轉化為營業獲利，管銷費用控制優異。",
      good: "營業獲利能力良好，費用結構健康。",
      neutral: "營益率適中，具基本盈利能力。",
      weak: "費用控制待改善，營業槓桿有限。",
      poor: "營業層面接近虧損邊緣，需密切追蹤。",
    };
    metrics.push({
      name: "營業利益率",
      value: pct(om),
      numericValue: om,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 3. 自由現金流率 (FCF / totalRevenue)
  const fcf = info.freeCashflow as number | null;
  const totalRev = info.totalRevenue as number | null;
  let fcfMargin: number | null = null;
  if (fcf != null && totalRev && totalRev > 0) {
    fcfMargin = fcf / totalRev;
  }
  if (fcfMargin != null) {
    const { score, rating } = scoreFromThresholds(fcfMargin, [0.20, 0.10, 0.04, 0.00], true);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "現金創造能力卓越，有利研發投入與股東回饋。",
      good: "自由現金流充裕，財務彈性高。",
      neutral: "現金流狀況普通，維持日常運營無虞。",
      weak: "自由現金流偏緊，資本支出或費用較高。",
      poor: "自由現金流為負，資金需求依賴外部融資。",
    };
    metrics.push({
      name: "自由現金流率",
      value: pct(fcfMargin),
      numericValue: fcfMargin,
      rating,
      commentary: commentaries[rating],
    });
  } else if (info.operatingCashflow != null && totalRev && totalRev > 0) {
    // fallback: use operating cashflow
    const ocfMargin = (info.operatingCashflow as number) / totalRev;
    const { score, rating } = scoreFromThresholds(ocfMargin, [0.25, 0.14, 0.06, 0.01], true);
    scores.push(score);
    metrics.push({
      name: "營業現金流率",
      value: pct(ocfMargin),
      numericValue: ocfMargin,
      rating,
      commentary: "現金流狀況的替代指標（自由現金流不可用時）。",
    });
  }

  // 4. Debt / Equity
  const de = info.debtToEquity as number | null;
  if (de != null) {
    // debtToEquity is in percent (165.31 = 1.6531x) in yahoo-finance2
    const deRatio = de / 100;
    const { score, rating } = scoreFromThresholds(deRatio, [0.3, 0.8, 1.5, 2.5], false);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "幾乎無槓桿，財務結構極為穩健。",
      good: "槓桿保守，債務壓力低。",
      neutral: "槓桿適中，在可接受範圍內。",
      weak: "槓桿偏高，利息負擔值得關注。",
      poor: "高槓桿，利率風險與再融資風險明顯。",
    };
    metrics.push({
      name: "Debt / Equity",
      value: fmtX(deRatio),
      numericValue: deRatio,
      rating,
      commentary: commentaries[rating],
    });
  }

  const score = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b) / scores.length) : 50;

  const summaries: Record<string, string> = {
    high: "公司具高毛利、高營益率與穩定現金流，整體財務結構健康。",
    mid: "財務體質尚可，主要指標表現平穩，部分面向仍有優化空間。",
    low: "財務體質偏弱，需關注現金流與負債結構是否帶來壓力。",
  };

  return {
    pillar: "quality",
    title: "財務體質",
    score,
    summary: score >= 70 ? summaries.high : score >= 45 ? summaries.mid : summaries.low,
    metrics,
  };
}

function computeValuationPillar(info: any, industry: string, sector: string): PillarCard {
  const metrics: MetricItem[] = [];
  const scores: number[] = [];
  const bench = getBenchmark(industry, sector);

  // 1. Trailing PE vs 同業
  const tpe = info.trailingPE as number | null;
  if (tpe != null && isFinite(tpe) && tpe > 0) {
    const ratio = tpe / bench.trailingPE;
    const { score, rating } = scoreFromThresholds(ratio, [0.8, 1.0, 1.3, 1.8], false);
    scores.push(score);
    const peStr = `${tpe.toFixed(1)}x vs ${bench.trailingPE.toFixed(1)}x`;
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "估值低於同業，提供較高安全邊際。",
      good: "估值合理，未見明顯溢價。",
      neutral: "估值略高於同業，但在合理範圍。",
      weak: "顯著溢價，市場已反映一定成長預期。",
      poor: "大幅溢價同業，估值壓縮風險值得注意。",
    };
    metrics.push({
      name: `Trailing PE vs ${bench.label}均值`,
      value: peStr,
      numericValue: tpe,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 2. Forward PE vs 同業
  const fpe = info.forwardPE as number | null;
  if (fpe != null && isFinite(fpe) && fpe > 0) {
    const ratio = fpe / bench.forwardPE;
    const { score, rating } = scoreFromThresholds(ratio, [0.75, 1.0, 1.3, 1.8], false);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "Forward PE 低於同業，成長預期已折算。",
      good: "前向估值合理，未過度反映樂觀情境。",
      neutral: "Forward PE 略高，但市場對成長仍有期待。",
      weak: "即使看未來獲利，估值仍高於同業均值。",
      poor: "Forward PE 大幅超出同業，安全邊際偏低。",
    };
    metrics.push({
      name: `Forward PE vs ${bench.label}均值`,
      value: `${fpe.toFixed(1)}x vs ${bench.forwardPE.toFixed(1)}x`,
      numericValue: fpe,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 3. PEG Ratio
  const peg = info.pegRatio as number | null;
  if (peg != null && isFinite(peg) && peg > 0) {
    const { score, rating } = scoreFromThresholds(peg, [0.8, 1.2, 1.8, 2.5], false);
    scores.push(score);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "成長溢價極低，具顯著安全邊際。",
      good: "PEG 合理，估值與成長匹配。",
      neutral: "溢價仍在可理解範圍，安全邊際不高。",
      weak: "PEG 偏高，估值相對成長不划算。",
      poor: "PEG 過高，估值嚴重脫離成長基本面。",
    };
    metrics.push({
      name: `PEG vs ${bench.label}均值`,
      value: `${peg.toFixed(2)} vs 1.3`,
      numericValue: peg,
      rating,
      commentary: commentaries[rating],
    });
  }

  // 4. Dividend Yield vs 同業
  const dy = (info.dividendYield ?? info.trailingAnnualDividendYield) as number | null;
  if (dy != null && dy >= 0) {
    const diff = dy - bench.dividendYield;
    const { score: rawScore, rating } = scoreFromThresholds(diff, [0.005, 0.000, -0.01, -0.02], true);
    scores.push(rawScore);
    const commentaries: Record<FundamentalRating, string> = {
      excellent: "殖利率高於同業，提供良好股息保護。",
      good: "殖利率與同業相當，股息回報合理。",
      neutral: "殖利率略低於同業，成長為主要報酬來源。",
      weak: "殖利率偏低，股息保護有限。",
      poor: "投資報酬主軸來自成長，幾乎無股息收益。",
    };
    metrics.push({
      name: `Dividend Yield vs ${bench.label}均值`,
      value: `${(dy * 100).toFixed(1)}% vs ${(bench.dividendYield * 100).toFixed(1)}%`,
      numericValue: dy,
      rating,
      commentary: commentaries[rating],
    });
  }

  const score = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b) / scores.length) : 50;

  const summaries: Record<string, string> = {
    high: "估值合理或低於同業，提供較高的安全邊際，適合價值型買點評估。",
    mid: "估值中等，有一定溢價但在市場接受範圍內，需搭配成長性評估。",
    low: "當前估值已明顯高於同業平均。若未來成長放緩，評價壓縮風險會放大。",
  };

  return {
    pillar: "valuation",
    title: "價值評估",
    score,
    summary: score >= 70 ? summaries.high : score >= 45 ? summaries.mid : summaries.low,
    metrics,
  };
}

function buildSummaryRows(pillars: PillarCard[], info: any, industry: string): SummaryRow[] {
  const bench = getBenchmark(industry, info.sector ?? "");
  const growth = pillars.find((p) => p.pillar === "growth")!;
  const quality = pillars.find((p) => p.pillar === "quality")!;
  const valuation = pillars.find((p) => p.pillar === "valuation")!;

  function scoreToRating(score: number): FundamentalRating {
    if (score >= 80) return "excellent";
    if (score >= 65) return "good";
    if (score >= 45) return "neutral";
    if (score >= 30) return "weak";
    return "poor";
  }

  // Peer comparison: trailingPE vs benchmark
  const tpe = info.trailingPE as number | null;
  let peerRating: FundamentalRating = "neutral";
  let peerComment = "估值水準與同業大致相當。";
  if (tpe != null && isFinite(tpe) && tpe > 0) {
    const r = tpe / bench.trailingPE;
    if (r <= 0.85) { peerRating = "excellent"; peerComment = "多項估值指標低於同業平均，相對便宜。"; }
    else if (r <= 1.05) { peerRating = "good"; peerComment = "估值接近同業均值，無明顯溢價。"; }
    else if (r <= 1.35) { peerRating = "neutral"; peerComment = "估值略高於同業，市場給予一定成長溢價。"; }
    else if (r <= 1.80) { peerRating = "weak"; peerComment = "多項估值指標高於同業平均。"; }
    else { peerRating = "poor"; peerComment = "顯著高於同業均值，估值壓縮風險需留意。"; }
  }

  // Current observation: blend of growth + valuation
  const avgScore = Math.round((growth.score + quality.score + valuation.score) / 3);
  const obsRating = scoreToRating(avgScore);
  const obsComments: Record<FundamentalRating, string> = {
    excellent: "各面向均表現優異，值得持續追蹤後續財報催化劑。",
    good: "整體基本面正向，適合長線觀察與逢低布局評估。",
    neutral: "追蹤財報續航與共識是否續升，等待更明確訊號。",
    weak: "基本面呈現混合訊號，建議降低倉位或等待改善。",
    poor: "多項指標出現警訊，宜謹慎評估持有必要性。",
  };

  return [
    { dimension: "成長主軸", rating: scoreToRating(growth.score), commentary: growth.summary.split("。")[0] + "。" },
    { dimension: "獲利品質", rating: scoreToRating(quality.score), commentary: quality.summary.split("。")[0] + "。" },
    { dimension: "估值位置", rating: scoreToRating(valuation.score), commentary: valuation.summary.split("。")[0] + "。" },
    { dimension: "同業比較", rating: peerRating, commentary: peerComment },
    { dimension: "目前觀察", rating: obsRating, commentary: obsComments[obsRating] },
  ];
}

function buildFinancialEvents(calendar: any): FinancialEvent[] {
  const events: FinancialEvent[] = [];
  const now = Date.now();

  function addEvent(dateStr: string | null | undefined, type: FinancialEvent["type"], label: string) {
    if (!dateStr) return;
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      const daysFromNow = Math.round((d.getTime() - now) / 86400000);
      if (daysFromNow < -30) return; // skip events >30 days in the past
      if (daysFromNow > 365) return; // skip events >1 year away
      events.push({ date: dateStr, type, label, daysFromNow });
    } catch { /* ignore */ }
  }

  addEvent(calendar?.earningsDate, "earnings", "財報發布日 Earnings");
  addEvent(calendar?.exDividendDate, "dividend", "除息日 Dividend");

  events.sort((a, b) => a.daysFromNow - b.daysFromNow);
  return events;
}

function buildQuarterlyBars(quarters: any[]): QuarterlyBar[] {
  return quarters
    .filter((q: any) => q["totalRevenue"] != null)
    .map((q: any) => {
      // Convert date "YYYY-MM-DD" to quarter label "YYYYQn"
      const d = new Date(q.date);
      const m = d.getMonth() + 1;
      const qn = Math.ceil(m / 3);
      const label = `${d.getFullYear()}Q${qn}`;
      return {
        quarter: label,
        revenue:         q["totalRevenue"]    ?? 0,
        grossProfit:     q["grossProfit"]     ?? 0,
        operatingIncome: q["operatingIncome"] ?? 0,
        netIncome:       q["netIncome"]       ?? 0,
      } as QuarterlyBar;
    })
    .reverse(); // oldest first for chart
}

function buildEpsHistory(epsRows: any[]): EpsPoint[] {
  return epsRows
    .map((row: any, i: number) => {
      const d = new Date(row.quarter || "");
      let label = `Q${i + 1}`;
      if (!isNaN(d.getTime())) {
        const m = d.getMonth() + 1;
        const qn = Math.ceil(m / 3);
        label = `${d.getFullYear()}Q${qn}`;
      }
      return {
        quarter:  label,
        actual:   row.epsActual   ?? 0,
        estimate: row.epsEstimate ?? 0,
        surprise: row.surprisePercent != null ? row.surprisePercent * 100 : 0,
      };
    })
    .reverse(); // oldest first
}

// ---------------------------------------------------------------------------
// TTL logic
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

function isExpired(fetchedAt: number, _calendar?: any): boolean {
  return Date.now() - fetchedAt > DEFAULT_TTL_MS;
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

export async function getOrFetchFundamentals(
  symbol: string,
  market: "TW" | "US",
  forceRefresh = false
): Promise<FundamentalResult> {
  // Check DB cache
  if (!forceRefresh) {
    const cached = storage.getFundamental(symbol, market);
    if (cached) {
      let cal: any = {};
      try { cal = JSON.parse(cached.calendarJson || "{}"); } catch { /* */ }
      if (!isExpired(cached.fetchedAt, cal)) {
        return assembleFundamentalResult(symbol, market, cached);
      }
    }
  }

  // Fetch fresh
  console.log(`[fundamentalService] Fetching yahoo-finance2: ${symbol} (${market})`);
  let raw: any;
  try {
    raw = await fetchFromYahooFinance(symbol, market);
  } catch (e: any) {
    console.error(`[fundamentalService] fetch error for ${symbol}:`, e.message);
    // Fall back to cached (possibly stale) data
    const cached = storage.getFundamental(symbol, market);
    if (cached) return assembleFundamentalResult(symbol, market, cached);
    throw new Error(`Failed to fetch fundamentals for ${symbol}: ${e.message}`);
  }

  const now = Date.now();
  const row: InsertFundamentalData = {
    symbol,
    market,
    infoJson:            JSON.stringify(raw.info          ?? {}),
    quarterlyIncomeJson: JSON.stringify(raw.quarterlyIncome ?? []),
    epsHistoryJson:      JSON.stringify(raw.epsHistory    ?? []),
    calendarJson:        JSON.stringify(raw.calendar      ?? {}),
    fetchedAt: now,
    updatedAt: now,
  };
  storage.upsertFundamental(row);

  return assembleFundamentalResult(symbol, market, row);
}

function assembleFundamentalResult(
  symbol: string,
  market: "TW" | "US",
  row: { infoJson: string; quarterlyIncomeJson: string; epsHistoryJson: string; calendarJson: string; fetchedAt: number }
): FundamentalResult {
  let info: any     = {};
  let quarters: any[] = [];
  let epsRows: any[]  = [];
  let calendar: any   = {};

  try { info     = JSON.parse(row.infoJson);            } catch { /* */ }
  try { quarters = JSON.parse(row.quarterlyIncomeJson); } catch { /* */ }
  try { epsRows  = JSON.parse(row.epsHistoryJson);      } catch { /* */ }
  try { calendar = JSON.parse(row.calendarJson);        } catch { /* */ }

  const industry = info.industry ?? "";
  const sector   = info.sector   ?? "";

  const growthPillar    = computeGrowthPillar(info, quarters, calendar);
  const qualityPillar   = computeQualityPillar(info, quarters);
  const valuationPillar = computeValuationPillar(info, industry, sector);
  const pillars = [growthPillar, qualityPillar, valuationPillar];

  return {
    symbol,
    market,
    name:     info.longName  ?? info.shortName ?? symbol,
    sector,
    industry,
    currency: info.currency  ?? (market === "TW" ? "TWD" : "USD"),
    pillars,
    quarterlyBars:   buildQuarterlyBars(quarters),
    epsHistory:      buildEpsHistory(epsRows),
    financialEvents: buildFinancialEvents(calendar),
    summaryRows:     buildSummaryRows(pillars, info, industry),
    trailingPE:      info.trailingPE      ?? undefined,
    forwardPE:       info.forwardPE       ?? undefined,
    pegRatio:        info.pegRatio        ?? undefined,
    grossMargins:    info.grossMargins    ?? undefined,
    operatingMargins:info.operatingMargins ?? undefined,
    profitMargins:   info.profitMargins   ?? undefined,
    fetchedAt: row.fetchedAt,
    isStale:   isExpired(row.fetchedAt, calendar),
  };
}

// ---------------------------------------------------------------------------
// Scheduled auto-refresh
// ---------------------------------------------------------------------------
// Runs daily before market open:
//   - TW stocks: 08:30 CST = UTC 00:30
//   - US stocks: 08:30 EST = UTC 13:30
// Uses setTimeout loop so no external scheduler dependency.

function msUntilNextUTC(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function runFundamentalAutoRefresh(market: "TW" | "US"): Promise<void> {
  let watchlist: { symbol: string; market: string }[] = [];
  try {
    watchlist = await storage.getWatchlist();
  } catch (e: any) {
    console.error("[autoRefresh] Failed to load watchlist:", e.message);
    return;
  }

  const targets = watchlist.filter((w) => w.market === market);
  console.log(`[autoRefresh] Starting ${market} refresh for ${targets.length} symbols`);

  for (const item of targets) {
    try {
      await getOrFetchFundamentals(item.symbol, market, true);
      console.log(`[autoRefresh] ${item.symbol} (${market}) refreshed`);
    } catch (e: any) {
      console.error(`[autoRefresh] ${item.symbol} (${market}) failed:`, e.message);
    }
    // Small delay between symbols to avoid rate limiting
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`[autoRefresh] ${market} refresh complete`);
}

function scheduleDailyRefresh(market: "TW" | "US", utcHour: number, utcMinute: number): void {
  const label = `${market} daily refresh (UTC ${String(utcHour).padStart(2,"0")}:${String(utcMinute).padStart(2,"0")})`;

  function scheduleNext() {
    const delay = msUntilNextUTC(utcHour, utcMinute);
    const fireAt = new Date(Date.now() + delay).toISOString();
    console.log(`[autoRefresh] ${label} scheduled at ${fireAt}`);
    setTimeout(async () => {
      await runFundamentalAutoRefresh(market);
      scheduleNext(); // reschedule for tomorrow
    }, delay);
  }

  scheduleNext();
}

/**
 * Call once at server startup to register daily auto-refresh jobs.
 *   - TW: 08:00 CST (1hr before 09:00 open) = UTC 00:00
 *   - US: 08:30 EST (1hr before 09:30 open) = UTC 13:30
 */
export function scheduleAutoRefresh(): void {
  scheduleDailyRefresh("TW", 0, 0);    // 08:00 CST (台股 09:00 開盤前1小時)
  scheduleDailyRefresh("US", 13, 30);  // 08:30 EST (美股 09:30 開盤前1小時)
}
