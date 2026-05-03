// server/analystConsensusService.ts
import { storage } from "./storage";

export interface AnalystConsensusFeatures {
  hasConsensus: boolean;
  avgTargetPrice: number | null;
  highTargetPrice: number | null;
  lowTargetPrice: number | null;
  upsideAvgRatio: number | null;    // (avg - current) / current
  upsideHighRatio: number | null;
  downsideLowRatio: number | null;
  bandWidth: number | null;         // (high - low) / current
  sampleCount: number;
  bullishRatio: number | null;
  neutralRatio: number | null;
  bearishRatio: number | null;
  avgScore: number | null;
  lastTargetChangePct: number | null;  // (targetPrice - previousTargetPrice) / previousTargetPrice for most recent row
  daysSinceLastUpdate: number | null;  // calendar days since most recent analystDate
}

export async function buildAnalystConsensusFeatures(
  symbol: string,
  market: string,
  currentPrice: number,
): Promise<AnalystConsensusFeatures> {
  const targets = await storage.getLatestAnalystConsensusBySymbol(symbol, market);

  if (!targets || targets.length === 0) {
    return {
      hasConsensus: false,
      avgTargetPrice: null,
      highTargetPrice: null,
      lowTargetPrice: null,
      upsideAvgRatio: null,
      upsideHighRatio: null,
      downsideLowRatio: null,
      bandWidth: null,
      sampleCount: 0,
      bullishRatio: null,
      neutralRatio: null,
      bearishRatio: null,
      avgScore: null,
      lastTargetChangePct: null,
      daysSinceLastUpdate: null,
    };
  }

  const sampleCount = targets.length;

  // Price aggregates
  const prices = targets.map((t) => t.targetPrice);
  const avgTargetPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const highTargetPrice = Math.max(...prices);
  const lowTargetPrice = Math.min(...prices);

  // Safe division helpers
  const safeDivide = (numerator: number, denominator: number): number | null => {
    if (denominator <= 0) return null;
    return numerator / denominator;
  };

  const upsideAvgRatio = currentPrice > 0 ? safeDivide(avgTargetPrice - currentPrice, currentPrice) : null;
  const upsideHighRatio = currentPrice > 0 ? safeDivide(highTargetPrice - currentPrice, currentPrice) : null;
  const downsideLowRatio = currentPrice > 0 ? safeDivide(lowTargetPrice - currentPrice, currentPrice) : null;
  const bandWidth = currentPrice > 0 ? safeDivide(highTargetPrice - lowTargetPrice, currentPrice) : null;

  // Rating category ratios
  const bullishCount = targets.filter((t) => t.ratingCategory === "bullish").length;
  const neutralCount = targets.filter((t) => t.ratingCategory === "neutral").length;
  const bearishCount = targets.filter((t) => t.ratingCategory === "bearish").length;

  const bullishRatio = sampleCount > 0 ? bullishCount / sampleCount : null;
  const neutralRatio = sampleCount > 0 ? neutralCount / sampleCount : null;
  const bearishRatio = sampleCount > 0 ? bearishCount / sampleCount : null;

  // Average score
  const avgScore = sampleCount > 0
    ? targets.reduce((sum, t) => sum + t.score, 0) / sampleCount
    : null;

  // Sort by analystDate descending to get most recent
  const sorted = [...targets].sort((a, b) => {
    if (a.analystDate > b.analystDate) return -1;
    if (a.analystDate < b.analystDate) return 1;
    return 0;
  });

  const mostRecent = sorted[0];

  // Last target change pct
  let lastTargetChangePct: number | null = null;
  if (
    mostRecent.previousTargetPrice != null &&
    mostRecent.previousTargetPrice > 0
  ) {
    lastTargetChangePct =
      (mostRecent.targetPrice - mostRecent.previousTargetPrice) /
      mostRecent.previousTargetPrice;
  }

  // Days since last update
  let daysSinceLastUpdate: number | null = null;
  if (mostRecent.analystDate) {
    const lastDate = new Date(mostRecent.analystDate);
    const today = new Date();
    // Zero out time component for calendar-day diff
    today.setHours(0, 0, 0, 0);
    lastDate.setHours(0, 0, 0, 0);
    const diffMs = today.getTime() - lastDate.getTime();
    daysSinceLastUpdate = Math.round(diffMs / (1000 * 60 * 60 * 24));
  }

  return {
    hasConsensus: true,
    avgTargetPrice,
    highTargetPrice,
    lowTargetPrice,
    upsideAvgRatio,
    upsideHighRatio,
    downsideLowRatio,
    bandWidth,
    sampleCount,
    bullishRatio,
    neutralRatio,
    bearishRatio,
    avgScore,
    lastTargetChangePct,
    daysSinceLastUpdate,
  };
}
