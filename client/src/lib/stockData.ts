// stockData.ts — Technical analysis calculations + shared types
// Actual price data is now fetched from /api/quotes and /api/history
// TW: TWSE, US: Perplexity Finance API (real-time), Yahoo Finance (history only)

// ---------------------------------------------------------------------------
// Types (mirrors server/stockService.ts for type safety on the client)
// ---------------------------------------------------------------------------

export interface StockQuote {
  symbol: string;
  yahooSymbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  market: "TW" | "US";
  currency: string;
  dataTimestamp: number;   // Unix seconds
  fetchedAt: number;       // Unix ms
  source: string;
  isStale: boolean;
}

export interface CandleData {
  time: string;  // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------------------------------------------------------------------
// Static watchlist metadata (used as fallback labels when API is loading)
// ---------------------------------------------------------------------------

export const STOCK_META: Record<string, { name: string; market: "TW" | "US" }> = {
  "2330":   { name: "台積電",          market: "TW" },
  "2308":   { name: "台達電",          market: "TW" },
  "3017":   { name: "奇鋐",            market: "TW" },
  "2395":   { name: "研華",            market: "TW" },
  "2313":   { name: "華通",            market: "TW" },
  "0050":   { name: "元大台灣50",      market: "TW" },
  "00719B": { name: "元大美債1-3",     market: "TW" },
  "00891":  { name: "中信關鍵半導體",  market: "TW" },
  "PANW":   { name: "Palo Alto Networks", market: "US" },
  "CRWD":   { name: "CrowdStrike",     market: "US" },
  "LMT":    { name: "Lockheed Martin", market: "US" },
  "VST":    { name: "Vistra",          market: "US" },
  "LITE":   { name: "Lumentum",        market: "US" },
  "RKLB":   { name: "Rocket Lab",      market: "US" },
  "OKLO":   { name: "Oklo",            market: "US" },
  "LLY":    { name: "Eli Lilly",       market: "US" },
};

export const TW_SYMBOLS = ["2330", "2308", "3017", "2395", "2313", "0050"];
export const US_SYMBOLS = ["PANW", "CRWD", "LMT", "VST", "LITE", "RKLB", "OKLO", "LLY"];
export const ALL_SYMBOLS = [...TW_SYMBOLS, ...US_SYMBOLS];

// ---------------------------------------------------------------------------
// Technical indicators — operate on real CandleData arrays
// ---------------------------------------------------------------------------

export function calculateRSI(data: CandleData[], period: number = 14): number[] {
  const rsi: number[] = [];
  const closes = data.map((d) => d.close);

  for (let i = 0; i < period; i++) rsi.push(50);

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 0.001)));

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 0.001)));
  }

  return rsi;
}

export function calculateMACD(data: CandleData[]): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const closes = data.map((d) => d.close);
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = calculateEMA(macd, 9);
  const histogram = macd.map((v, i) => v - signal[i]);
  return { macd, signal, histogram };
}

function calculateEMA(data: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);
  ema[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    ema[i] = (data[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }
  return ema;
}

export function calculateBollinger(
  data: CandleData[],
  period: number = 20
): {
  upper: number[];
  middle: number[];
  lower: number[];
} {
  const closes = data.map((d) => d.close);
  const middle: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      middle.push(closes[i]);
      upper.push(closes[i]);
      lower.push(closes[i]);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(
      slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period
    );
    middle.push(mean);
    upper.push(mean + 2 * std);
    lower.push(mean - 2 * std);
  }

  return { upper, middle, lower };
}

// ---------------------------------------------------------------------------
// ML simulation (operates on real historical data)
// ---------------------------------------------------------------------------

export function simulateRFPrediction(data: CandleData[]): {
  prediction: "up" | "down";
  confidence: number;
  featureImportance: { feature: string; importance: number }[];
  predictedRange: { low: number; high: number };
} {
  const recent = data.slice(-30);
  const closes = recent.map((d) => d.close);
  const lastClose = closes[closes.length - 1];

  const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const momentum = (sma5 - sma20) / sma20;

  const prediction = momentum > 0 ? "up" : "down";
  const confidence = Math.min(0.92, Math.max(0.55, 0.7 + Math.abs(momentum) * 10));

  const featureImportance = [
    { feature: "RSI (14日)",     importance: 0.22 },
    { feature: "MACD 訊號",      importance: 0.19 },
    { feature: "成交量變化",     importance: 0.16 },
    { feature: "布林通道位置",   importance: 0.14 },
    { feature: "5日均線斜率",    importance: 0.11 },
    { feature: "20日均線趨勢",   importance: 0.08 },
    { feature: "價格動量",       importance: 0.06 },
    { feature: "波動率",         importance: 0.04 },
  ];

  const volatility = lastClose * 0.05;
  const predictedRange = {
    low: +(lastClose - volatility).toFixed(2),
    high: +(lastClose + volatility).toFixed(2),
  };

  return { prediction, confidence, featureImportance, predictedRange };
}

// ---------------------------------------------------------------------------
// Data freshness helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable description of data age.
 * dataTimestamp: Unix seconds from server
 */
export function formatDataAge(dataTimestamp: number): string {
  const ageMs = Date.now() - dataTimestamp * 1000;
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 2) return "剛剛更新";
  if (ageMin < 60) return `${ageMin} 分鐘前`;
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return `${ageHr} 小時前`;
  const ageDays = Math.floor(ageHr / 24);
  return `${ageDays} 天前`;
}

/**
 * Formats a Unix-second timestamp to a local datetime string.
 */
export function formatTimestamp(unixSec: number, includeDate = false): string {
  const d = new Date(unixSec * 1000);
  if (includeDate) {
    return d.toLocaleString("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
