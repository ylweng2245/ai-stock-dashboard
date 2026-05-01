/**
 * Shared type definitions for fundamental analysis.
 * These mirror the server-side types in server/fundamentalService.ts.
 */

export type FundamentalRating = "excellent" | "good" | "neutral" | "weak" | "poor";

export interface MetricItem {
  name: string;
  value: string;
  numericValue?: number;
  rating: FundamentalRating;
  commentary: string;
}

export interface PillarCard {
  pillar: "growth" | "quality" | "valuation";
  title: string;
  score: number;
  summary: string;
  metrics: MetricItem[];
}

export interface QuarterlyBar {
  quarter: string;
  revenue: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
}

export interface EpsPoint {
  quarter: string;
  actual: number;
  estimate: number;
  surprise: number;
}

export interface FinancialEvent {
  date: string;
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
  trailingPE?: number;
  forwardPE?: number;
  pegRatio?: number;
  grossMargins?: number;
  operatingMargins?: number;
  profitMargins?: number;
  fetchedAt: number;
  isStale: boolean;
}
