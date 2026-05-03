// server/personalAdviceService.ts
import { storage } from "./storage";
import type { AnalystConsensusFeatures } from "./analystConsensusService";

export interface PersonalPositionState {
  symbol: string;
  market: "TW" | "US";
  name: string;
  shares: number;
  avgCost: number;
  currentPrice: number | null;
  positionValue: number | null;
  positionPctOfPortfolio: number | null;  // null if total portfolio value unknown
  unrealizedPct: number | null;
  realizedGainTotal: number;
  avgHoldingDays: number | null;
}

export interface HorizonPredictionSummary {
  horizonDays: number;
  expectedReturnPct: number | null;
  downsideRiskPct: number | null;
  upsidePotentialPct: number | null;
  upProbability: number | null;
}

export type AdviceAction =
  | "hold"
  | "add_on_dip"
  | "take_profit_partial"
  | "cut_loss"
  | "avoid_new_entry";

export interface PersonalAdvice {
  symbol: string;
  market: string;
  primaryAction: AdviceAction;
  reasons: string[];
  positionState: PersonalPositionState | null;
}

export interface StrategyProfile {
  maxSinglePositionPct: number;   // default 20
  maxLossPctPerPosition: number;  // default 8
  horizonPreference: "short" | "swing" | "position"; // default "swing" → 20D
}

export const DEFAULT_STRATEGY: StrategyProfile = {
  maxSinglePositionPct: 20,
  maxLossPctPerPosition: 8,
  horizonPreference: "swing",
};

export async function buildPersonalPositionState(
  symbol: string,
  market: "TW" | "US",
  currentPrice: number | null,
): Promise<PersonalPositionState | null> {
  const transactions = await storage.getTransactionsBySymbol(symbol, market);

  if (!transactions || transactions.length === 0) {
    return null;
  }

  // Separate buys and sells
  const buys = transactions.filter((t: any) => t.type === "buy" || t.shares > 0);
  const sells = transactions.filter((t: any) => t.type === "sell" || t.shares < 0);

  const totalBuyShares = buys.reduce((sum: number, t: any) => sum + Math.abs(t.shares), 0);
  const totalSellShares = sells.reduce((sum: number, t: any) => sum + Math.abs(t.shares), 0);
  const netShares = totalBuyShares - totalSellShares;

  if (netShares <= 0) {
    return null;
  }

  // Average cost from buy transactions
  const totalBuyCost = buys.reduce((sum: number, t: any) => sum + Math.abs(t.totalCost ?? (t.price * Math.abs(t.shares))), 0);
  const avgCost = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;

  // Realized gain: sum of all totalCost (negative for buys, positive for sells)
  // Using simple proxy: SUM(totalCost) for all transactions
  const realizedGainTotal = transactions.reduce((sum: number, t: any) => {
    const cost = t.totalCost ?? 0;
    return sum + cost;
  }, 0);

  // Average holding days: average days between each buy tradeDate and today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let avgHoldingDays: number | null = null;
  if (buys.length > 0) {
    const totalDays = buys.reduce((sum: number, t: any) => {
      const tradeDate = t.tradeDate ? new Date(t.tradeDate) : null;
      if (!tradeDate) return sum;
      tradeDate.setHours(0, 0, 0, 0);
      const diffMs = today.getTime() - tradeDate.getTime();
      const diffDays = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
      return sum + diffDays;
    }, 0);
    avgHoldingDays = totalDays / buys.length;
  }

  // Position value and unrealized pct
  const positionValue = currentPrice != null ? netShares * currentPrice : null;
  const unrealizedPct =
    currentPrice != null && avgCost > 0
      ? ((currentPrice - avgCost) / avgCost) * 100
      : null;

  // Name: try to get from transactions or use symbol
  const name: string = (transactions[0] as any)?.name ?? symbol;

  return {
    symbol,
    market,
    name,
    shares: netShares,
    avgCost,
    currentPrice,
    positionValue,
    positionPctOfPortfolio: null,
    unrealizedPct,
    realizedGainTotal,
    avgHoldingDays,
  };
}

export function generatePersonalAdvice(
  symbol: string,
  market: string,
  currentPrice: number | null,
  predictions: HorizonPredictionSummary[],
  analystFeatures: AnalystConsensusFeatures,
  strategy: StrategyProfile = DEFAULT_STRATEGY,
  positionState?: PersonalPositionState | null,
): PersonalAdvice {
  // Map horizon preference to days
  const horizonMap: Record<StrategyProfile["horizonPreference"], number> = {
    short: 5,
    swing: 20,
    position: 60,
  };
  const targetHorizon = horizonMap[strategy.horizonPreference];

  // Find matching prediction
  const prediction = predictions.find((p) => p.horizonDays === targetHorizon) ?? null;
  const expectedReturnPct = prediction?.expectedReturnPct ?? null;

  const reasons: string[] = [];
  let primaryAction: AdviceAction = "hold";

  // Rule 1: Cut loss if unrealized pct is worse than stop-loss threshold
  if (
    positionState?.unrealizedPct != null &&
    positionState.unrealizedPct < -strategy.maxLossPctPerPosition
  ) {
    primaryAction = "cut_loss";
    reasons.push("持倉虧損超過停損線");
  }
  // Rule 2: Cut loss if expected return is worse than stop-loss threshold
  else if (
    expectedReturnPct != null &&
    expectedReturnPct < -strategy.maxLossPctPerPosition
  ) {
    primaryAction = "cut_loss";
    reasons.push("預測下跌風險超過停損線");
  }
  // Rule 3: Take partial profit on large unrealized gain with continued upside prediction
  else if (
    positionState?.unrealizedPct != null &&
    positionState.unrealizedPct > 20 &&
    expectedReturnPct != null &&
    expectedReturnPct > 10
  ) {
    primaryAction = "take_profit_partial";
    reasons.push("已有較大浮盈且預測仍上行");
  }
  // Rule 4: Avoid new entry if analyst consensus target is below current price
  else if (
    analystFeatures.hasConsensus &&
    analystFeatures.upsideAvgRatio != null &&
    analystFeatures.upsideAvgRatio < -0.05
  ) {
    primaryAction = "avoid_new_entry";
    reasons.push("分析師共識目標價低於現價");
  }
  // Rule 5: Add on dip if prediction is strong and no position (or zero shares)
  else if (
    expectedReturnPct != null &&
    expectedReturnPct > 8 &&
    (positionState == null || positionState.shares <= 0)
  ) {
    primaryAction = "add_on_dip";
    reasons.push("預測上行空間充裕，可考慮建倉");
  }
  // Default: hold
  else {
    primaryAction = "hold";
    reasons.push("目前無明確操作訊號");
  }

  // Always include at least 1 reason; pad up to 3 with supporting context
  if (reasons.length < 2 && analystFeatures.hasConsensus && analystFeatures.avgScore != null) {
    reasons.push(`分析師平均評分: ${analystFeatures.avgScore.toFixed(1)}`);
  }

  if (reasons.length < 3 && prediction != null && prediction.upProbability != null) {
    const upPct = (prediction.upProbability * 100).toFixed(0);
    reasons.push(`${targetHorizon}日上漲概率: ${upPct}%`);
  }

  return {
    symbol,
    market,
    primaryAction,
    reasons,
    positionState: positionState ?? null,
  };
}


