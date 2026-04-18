/**
 * marketIndicatorRules.ts
 *
 * Deterministic signal evaluation for each market indicator.
 * No LLM calls — all rules are hardcoded thresholds.
 */

export type SignalLevel = "strong_bull" | "bull" | "neutral" | "bear" | "strong_bear";

export interface IndicatorSignal {
  key: string;
  label: string;
  signal: SignalLevel;
  signalText: string;
}

/** ─── Individual signal evaluators ──────────────────────────────────────── */

export function taiexSignal(change: number): SignalLevel {
  if (change >= 1.5) return "strong_bull";
  if (change >= 0.3) return "bull";
  if (change > -0.3) return "neutral";
  if (change > -1.5) return "bear";
  return "strong_bear";
}

/**
 * Combined signal: considers both price change AND trade volume
 * Rules:
 *  漲 + 量大 → 強勢偏多
 *  漲 + 量小 → 偏多（追價力道普通）
 *  跌 + 量大 → 強勢偏空
 *  跌 + 量小 → 偏空
 *  平盤 + 量低 → 震盪整理(neutral)
 */
export function taiexCombinedSignal(changePct: number, volumeBillion: number | null): SignalLevel {
  const volumeStrong = volumeBillion !== null && volumeBillion >= 4000;
  const volumeWeak   = volumeBillion !== null && volumeBillion < 2000;

  if (changePct >= 1.5) return volumeStrong ? "strong_bull" : "bull";
  if (changePct >= 0.3) return volumeStrong ? "strong_bull" : volumeWeak ? "neutral" : "bull";
  if (changePct > -0.3) return volumeWeak ? "neutral" : "neutral";
  if (changePct > -1.5) return volumeStrong ? "strong_bear" : "bear";
  return "strong_bear";
}

/** 成交值 (億): normal range 2000-4000 */
export function twseVolumeSignal(billionTWD: number): SignalLevel {
  if (billionTWD >= 5000) return "strong_bull";
  if (billionTWD >= 3000) return "bull";
  if (billionTWD >= 1500) return "neutral";
  if (billionTWD >= 800) return "bear";
  return "strong_bear";
}

/** 外資買賣超 (億 TWD) */
export function foreignNetSignal(billionTWD: number): SignalLevel {
  if (billionTWD >= 100) return "strong_bull";
  if (billionTWD >= 20) return "bull";
  if (billionTWD > -20) return "neutral";
  if (billionTWD > -100) return "bear";
  return "strong_bear";
}

/** 漲跌比 = advances / (advances + declines) */
export function advDeclineSignal(advances: number, declines: number): SignalLevel {
  const total = advances + declines;
  if (total === 0) return "neutral";
  const ratio = advances / total;
  if (ratio >= 0.70) return "strong_bull";
  if (ratio >= 0.55) return "bull";
  if (ratio >= 0.45) return "neutral";
  if (ratio >= 0.30) return "bear";
  return "strong_bear";
}

/** 融資餘額增減 (億 TWD, daily change) */
export function marginSignal(dailyChange: number): SignalLevel {
  if (dailyChange >= 30) return "strong_bull";
  if (dailyChange >= 5) return "bull";
  if (dailyChange > -5) return "neutral";
  if (dailyChange > -30) return "bear";
  return "strong_bear";
}

/** USD/TWD — higher = TWD weaker (bearish for TW market) */
export function usdtwdSignal(rate: number, prevRate: number): SignalLevel {
  const change = rate - prevRate;
  if (change <= -0.3) return "strong_bull";  // TWD strengthening
  if (change <= -0.05) return "bull";
  if (change < 0.05) return "neutral";
  if (change < 0.3) return "bear";
  return "strong_bear";
}

/** S&P500 / DJIA / Nasdaq / SOX — daily % change */
export function usIndexSignal(changePct: number): SignalLevel {
  if (changePct >= 1.5) return "strong_bull";
  if (changePct >= 0.3) return "bull";
  if (changePct > -0.3) return "neutral";
  if (changePct > -1.5) return "bear";
  return "strong_bear";
}

/** VIX */
export function vixSignal(vix: number): SignalLevel {
  if (vix < 15) return "strong_bull";
  if (vix < 20) return "bull";
  if (vix < 25) return "neutral";
  if (vix < 35) return "bear";
  return "strong_bear";
}

/** Fear & Greed 0–100 */
export function fearGreedSignal(score: number): SignalLevel {
  if (score >= 75) return "strong_bull";
  if (score >= 55) return "bull";
  if (score >= 45) return "neutral";
  if (score >= 25) return "bear";
  return "strong_bear";
}

/** US 10Y yield */
export function us10YSignal(yld: number): SignalLevel {
  if (yld < 3.5) return "strong_bull";
  if (yld < 4.2) return "bull";
  if (yld < 4.8) return "neutral";
  if (yld < 5.2) return "bear";
  return "strong_bear";
}

/** US CPI YoY % */
export function usCpiSignal(cpiYoY: number): SignalLevel {
  if (cpiYoY < 2.0) return "strong_bull";
  if (cpiYoY < 3.0) return "bull";
  if (cpiYoY < 4.0) return "neutral";
  if (cpiYoY < 5.5) return "bear";
  return "strong_bear";
}

/** ─── Signal → human text ───────────────────────────────────────────────── */

const SIGNAL_TEXT: Record<SignalLevel, string> = {
  strong_bull: "強勢偏多",
  bull: "偏多",
  neutral: "中性",
  bear: "偏空",
  strong_bear: "強勢偏空",
};

export function signalText(s: SignalLevel): string {
  return SIGNAL_TEXT[s];
}

/** ─── Summary generator ─────────────────────────────────────────────────── */

export interface MarketSummary {
  tw: string;
  us: string;
}

const BULL_SCORES: Record<SignalLevel, number> = {
  strong_bull: 2,
  bull: 1,
  neutral: 0,
  bear: -1,
  strong_bear: -2,
};

export function generateSummary(
  twSignals: SignalLevel[],
  usSignals: SignalLevel[],
): MarketSummary {
  const twScore = twSignals.reduce((s, sig) => s + BULL_SCORES[sig], 0);
  const usScore = usSignals.reduce((s, sig) => s + BULL_SCORES[sig], 0);

  const twAvg = twScore / twSignals.length;
  const usAvg = usScore / usSignals.length;

  const twSummary = twAvg >= 1.0
    ? "台股多頭信號明確，成交量與外資買盤支撐。"
    : twAvg >= 0.3
    ? "台股偏多，惟部分指標需觀察。"
    : twAvg >= -0.3
    ? "台股走勢中性，觀望氣氛濃厚。"
    : twAvg >= -1.0
    ? "台股偏弱，外資動向與成交量需持續關注。"
    : "台股空頭壓力增加，建議謹慎操作。";

  const usSummary = usAvg >= 1.0
    ? "美股多頭動能強，風險情緒良好。"
    : usAvg >= 0.3
    ? "美股偏多，但波動性指標仍需留意。"
    : usAvg >= -0.3
    ? "美股走勢中性，等待明確方向。"
    : usAvg >= -1.0
    ? "美股承壓，VIX 與債市走勢值得關注。"
    : "美股空頭風險上升，防禦性配置為宜。";

  return { tw: twSummary, us: usSummary };
}
