import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  TrendingUp,
  BarChart3,
  DollarSign,
  Activity,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Plus,
  X,
  Settings2,
  GripVertical,
} from "lucide-react";
import { type StockQuote, TW_SYMBOLS, US_SYMBOLS, formatDataAge } from "@/lib/stockData";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { WatchlistItem } from "@shared/schema";

interface QuotesResponse {
  quotes: StockQuote[];
  indices: StockQuote[];
  fetchedAt: number;
  errors: string[];
  dataSource: string;
  dataSourceUrl: string;
}

// ─── Market Overview types (matching server payload) ─────────────────────────

type SignalLevel = "strong_bull" | "bull" | "neutral" | "bear" | "strong_bear";

interface IndicatorCard {
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
  history?: Array<{ date: string; value: number }>;
  referenceValue?: number | null;  // e.g. 1-year average for baseline
  stale: boolean;
}

interface MarketOverviewPayload {
  tw: IndicatorCard[];
  us: IndicatorCard[];
  summary: { tw: string; us: string };
  updatedAt: string;
}

interface IntradayResult {
  symbol: string;
  prevClose: number;
  currentPrice: number;
  points: Array<{ ts: number; price: number }>;
  marketStatus: "open" | "closed" | "pre" | "post";
}

// ─── Signal badge ─────────────────────────────────────────────────────────────

const SIGNAL_COLORS: Record<SignalLevel, string> = {
  strong_bull: "bg-red-500/15 text-red-400 border-red-500/30",
  bull: "bg-red-400/10 text-red-400 border-red-400/25",
  neutral: "bg-muted/40 text-muted-foreground border-border",
  bear: "bg-emerald-400/10 text-emerald-400 border-emerald-400/25",
  strong_bear: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

function SignalBadge({ signal, text }: { signal: SignalLevel | null; text: string | null }) {
  if (!signal || !text) return null;
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium tabular-nums", SIGNAL_COLORS[signal])}>
      {text}
    </span>
  );
}

// ─── Classic Sparkline (for non-intraday cards) ───────────────────────────────

function Sparkline({ data, signal }: { data: number[]; signal: SignalLevel | null }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 64, h = 24, pts = data.length;
  const coords = data.map((v, i) => {
    const x = (i / (pts - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke =
    signal === "strong_bull" || signal === "bull" ? "#f87171"
    : signal === "strong_bear" || signal === "bear" ? "#34d399"
    : "#6b7280";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 opacity-70">
      <polyline points={coords.join(" ")} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Intraday Chart ───────────────────────────────────────────────────────────

function IntradayChart({ indicatorKey, prevClose, height = 56 }: {
  indicatorKey: string;
  prevClose?: number;
  height?: number;
}) {
  const { data, isLoading } = useQuery<IntradayResult>({
    queryKey: ["/api/intraday", indicatorKey],
    queryFn: () => apiRequest("GET", `/api/intraday/${indicatorKey}`).then(r => r.json()),
    refetchInterval: 2 * 60 * 1000,
    staleTime: 90 * 1000,
    retry: 1,
  });

  if (isLoading) {
    return <div style={{ height }} className="w-full bg-muted/20 rounded animate-pulse" />;
  }
  if (!data || data.points.length < 2) {
    return <div style={{ height }} className="w-full flex items-center justify-center">
      <span className="text-[9px] text-muted-foreground/50">分時圖載入中</span>
    </div>;
  }

  const baseline = prevClose ?? data.prevClose;
  const points = data.points;
  const prices = points.map(p => p.price);
  const allValues = baseline > 0 ? [...prices, baseline] : prices;
  const minV = Math.min(...allValues);
  const maxV = Math.max(...allValues);
  const range = maxV - minV || 1;
  const w = 200, h = height;
  const pad = 2;

  const toX = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const toY = (v: number) => h - pad - ((v - minV) / range) * (h - pad * 2);

  // Build path split by above/below baseline
  // We'll use two overlapping paths with clip regions
  const pathD = points.map((p, i) =>
    `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.price).toFixed(1)}`
  ).join(" ");

  // Baseline Y
  const baseY = baseline > 0 ? toY(baseline) : -1;

  // Last price color
  const lastPrice = prices[prices.length - 1];
  const lineColor = !baseline || lastPrice >= baseline ? "#f87171" : "#34d399";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      className="block"
    >
      {/* Baseline dashed line */}
      {baseline > 0 && baseY >= 0 && baseY <= h && (
        <line
          x1={pad} y1={baseY.toFixed(1)}
          x2={w - pad} y2={baseY.toFixed(1)}
          stroke="#6b7280"
          strokeWidth="0.8"
          strokeDasharray="3,2"
          opacity="0.6"
        />
      )}
      {/* Price line */}
      <path
        d={pathD}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Bar Chart (for 外資/融資 3-month history) ───────────────────────────────
// SVG-based dark-background bi-directional bar chart with gridlines and zero baseline

function BarChart({ history }: {
  history: Array<{ date: string; value: number }>;
}) {
  if (!history || history.length < 2) return null;

  const last60 = history.slice(-60);
  const values = last60.map(h => h.value);
  const maxAbs = Math.max(...values.map(Math.abs), 1);

  // SVG dimensions
  const W = 300;
  const H = 72;
  const PADL = 32; // left padding for Y-axis labels
  const PADR = 4;
  const PADT = 6;
  const PADB = 18; // bottom padding for X-axis labels
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;

  const n = last60.length;
  const barW = Math.max(1, Math.floor((chartW / n) * 0.65));
  const barGap = chartW / n;

  // Y position mapping: 0 line is at vertical midpoint
  const zeroY = PADT + chartH / 2;
  const halfH = chartH / 2 - 1;

  // Gridline Y values: ±1/2 of maxAbs
  const gridLevels = [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs];

  // Y-axis label formatter
  const fmtY = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 100) return `${(v / 100).toFixed(0)}百`;
    return `${v.toFixed(0)}`;
  };

  // X-axis tick positions: show ~5 evenly spaced date labels
  const xTickIdxs: number[] = [];
  const step = Math.max(1, Math.floor(n / 5));
  for (let i = 0; i < n; i += step) xTickIdxs.push(i);
  if (xTickIdxs[xTickIdxs.length - 1] !== n - 1) xTickIdxs.push(n - 1);

  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="none"
        style={{ display: "block", borderRadius: 6, background: "#0f1117" }}
        role="img"
        aria-label="近3個月直方圖"
      >
        {/* Horizontal gridlines */}
        {gridLevels.map((lv, gi) => {
          const y = zeroY - (lv / maxAbs) * halfH;
          const isZero = lv === 0;
          return (
            <g key={gi}>
              <line
                x1={PADL} y1={y} x2={W - PADR} y2={y}
                stroke={isZero ? "#6b7280" : "#1f2937"}
                strokeWidth={isZero ? 1 : 0.5}
                strokeDasharray={isZero ? "none" : "2,3"}
              />
              {/* Y-axis label */}
              <text
                x={PADL - 3} y={y + 3}
                textAnchor="end"
                fontSize={6.5}
                fill="#4b5563"
                fontFamily="monospace"
              >
                {fmtY(lv)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {last60.map((h, i) => {
          const cx = PADL + i * barGap + barGap / 2;
          const x = cx - barW / 2;
          const isPos = h.value >= 0;
          const pct = Math.abs(h.value) / maxAbs;
          const barH2 = Math.max(1, pct * halfH);
          const color = isPos ? "#e05252" : "#34d399"; // slightly desaturated red vs green
          const y = isPos ? zeroY - barH2 : zeroY;
          return (
            <rect
              key={h.date ?? i}
              x={x}
              y={y}
              width={barW}
              height={barH2}
              fill={color}
              opacity={0.85}
              rx={0.5}
            >
              <title>{`${h.date}: ${isPos ? "" : "-"}${Math.abs(h.value).toFixed(0)}億`}</title>
            </rect>
          );
        })}

        {/* X-axis date labels */}
        {xTickIdxs.map((idx) => {
          const cx = PADL + idx * barGap + barGap / 2;
          const label = last60[idx]?.date?.slice(5) ?? "";
          return (
            <text
              key={idx}
              x={cx}
              y={H - 3}
              textAnchor="middle"
              fontSize={6}
              fill="#4b5563"
              fontFamily="monospace"
            >
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}


// ─── Bar Chart Compact (for wide cards — no axis labels, max space for bars) ──

function BarChartCompact({ history }: {
  history: Array<{ date: string; value: number }>;
}) {
  if (!history || history.length < 2) return null;

  // 取最近 30 個交易日
  const last30 = history.slice(-30);
  const values = last30.map(h => h.value);
  const maxAbs = Math.max(...values.map(Math.abs), 1);

  const W = 400;
  const H = 128;
  const PAD = 4;
  const chartW = W - PAD * 2;
  const chartH = H - PAD * 2;

  const n = last30.length;
  const barGap = chartW / n;
  const barW = Math.max(2, barGap * 0.72);

  const zeroY = PAD + chartH / 2;
  const halfH = chartH / 2 - 1;

  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="none"
        style={{ display: "block", borderRadius: 6, background: "#0f1117" }}
        role="img"
        aria-label="近30個交易日每日直方圖"
      >
        {/* Zero baseline */}
        <line
          x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY}
          stroke="#6b7280" strokeWidth={0.8}
        />
        {/* Subtle grid at ±50% */}
        {[-0.5, 0.5].map((frac, gi) => {
          const y = zeroY - frac * halfH;
          return (
            <line key={gi}
              x1={PAD} y1={y} x2={W - PAD} y2={y}
              stroke="#1f2937" strokeWidth={0.5} strokeDasharray="2,3"
            />
          );
        })}
        {/* Bars */}
        {last30.map((h, i) => {
          const cx = PAD + i * barGap + barGap / 2;
          const x = cx - barW / 2;
          const isPos = h.value >= 0;
          const pct = Math.abs(h.value) / maxAbs;
          const bh = Math.max(1.5, pct * halfH);
          const color = isPos ? "#e05252" : "#34d399";
          const y = isPos ? zeroY - bh : zeroY;
          return (
            <rect key={h.date ?? i} x={x} y={y} width={barW} height={bh}
              fill={color} opacity={0.9} rx={0.8}>
              <title>{`${h.date}: ${isPos ? "" : "-"}${Math.abs(h.value).toFixed(0)}億`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

// ─── USD/TWD Line Chart (3-month daily + 1y average baseline) ─────────────────

// ─── VIX Chart — 三色區間折線 + 15/25 虛線基準 ─────────────────────
function VixChart({ history, compact = false, fill = false }: {
  history: Array<{ date: string; value: number }>;
  compact?: boolean;
  fill?: boolean;
}) {
  if (!history || history.length < 2) return null;
  const pts = history.slice(-65);
  const values = pts.map(p => p.value);
  const minV = Math.min(...values, 10) - 1;
  const maxV = Math.max(...values, 35) + 1;
  const range = maxV - minV;

  const W = compact ? 96 : 400;
  const H = compact ? 28 : 80;
  const PAD_L = 2, PAD_R = compact ? 14 : 18, PAD_T = compact ? 3 : 5, PAD_B = compact ? 3 : 4;
  const cW = W - PAD_L - PAD_R;
  const cH = H - PAD_T - PAD_B;
  const n = pts.length;

  const toX = (i: number) => PAD_L + (i / (n - 1)) * cW;
  const toY = (v: number) => PAD_T + (1 - (v - minV) / range) * cH;

  // 四色區間基準線：15=綠 / 20=黃 / 25=橘 / 30=紅
  const y15 = toY(15); const y20 = toY(20); const y25 = toY(25); const y30 = toY(30);
  const yBot = H - PAD_B;

  // 建立整條 path，用 clipPath 切出四個區間
  const fullPath = pts.map((p, i) =>
    `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.value).toFixed(1)}`
  ).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={compact
        ? { width: W, height: H, display: "block", flexShrink: 0, opacity: 0.85 }
        : fill
        ? { width: "100%", height: "100%", display: "block", borderRadius: 6 }
        : { width: "100%", height: H, display: "block", background: "#0b1018", borderRadius: 6 }}
    >
      <defs>
        {/* Zone clips: <15 green, 15-20 yellow, 20-25 orange, >25 red */}
        <clipPath id="vix-clip-green">
          <rect x={0} y={y15} width={W} height={Math.max(0, yBot - y15 + PAD_B)} />
        </clipPath>
        <clipPath id="vix-clip-yellow">
          <rect x={0} y={y20} width={W} height={Math.max(0, y15 - y20 + 1)} />
        </clipPath>
        <clipPath id="vix-clip-orange">
          <rect x={0} y={y25} width={W} height={Math.max(0, y20 - y25 + 1)} />
        </clipPath>
        <clipPath id="vix-clip-red">
          <rect x={0} y={PAD_T - 2} width={W} height={Math.max(0, y25 - PAD_T + 2)} />
        </clipPath>
      </defs>

      {/* 區間背景底色 */}
      <rect x={0} y={y15} width={W} height={Math.max(0, yBot - y15)} fill="#34d399" opacity={0.05} />
      <rect x={0} y={y20} width={W} height={Math.max(0, y15 - y20)} fill="#f6d365" opacity={0.05} />
      <rect x={0} y={y25} width={W} height={Math.max(0, y20 - y25)} fill="#fb923c" opacity={0.06} />
      <rect x={0} y={PAD_T} width={W} height={Math.max(0, y25 - PAD_T)} fill="#f87171" opacity={0.07} />

      {/* 15 虛線 — 綠 */}
      <line x1={0} y1={y15.toFixed(1)} x2={W} y2={y15.toFixed(1)}
        stroke="#67e8a5" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.8} />
      {!compact && <text x={W - PAD_R - 1} y={(y15 - 2).toFixed(1)}
        fontSize={7} fill="#67e8a5" textAnchor="end" opacity={0.85}>15</text>}

      {/* 20 虛線 — 黃 */}
      <line x1={0} y1={y20.toFixed(1)} x2={W} y2={y20.toFixed(1)}
        stroke="#f6d365" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.8} />
      {!compact && <text x={W - PAD_R - 1} y={(y20 - 2).toFixed(1)}
        fontSize={7} fill="#f6d365" textAnchor="end" opacity={0.85}>20</text>}

      {/* 25 虛線 — 橘 */}
      <line x1={0} y1={y25.toFixed(1)} x2={W} y2={y25.toFixed(1)}
        stroke="#fb923c" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.8} />
      {!compact && <text x={W - PAD_R - 1} y={(y25 - 2).toFixed(1)}
        fontSize={7} fill="#fb923c" textAnchor="end" opacity={0.85}>25</text>}

      {/* 30 虛線 — 紅 */}
      <line x1={0} y1={y30.toFixed(1)} x2={W} y2={y30.toFixed(1)}
        stroke="#f87171" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.85} />
      {!compact && <text x={W - PAD_R - 1} y={(y30 - 2).toFixed(1)}
        fontSize={7} fill="#f87171" textAnchor="end" opacity={0.9}>30</text>}

      {/* 四色線條 */}
      <path d={fullPath} fill="none" stroke="#67e8a5" strokeWidth={1.6} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round"
        clipPath="url(#vix-clip-green)" />
      <path d={fullPath} fill="none" stroke="#f6d365" strokeWidth={1.6} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round"
        clipPath="url(#vix-clip-yellow)" />
      <path d={fullPath} fill="none" stroke="#fb923c" strokeWidth={1.6} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round"
        clipPath="url(#vix-clip-orange)" />
      <path d={fullPath} fill="none" stroke="#f87171" strokeWidth={1.6} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round"
        clipPath="url(#vix-clip-red)" />
    </svg>
  );
}

function USDTWDChart({ history, referenceValue }: {
  history: Array<{ date: string; value: number }>;
  referenceValue?: number | null;
}) {
  if (!history || history.length < 2) return null;

  const W = 300, H = 150;
  const PADL = 2, PADR = 2, PADT = 4, PADB = 4;
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;

  const values = history.map(h => h.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 0.01;

  const toX = (i: number) => PADL + (i / (history.length - 1)) * chartW;
  const toY = (v: number) => PADT + chartH - ((v - minV) / range) * chartH;

  // Polyline path
  const pts = history.map((h, i) => `${toX(i).toFixed(1)},${toY(h.value).toFixed(1)}`).join(" ");

  // Colour: last value vs first
  const lineColor = history[history.length - 1].value >= history[0].value ? "#e05252" : "#34d399";

  // Reference line Y (1y average)
  const refY = referenceValue != null && referenceValue >= minV && referenceValue <= maxV
    ? toY(referenceValue)
    : null;

  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none"
        style={{ display: "block", borderRadius: 4, background: "#0f1117" }}
        role="img" aria-label="近3個月匯率走勢">
        {/* Year average baseline */}
        {refY !== null && (
          <line x1={PADL} y1={refY} x2={W - PADR} y2={refY}
            stroke="#6b7280" strokeWidth={0.8} strokeDasharray="3,3" />
        )}
        {/* Price line */}
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.5} strokeLinejoin="round" />
        {/* Last point dot */}
        <circle cx={toX(history.length - 1)} cy={toY(history[history.length - 1].value)} r={2} fill={lineColor} />
      </svg>
    </div>
  );
}

// ─── RegimeChart — Fear & Greed 60日 5區間 ────────────────────────────────────

function RegimeChart({ history }: {
  history: Array<{ date: string; value: number }>;
}) {
  if (!history || history.length < 2) return null;

  const pts = history.slice(-60);
  const W = 400, H = 80;
  const PAD_L = 2, PAD_R = 20, PAD_T = 5, PAD_B = 4;
  const cW = W - PAD_L - PAD_R;
  const cH = H - PAD_T - PAD_B;
  const n = pts.length;

  const toX = (i: number) => PAD_L + (i / (n - 1)) * cW;
  const toY = (v: number) => PAD_T + (1 - v / 100) * cH;

  // Zone boundaries
  const y24 = toY(24); const y44 = toY(44); const y55 = toY(55); const y74 = toY(74);

  // Zone bands (SVG Y axis is inverted: top = high value = Extreme Greed, bottom = low value = Extreme Fear)
  // Taiwan convention: Fear=red, Greed=green
  const ZONES = [
    { yTop: PAD_T,     yBot: y74,       fill: "#22c55e" },  // 75-100 Extreme Greed — deep green
    { yTop: y74,       yBot: y55,       fill: "#86efac" },  // 45-74  Greed — light green
    { yTop: y55,       yBot: y44,       fill: "#4b5563" },  // 45-55  Neutral — gray
    { yTop: y44,       yBot: y24,       fill: "#fca5a5" },  // 25-44  Fear — light red
    { yTop: y24,       yBot: H - PAD_B, fill: "#ef4444" },  // 0-24   Extreme Fear — deep red
  ];

  const fullPath = pts.map((p, i) =>
    `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.value).toFixed(1)}`
  ).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block", borderRadius: 6 }}
    >
      {/* Zone background bands */}
      {ZONES.map((z, i) => (
        <rect key={i} x={0} y={z.yTop} width={W} height={Math.max(0, z.yBot - z.yTop)}
          fill={z.fill} opacity={0.08} />
      ))}

      {/* Boundary lines: 24=deep-red, 45=light-red, 55=light-green, 75=deep-green */}
      {([{ v: 25, clr: "#ef4444" }, { v: 45, clr: "#fca5a5" }, { v: 55, clr: "#86efac" }, { v: 75, clr: "#22c55e" }]).map(({ v, clr }) => {
        const y = toY(v);
        return (
          <g key={v}>
            <line x1={0} y1={y.toFixed(1)} x2={W - PAD_R + 2} y2={y.toFixed(1)}
              stroke={clr} strokeWidth={0.6} strokeDasharray="3,3" opacity={0.6} />
            <text x={W - PAD_R + 3} y={(y + 3).toFixed(1)}
              fontSize={6.5} fill={clr} opacity={0.8}>{v}</text>
          </g>
        );
      })}

      {/* Coloured line segments — clipPath by Y pixel range (Y inverted: top=high value) */}
      {/* Taiwan: Fear=red, Greed=green */}
      <defs>
        {/* 75-100 Extreme Greed: Y from PAD_T to y74 */}
        <clipPath id="fg-clip-xgreed"><rect x={0} y={PAD_T} width={W} height={Math.max(0, y74 - PAD_T)} /></clipPath>
        {/* 55-74 Greed: Y from y74 to y55 */}
        <clipPath id="fg-clip-greed"><rect x={0} y={y74} width={W} height={Math.max(0, y55 - y74)} /></clipPath>
        {/* 45-55 Neutral: Y from y55 to y44 */}
        <clipPath id="fg-clip-neutral"><rect x={0} y={y55} width={W} height={Math.max(0, y44 - y55)} /></clipPath>
        {/* 25-44 Fear: Y from y44 to y24 */}
        <clipPath id="fg-clip-fear"><rect x={0} y={y44} width={W} height={Math.max(0, y24 - y44)} /></clipPath>
        {/* 0-24 Extreme Fear: Y from y24 to bottom */}
        <clipPath id="fg-clip-xfear"><rect x={0} y={y24} width={W} height={Math.max(0, H - PAD_B - y24)} /></clipPath>
      </defs>
      <path d={fullPath} fill="none" stroke="#22c55e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" clipPath="url(#fg-clip-xgreed)" />
      <path d={fullPath} fill="none" stroke="#86efac" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" clipPath="url(#fg-clip-greed)" />
      <path d={fullPath} fill="none" stroke="#9ca3af" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" clipPath="url(#fg-clip-neutral)" />
      <path d={fullPath} fill="none" stroke="#fca5a5" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" clipPath="url(#fg-clip-fear)" />
      <path d={fullPath} fill="none" stroke="#ef4444" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" clipPath="url(#fg-clip-xfear)" />
    </svg>
  );
}

// ─── US10Y Line Chart — daily + 3M avg dashed line ───────────────────────────

function US10YChart({ history, referenceValue }: {
  history: Array<{ date: string; value: number }>;
  referenceValue?: number | null;
}) {
  if (!history || history.length < 2) return null;

  const W = 300, H = 60;
  const PADL = 2, PADR = 2, PADT = 4, PADB = 4;
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;

  const values = history.map(h => h.value).filter(v => v > 0);
  if (values.length < 2) return null;
  const allForRange = referenceValue ? [...values, referenceValue] : values;
  const minV = Math.min(...allForRange) * 0.995;
  const maxV = Math.max(...allForRange) * 1.005;
  const range = maxV - minV || 0.01;

  const toX = (i: number) => PADL + (i / (history.length - 1)) * chartW;
  const toY = (v: number) => PADT + chartH - ((v - minV) / range) * chartH;

  const pts = history
    .filter(h => h.value > 0)
    .map((h, i) => `${toX(i).toFixed(1)},${toY(h.value).toFixed(1)}`)
    .join(" ");

  // Color based on trend (last vs first)
  const firstVal = values[0];
  const lastVal = values[values.length - 1];
  // Rising yields = bad for bonds/stocks → text-loss (green) for color
  const lineColor = lastVal >= firstVal ? "#f87171" : "#34d399";

  // Reference line (3M avg)
  const refY = referenceValue != null && referenceValue >= minV && referenceValue <= maxV
    ? toY(referenceValue)
    : null;

  return (
    <div style={{ width: "100%", height: "100%", minWidth: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none"
        style={{ display: "block", borderRadius: 4 }}
        role="img" aria-label="近3個月美債殖利走勢">
        {/* 3M avg baseline */}
        {refY !== null && (
          <line x1={PADL} y1={refY} x2={W - PADR} y2={refY}
            stroke="#94a3b8" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.55} />
        )}
        {/* Yield line */}
        <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {/* Last point dot */}
        <circle cx={toX(history.filter(h => h.value > 0).length - 1)}
          cy={toY(lastVal)} r={1.5} fill={lineColor} />
      </svg>
    </div>
  );
}

// ─── CPI Bar Chart — monthly, 24 months, Fed 2% target line ──────────────────

function CPIChart({ history }: {
  history: Array<{ date: string; value: number }>;
}) {
  if (!history || history.length < 2) return null;

  const last24 = history.slice(-24);
  const values = last24.map(h => h.value);
  const FED_TARGET = 2.0;
  const maxV = Math.max(...values, FED_TARGET, 0) * 1.08;
  const minV = Math.min(...values, 0) * 1.08;

  const W = 300, H = 70;
  const PADL = 2, PADR = 2, PADT = 5, PADB = 12;
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;

  const n = last24.length;
  const barGap = chartW / n;
  const barW = Math.max(2, barGap * 0.72);

  // Y scale: 0 baseline
  const range = maxV - minV || 1;
  const toY = (v: number) => PADT + chartH - ((v - minV) / range) * chartH;
  const zeroY = toY(0);
  const fedY = toY(FED_TARGET);

  // X-axis: show ~5 date labels (month/year)
  const xTickIdxs: number[] = [];
  const step = Math.max(1, Math.floor(n / 5));
  for (let i = 0; i < n; i += step) xTickIdxs.push(i);
  if (xTickIdxs[xTickIdxs.length - 1] !== n - 1) xTickIdxs.push(n - 1);

  const fmtDateLabel = (d: string) => {
    const parts = d.split("-");
    if (parts.length < 2) return d.slice(0, 7);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const m = parseInt(parts[1], 10) - 1;
    return `${months[m]}'${parts[0].slice(2)}`;
  };

  return (
    <div style={{ width: "100%", height: "100%", minWidth: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none"
        style={{ display: "block", borderRadius: 4 }}
        role="img" aria-label="CPI 24個月YoY%">
        {/* Zero line */}
        <line x1={PADL} y1={zeroY} x2={W - PADR} y2={zeroY}
          stroke="#4b5563" strokeWidth={0.5} />

        {/* Fed 2% target line */}
        <line x1={PADL} y1={fedY} x2={W - PADR} y2={fedY}
          stroke="#60a5fa" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.78} />
        <text x={W - PADR - 2} y={(fedY - 2).toFixed(1)}
          fontSize={6.5} fill="#93c5fd" textAnchor="end" opacity={0.85}>Fed 2.0%</text>

        {/* Bars */}
        {last24.map((h, i) => {
          const cx = PADL + i * barGap + barGap / 2;
          const x = cx - barW / 2;
          const isAboveFed = h.value > FED_TARGET;
          const isPos = h.value >= 0;
          const barTop = isPos ? toY(h.value) : zeroY;
          const barBot = isPos ? zeroY : toY(h.value);
          const bh = Math.max(1, barBot - barTop);
          // Color: above 2% target = red/warning, below = neutral green
          const color = isAboveFed ? "#f87171" : "#34d399";
          return (
            <rect key={h.date ?? i} x={x} y={barTop} width={barW} height={bh}
              fill={color} opacity={0.85} rx={0.5}>
              <title>{`${h.date?.slice(0, 7)}: ${h.value.toFixed(1)}%`}</title>
            </rect>
          );
        })}

        {/* X-axis labels */}
        {xTickIdxs.map((idx) => {
          const cx = PADL + idx * barGap + barGap / 2;
          return (
            <text key={idx} x={cx} y={H - 1}
              textAnchor="middle" fontSize={5.5} fill="#4b5563" fontFamily="monospace">
              {fmtDateLabel(last24[idx]?.date ?? "")}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Indicator Card (Market Overview) ────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtChange(v: number | null | undefined, decimals = 2, pct = false): string {
  if (v === null || v === undefined) return "";
  const str = Math.abs(v).toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${v < 0 ? "-" : ""}${str}${pct ? "%" : ""}`;
}

/** Map indicator key / stock symbol → Perplexity Finance URL */
const FINANCE_URL_MAP: Record<string, string> = {
  djia:      "https://www.perplexity.ai/finance/%5EDJI",
  sp500:     "https://www.perplexity.ai/finance/%5EGSPC",
  nasdaq:    "https://www.perplexity.ai/finance/%5EIXIC",
  sox:       "https://www.perplexity.ai/finance/%5ESOX",
  vix:       "https://www.perplexity.ai/finance/%5EVIX",
  us_10y:    "https://www.perplexity.ai/finance/%5ETNX",
  taiex:     "https://www.perplexity.ai/finance/%5ETWII",
  usdtwd:    "https://www.perplexity.ai/finance/USDTWD%3DX",
  fear_greed: "", // no Finance page
};

function getFinanceUrl(keyOrSymbol: string, market?: string): string {
  if (FINANCE_URL_MAP[keyOrSymbol] !== undefined) return FINANCE_URL_MAP[keyOrSymbol];
  // Individual stock
  return `https://www.perplexity.ai/finance/${encodeURIComponent(keyOrSymbol)}`;
}

function OverviewCard({ card, isLoading }: { card: IndicatorCard; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="bg-card border border-border rounded-lg p-3 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  }

  const isGain = (v: number | null | undefined) => v !== null && v !== undefined && v > 0;
  const isLoss = (v: number | null | undefined) => v !== null && v !== undefined && v < 0;

  // ─── TAIEX + breadth bar (漲跌家數併入) ──────────────────────────
  if (card.key === "taiex") {
    // Look up adv/dec from sibling tw_adv_dec card via meta embedded in extra fields
    // We receive adv/dec via card.extra if available, otherwise 0
    const advDec = (card as any)._advDec as { adv: number; dec: number; limitUp: number; limitDown: number } | undefined;
    const adv = advDec?.adv ?? 0;
    const dec = advDec?.dec ?? 0;
    const total = adv + dec || 1;
    const advPct = adv / total;
    const hasAdvDec = adv > 0 || dec > 0;

    return (
      <div className="bg-card border border-border rounded-lg p-3 h-full flex flex-col" data-testid={`overview-card-${card.key}`}>
        {/* Top row: left = main info, right = breadth */}
        <div className="flex gap-4">
          {/* Left: main data */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
              {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
            </div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xl font-bold tabular-nums">{fmt(card.value, 0)}</span>
              {card.changePct !== null && card.changePct !== undefined && (
                <span className={cn("text-sm tabular-nums font-semibold", isGain(card.changePct) ? "text-gain" : isLoss(card.changePct) ? "text-loss" : "text-muted-foreground")}>
                  {fmtChange(card.changePct, 2, true)}
                </span>
              )}
            </div>
            {card.value2 !== null && card.value2 !== undefined && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
                成交值 <span className="font-medium text-foreground">{fmt(card.value2, 0)}</span> 億
              </div>
            )}
          </div>
          {/* Right: breadth bar */}
          {hasAdvDec && (
            <div className="w-32 shrink-0 flex flex-col justify-center gap-1">
              <div className="flex justify-between items-baseline">
                <span className="text-xs font-bold tabular-nums text-gain">{fmt(adv, 0)}</span>
                <span className="text-xs font-bold tabular-nums text-loss">{fmt(dec, 0)}</span>
              </div>
              {/* Breadth bar: red (adv) | green (dec) */}
              <div className="h-2.5 w-full rounded-full overflow-hidden flex" title={`上漲 ${adv} / 下跌 ${dec}`}>
                <div className="h-full bg-red-400" style={{ width: `${(advPct * 100).toFixed(1)}%` }} />
                <div className="h-full bg-emerald-500 flex-1" />
              </div>
              <div className="flex justify-between">
                <span className="text-[9px] text-muted-foreground">上漲</span>
                <span className="text-[9px] text-muted-foreground">下跌</span>
              </div>
            </div>
          )}
        </div>
        {/* Intraday chart — flex-1 to fill remaining height */}
        <div className="mt-3 flex-1 flex flex-col justify-end">
          <IntradayChart indicatorKey="taiex" height={48} />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
      </div>
    );
  }

  // ─── 漲跌家數 — REMOVED (merged into taiex card) ──────────────────
  if (card.key === "tw_adv_dec") {
    return null; // hidden — data is passed to taiex card via twOrdered lookup
  }

  // ─── 漲跌家數 (雙列 + 水平長條圖) ──────────────────────────────────
  if (card.key === "tw_adv_dec") {
    const adv = card.value ?? 0;
    const dec = card.value2 ?? 0;
    const total = adv + dec || 1;
    let limitUp = 0, limitDown = 0;
    if (card.meta) {
      try { const m = JSON.parse(card.meta); limitUp = m.limitUp ?? 0; limitDown = m.limitDown ?? 0; } catch { /* */ }
    }
    const advPct = adv / total;
    const decPct = dec / total;
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
               {/* Two-section layout: label row + value row, then bar */}
        <div className="space-y-2">
          {/* 上漲區塊 */}
          <div className="flex items-center gap-3">
            {/* Left: two-line label/value */}
            <div className="w-24 shrink-0 space-y-0.5">
              <div className="text-[10px] text-muted-foreground leading-none">
                漲停&nbsp;<span className="text-gain font-semibold">{limitUp}</span>
                <span className="mx-1 opacity-30">/</span>上漲
              </div>
              <div className="text-sm font-bold tabular-nums text-gain leading-tight">
                {fmt(card.value, 0)}
              </div>
            </div>
            {/* Right: red progress bar */}
            <div className="flex-1 h-2 bg-muted/30 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-red-400" style={{ width: `${(advPct * 100).toFixed(1)}%` }} />
            </div>
          </div>

          {/* 下跌區塊 */}
          <div className="flex items-center gap-3">
            <div className="w-24 shrink-0 space-y-0.5">
              <div className="text-[10px] text-muted-foreground leading-none">
                跌停&nbsp;<span className="text-loss font-semibold">{limitDown}</span>
                <span className="mx-1 opacity-30">/</span>下跌
              </div>
              <div className="text-sm font-bold tabular-nums text-loss leading-tight">
                {fmt(card.value2, 0)}
              </div>
            </div>
            <div className="flex-1 h-2 bg-muted/30 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${(decPct * 100).toFixed(1)}%` }} />
            </div>
          </div>
        </div>
        <div className="mt-2">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
      </div>
    );
  }

  // ─── 外資買賣超 — 寬型橫向卡（左1/3文字 + 右2/3圖） ──────────────
  if (card.key === "tw_foreign_net") {
    const v = card.value;
    const colorClass = isGain(v) ? "text-gain" : isLoss(v) ? "text-loss" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3 h-full" data-testid={`overview-card-${card.key}`}>
        <div className="flex gap-3 items-stretch h-full">
          {/* Left ~1/3: label + value + signal */}
          <div className="flex flex-col justify-between" style={{ width: "32%", minWidth: 100 }}>
            <div>
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
                {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
              </div>
              <div className="flex items-baseline gap-1 flex-wrap">
                <span className={cn("text-base font-bold tabular-nums", colorClass)}>
                  {fmtChange(v, 0)}
                </span>
                <span className="text-[11px] text-muted-foreground">億</span>
              </div>
            </div>
            <SignalBadge signal={card.signal} text={card.signalText} />
          </div>
          {/* Right ~2/3: compact bar chart */}
          <div className="flex-1 min-w-0 flex items-center">
            {card.history && card.history.length > 2
              ? <BarChartCompact history={card.history} />
              : <div className="w-full h-16 rounded-md bg-muted/20 flex items-center justify-center"><span className="text-[10px] text-muted-foreground">資料載入中</span></div>
            }
          </div>
        </div>
      </div>
    );
  }

  // ─── 融資增減 — 寬型橫向卡（左1/3文字 + 右2/3圖） v4.6 ──────────
  if (card.key === "tw_margin") {
    // v4.6: value = 每日融資增減 (primary), value2 = 融資餘額 (secondary)
    const chg = card.value;   // primary: daily change
    const bal = card.value2;  // secondary: balance
    const colorClass = isGain(chg) ? "text-gain" : isLoss(chg) ? "text-loss" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3 h-full" data-testid={`overview-card-${card.key}`}>
        <div className="flex gap-3 items-stretch h-full">
          {/* Left ~1/3: label + value + signal */}
          <div className="flex flex-col justify-between" style={{ width: "32%", minWidth: 100 }}>
            <div>
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
                {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
              </div>
              {/* Primary: daily change */}
              <div className="flex items-baseline gap-1">
                <span className={cn("text-base font-bold tabular-nums", colorClass)}>
                  {fmtChange(chg, 0)}
                </span>
                <span className="text-[11px] text-muted-foreground">億</span>
              </div>
              {/* Secondary: balance */}
              {bal !== null && bal !== undefined && (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  餘額 <span className="text-foreground/70 tabular-nums">{fmt(bal, 0)}</span> 億
                </div>
              )}
            </div>
            <SignalBadge signal={card.signal} text={card.signalText} />
          </div>
          {/* Right ~2/3: compact bar chart */}
          <div className="flex-1 min-w-0 flex items-center">
            {card.history && card.history.length > 2
              ? <BarChartCompact history={card.history} />
              : <div className="w-full h-16 rounded-md bg-muted/20 flex items-center justify-center"><span className="text-[10px] text-muted-foreground">資料載入中</span></div>
            }
          </div>
        </div>
      </div>
    );
  }

  // ─── USD/TWD — line chart + year average baseline (v4.6) ─────────
  if (card.key === "usdtwd") {
    const chg = card.change;
    // USD/TWD: 台幣升值(chg<0) = good = gain colour; 貶值(chg>0) = bad = loss colour
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3 flex flex-col" data-testid={`overview-card-${card.key}`}>
        {/* Top: label + stale */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        {/* Middle: value + change + signal */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 3)}</span>
          {chg !== null && chg !== undefined && chg !== 0 && (
            <span className={cn("text-xs tabular-nums font-medium", colorClass)}>{fmtChange(chg, 3)}</span>
          )}
        </div>
        {card.referenceValue != null && (
          <div className="text-[9px] text-muted-foreground mt-0.5">
            年均 <span className="tabular-nums">{fmt(card.referenceValue, 3)}</span>
          </div>
        )}
        <div className="mt-1">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
        {/* Bottom: 3-month line chart */}
        {card.history && card.history.length > 2 ? (
          <div className="mt-2 flex-1 flex flex-col justify-end">
            <USDTWDChart history={card.history} referenceValue={card.referenceValue} />
          </div>
        ) : (
          <div className="mt-2 flex-1 flex items-center justify-center">
            <Sparkline data={card.sparkline} signal={card.signal} />
          </div>
        )}
      </div>
    );
  }

  // ─── US Major Indices — Intraday Chart ─────────────────────────────
  if (["djia", "sp500", "nasdaq", "sox"].includes(card.key)) {
    const chgPct = card.changePct;
    const colorClass = isGain(chgPct) ? "text-gain" : isLoss(chgPct) ? "text-loss" : "text-muted-foreground";
    const financeUrl = getFinanceUrl(card.key);
    return (
      <a
        href={financeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block bg-card border border-border rounded-lg p-3 hover:border-[#66c6df]/40 transition-colors"
        data-testid={`overview-card-${card.key}`}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base font-bold tabular-nums">{fmt(card.value, 0)}</span>
          {chgPct !== null && chgPct !== undefined && (
            <span className={cn("text-sm tabular-nums font-semibold", colorClass)}>
              {fmtChange(chgPct, 2, true)}
            </span>
          )}
        </div>
        {/* Intraday chart —放大 */}
        <div className="mt-2">
          <IntradayChart indicatorKey={card.key} height={52} />
        </div>
        <div className="mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
      </a>
    );
  }

  // ─── VIX (macro card) ──────────────────────────────────────────────
  if (card.key === "vix") {
    const chg = card.change;
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    return (
      <div className="border border-border rounded-[18px] p-[18px] pb-4 flex flex-col"
        style={{ minHeight: 224, background: "linear-gradient(180deg, rgba(7,11,18,.96), rgba(8,11,17,.98))" }}
        data-testid={`overview-card-${card.key}`}>
        {/* TOP info area */}
        <div className="flex flex-col gap-2" style={{ minHeight: 79 }}>
          {/* Title row + range tag */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold" style={{ color: "#cdd6e4", letterSpacing: ".01em" }}>{card.label}</span>
              {card.stale && <AlertCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
            </div>
            <span className="shrink-0 inline-flex items-center justify-center px-2 h-6 rounded-full border text-xs font-semibold"
              style={{ borderColor: "rgba(148,163,184,.14)", background: "rgba(255,255,255,.02)", color: "#9aa6b6", whiteSpace: "nowrap" }}>3個月</span>
          </div>
          {/* Main value + delta */}
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span className="font-bold tabular-nums leading-none" style={{ fontSize: 30, letterSpacing: "-0.03em", color: "#eef2f8" }}>
              {card.value !== null && card.value !== undefined ? card.value.toFixed(2) : "—"}
            </span>
            {chg !== null && chg !== undefined && chg !== 0 && (
              <span className={cn("text-base font-semibold tabular-nums", colorClass)}>{fmtChange(chg, 2)}</span>
            )}
          </div>
          {/* Badge */}
          <div className="mt-auto"><SignalBadge signal={card.signal} text={card.signalText} /></div>
        </div>
        {/* BOTTOM chart area */}
        <div className="flex-1 rounded-xl overflow-hidden mt-3.5 border"
          style={{ minHeight: 122, background: "linear-gradient(180deg, rgba(11,16,24,.94), rgba(10,14,22,.98))", borderColor: "rgba(148,163,184,.06)" }}>
          {card.history && card.history.length >= 2
            ? <VixChart history={card.history} fill />
            : <Sparkline data={card.sparkline} signal={card.signal} />}
        </div>
      </div>
    );
  }

  // ─── Fear & Greed (macro card) ─────────────────────────────────────────────
  if (card.key === "fear_greed") {
    const rawMeta = card.meta ?? "";
    const zoneLabelMap: Record<string, string> = {
      "extreme fear": "極度恐懼", "fear": "恐懼", "neutral": "中性",
      "greed": "貪婪", "extreme greed": "極度貪婪",
    };
    // Taiwan convention: Fear=red, Greed=green
    const zoneColorMap: Record<string, string> = {
      "extreme fear": "#ef4444",  // deep red
      "fear":         "#fca5a5",  // light red
      "neutral":      "#9ca3af",  // gray
      "greed":        "#86efac",  // light green
      "extreme greed":"#22c55e",  // deep green
    };
    const zoneLabel = zoneLabelMap[rawMeta.toLowerCase()] ?? rawMeta;
    const zoneColor = zoneColorMap[rawMeta.toLowerCase()] ?? "#9ca3af";
    const hasHistory = card.history && card.history.length >= 2;
    return (
      <div className="border border-border rounded-[18px] p-[18px] pb-4 flex flex-col"
        style={{ minHeight: 224, background: "linear-gradient(180deg, rgba(7,11,18,.96), rgba(8,11,17,.98))" }}
        data-testid={`overview-card-${card.key}`}>
        {/* TOP info area */}
        <div className="flex flex-col gap-2" style={{ minHeight: 79 }}>
          {/* Title row + range tag */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold" style={{ color: "#cdd6e4", letterSpacing: ".01em" }}>{card.label}</span>
              {card.stale && <AlertCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
            </div>
            <span className="shrink-0 inline-flex items-center justify-center px-2 h-6 rounded-full border text-xs font-semibold"
              style={{ borderColor: "rgba(148,163,184,.14)", background: "rgba(255,255,255,.02)", color: "#9aa6b6", whiteSpace: "nowrap" }}>3個月</span>
          </div>
          {/* Main value (white) + zone label (colored) */}
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span className="font-bold tabular-nums leading-none" style={{ fontSize: 30, letterSpacing: "-0.03em", color: "#eef2f8" }}>
              {card.value !== null && card.value !== undefined ? Math.round(card.value) : "—"}
            </span>
            {zoneLabel && (
              <span className="text-base font-semibold" style={{ color: zoneColor }}>{zoneLabel}</span>
            )}
          </div>
          {/* Badge */}
          <div className="mt-auto"><SignalBadge signal={card.signal} text={card.signalText} /></div>
        </div>
        {/* BOTTOM chart area */}
        <div className="flex-1 rounded-xl overflow-hidden mt-3.5 border"
          style={{ minHeight: 122, background: "linear-gradient(180deg, rgba(11,16,24,.94), rgba(10,14,22,.98))", borderColor: "rgba(148,163,184,.06)" }}>
          {hasHistory
            ? <RegimeChart history={card.history!} />
            : <div className="w-full h-full flex items-center justify-center">
                <span className="text-xs text-muted-foreground/50">資料載入中</span>
              </div>
          }
        </div>
      </div>
    );
  }

  // ─── US 10Y (macro card) ─────────────────────────────────────────────────
  if (card.key === "us_10y") {
    const chg = card.change;
    // Rising yield = bearish → text-loss (green) for up, text-gain (red) for down
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    const hasHistory = card.history && card.history.length >= 2;
    return (
      <div className="border border-border rounded-[18px] p-[18px] pb-4 flex flex-col"
        style={{ minHeight: 224, background: "linear-gradient(180deg, rgba(7,11,18,.96), rgba(8,11,17,.98))" }}
        data-testid={`overview-card-${card.key}`}>
        {/* TOP info area */}
        <div className="flex flex-col gap-2" style={{ minHeight: 79 }}>
          {/* Title row + range tag */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold" style={{ color: "#cdd6e4", letterSpacing: ".01em" }}>{card.label}</span>
              {card.stale && <AlertCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
            </div>
            <span className="shrink-0 inline-flex items-center justify-center px-2 h-6 rounded-full border text-xs font-semibold"
              style={{ borderColor: "rgba(148,163,184,.14)", background: "rgba(255,255,255,.02)", color: "#9aa6b6", whiteSpace: "nowrap" }}>3個月</span>
          </div>
          {/* Main value + delta */}
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span className="font-bold tabular-nums leading-none" style={{ fontSize: 30, letterSpacing: "-0.03em", color: "#eef2f8" }}>
              {card.value !== null && card.value !== undefined ? `${card.value.toFixed(2)}%` : "—"}
            </span>
            {chg !== null && chg !== undefined && chg !== 0 && (
              <span className={cn("text-base font-semibold tabular-nums", colorClass)}>{fmtChange(chg, 3, false)} pp</span>
            )}
          </div>
          {/* 3M avg meta */}
          {card.referenceValue != null && (
            <div className="text-[13px]" style={{ color: "#8d97a8" }}>
              3M 均 <span className="tabular-nums">{card.referenceValue.toFixed(2)}%</span>
            </div>
          )}
          {/* Badge */}
          <div className="mt-auto"><SignalBadge signal={card.signal} text={card.signalText} /></div>
        </div>
        {/* BOTTOM chart area */}
        <div className="flex-1 rounded-xl overflow-hidden mt-3.5 border"
          style={{ minHeight: 122, background: "linear-gradient(180deg, rgba(11,16,24,.94), rgba(10,14,22,.98))", borderColor: "rgba(148,163,184,.06)" }}>
          {hasHistory
            ? <US10YChart history={card.history!} referenceValue={card.referenceValue} />
            : <Sparkline data={card.sparkline} signal={card.signal} />
          }
        </div>
      </div>
    );
  }

  // ─── US CPI (macro card) ─────────────────────────────────────────────────
  if (card.key === "us_cpi") {
    const chg = card.change;
    // Rising CPI = bearish → text-loss (green) for up, text-gain (red) for down
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    const isUnavailable = card.value === null || card.value === undefined;
    const hasHistory = card.history && card.history.length >= 2;
    return (
      <div className="border border-border rounded-[18px] p-[18px] pb-4 flex flex-col"
        style={{ minHeight: 224, background: "linear-gradient(180deg, rgba(7,11,18,.96), rgba(8,11,17,.98))" }}
        data-testid={`overview-card-${card.key}`}>
        {/* TOP info area */}
        <div className="flex flex-col gap-2" style={{ minHeight: 79 }}>
          {/* Title row + range tag */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold" style={{ color: "#cdd6e4", letterSpacing: ".01em" }}>{card.label}</span>
              {card.stale && <AlertCircle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
            </div>
            <span className="shrink-0 inline-flex items-center justify-center px-2 h-6 rounded-full border text-xs font-semibold"
              style={{ borderColor: "rgba(148,163,184,.14)", background: "rgba(255,255,255,.02)", color: "#9aa6b6", whiteSpace: "nowrap" }}>2年</span>
          </div>
          {/* Main value + delta (or unavailable state) */}
          {isUnavailable ? (
            <div className="flex items-baseline gap-2.5">
              <span className="font-bold tabular-nums leading-none" style={{ fontSize: 30, letterSpacing: "-0.03em", color: "#4b5563" }}>—</span>
            </div>
          ) : (
            <div className="flex items-baseline gap-2.5 flex-wrap">
              <span className="font-bold tabular-nums leading-none" style={{ fontSize: 30, letterSpacing: "-0.03em", color: "#eef2f8" }}>
                {`${card.value!.toFixed(1)}%`}
              </span>
              {chg !== null && chg !== undefined && chg !== 0 && (
                <span className={cn("text-base font-semibold tabular-nums", colorClass)}>{fmtChange(chg, 1, false)} pp</span>
              )}
            </div>
          )}
          {/* Date (formatted as "Mar 2026") — CPI keeps date */}
          {card.date && (
            <div className="text-[13px]" style={{ color: "#8d97a8" }}>{card.date}</div>
          )}
          {/* Badge */}
          <div className="mt-auto"><SignalBadge signal={card.signal} text={card.signalText} /></div>
        </div>
        {/* BOTTOM chart area */}
        <div className="flex-1 rounded-xl overflow-hidden mt-3.5 border"
          style={{ minHeight: 122, background: "linear-gradient(180deg, rgba(11,16,24,.94), rgba(10,14,22,.98))", borderColor: "rgba(148,163,184,.06)" }}>
          {hasHistory
            ? <CPIChart history={card.history!} />
            : <div className="w-full h-full flex items-center justify-center">
                <span className="text-xs text-muted-foreground/50">等待月度資料</span>
              </div>
          }
        </div>
      </div>
    );
  }

  // ─── fallback ────────────────────────────────────────────────────────
  return (
    <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
      <div className="text-[11px] text-muted-foreground mb-1">{card.label}</div>
      <div className="text-base font-semibold tabular-nums">{fmt(card.value)}</div>
      <div className="mt-1"><SignalBadge signal={card.signal} text={card.signalText} /></div>
    </div>
  );
}

// ─── Market Overview Section ──────────────────────────────────────────────────

function MarketOverviewSection() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<MarketOverviewPayload>({
    queryKey: ["/api/market-overview"],
    queryFn: () => apiRequest("GET", "/api/market-overview").then((r) => r.json()),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev: MarketOverviewPayload | undefined) => prev,
  });

  // TW order (fixed): taiex, tw_adv_dec, tw_foreign_net, tw_margin, usdtwd
  const twOrdered = data?.tw ?? [];
  const us = data?.us ?? [];

  const updatedTime = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="space-y-3" data-testid="market-overview-section">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">市場指標</h2>
          {updatedTime && <span className="text-[10px] text-muted-foreground tabular-nums">更新 {updatedTime}</span>}
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="p-1.5 rounded hover:bg-muted/40 transition-colors disabled:opacity-50"
          title="刷新市場指標" data-testid="btn-refresh-market-overview">
          <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", isFetching && "animate-spin")} />
        </button>
      </div>

      {isError && (
        <div className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />市場指標載入失敗，顯示最後緩存數據。
        </div>
      )}

      {/* TW Section — desktop single-row: [taiex 2/5] [foreign+margin 2/5] [usdtwd 1/5] */}
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground tracking-widest mb-2 uppercase">台灣市場</div>
        {isLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr", gap: 8 }}>
            {[1, 2, 3].map((_, i) => (
              <div key={i} className="bg-card border border-border rounded-lg p-3 space-y-1.5">
                <Skeleton className="h-3 w-16" /><Skeleton className="h-6 w-20" /><Skeleton className="h-16 w-full" />
              </div>
            ))}
          </div>
        ) : (() => {
          // Build card map and inject _advDec into taiex
          const advDecCard = twOrdered.find(c => c.key === "tw_adv_dec");
          let advDecData: { adv: number; dec: number; limitUp: number; limitDown: number } | undefined;
          if (advDecCard) {
            let limitUp = 0, limitDown = 0;
            if (advDecCard.meta) {
              try { const m = JSON.parse(advDecCard.meta); limitUp = m.limitUp ?? 0; limitDown = m.limitDown ?? 0; } catch { /* */ }
            }
            advDecData = { adv: advDecCard.value ?? 0, dec: advDecCard.value2 ?? 0, limitUp, limitDown };
          }
          const taiexCard = twOrdered.find(c => c.key === "taiex");
          const usdtwdCard = twOrdered.find(c => c.key === "usdtwd");
          const foreignCard = twOrdered.find(c => c.key === "tw_foreign_net");
          const marginCard = twOrdered.find(c => c.key === "tw_margin");
          const taiexWithAdv = taiexCard ? { ...taiexCard, _advDec: advDecData } : null;

          return (
            /* Desktop-first: 2fr 2fr 1fr single row. On small screens stacks to 1 column */
            <div style={{ display: "grid", gap: 8 }}
              className="tw-market-grid tw-market-grid--stretch">
              {/* Col 1 (2/5): taiex main card */}
              {taiexWithAdv && (
                <div className="flex flex-col h-full">
                  <OverviewCard card={taiexWithAdv as any} isLoading={false} />
                </div>
              )}

              {/* Col 2 (2/5): foreign + margin stacked, equal height */}
              <div className="flex flex-col gap-2 h-full" style={{ minWidth: 0 }}>
                {foreignCard && (
                  <div className="flex-1 flex flex-col min-h-0">
                    <OverviewCard card={foreignCard} isLoading={false} />
                  </div>
                )}
                {marginCard && (
                  <div className="flex-1 flex flex-col min-h-0">
                    <OverviewCard card={marginCard} isLoading={false} />
                  </div>
                )}
              </div>

              {/* Col 3 (1/5): usdtwd */}
              {usdtwdCard && <OverviewCard card={usdtwdCard} isLoading={false} />}
            </div>
          );
        })()}
      </div>

      {/* US Section — Row 1: DJIA/SP500/Nasdaq/SOX (intraday), Row 2: VIX/FG/10Y/CPI */}
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground tracking-widest mb-2 uppercase">美國市場</div>
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-card border border-border rounded-lg p-3 space-y-1.5">
                    <Skeleton className="h-3 w-16" /><Skeleton className="h-6 w-20" /><Skeleton className="h-12 w-full" />
                  </div>
                ))
              : us.slice(0, 4).map((card) => (
                  <OverviewCard key={card.key} card={card} isLoading={false} />
                ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-card border border-border rounded-lg p-3 space-y-1.5">
                    <Skeleton className="h-3 w-16" /><Skeleton className="h-5 w-20" /><Skeleton className="h-3 w-12" />
                  </div>
                ))
              : us.slice(4).map((card) => (
                  <OverviewCard key={card.key} card={card} isLoading={false} />
                ))}
          </div>
        </div>
      </div>

      {/* Summary */}
      {data?.summary && (
        <div className="grid sm:grid-cols-2 gap-2">
          <div className="bg-muted/20 border border-border/50 rounded-lg px-3 py-2" data-testid="summary-tw">
            <span className="text-[10px] font-semibold text-muted-foreground mr-2">台股</span>
            <span className="text-[11px]">{data.summary.tw}</span>
          </div>
          <div className="bg-muted/20 border border-border/50 rounded-lg px-3 py-2" data-testid="summary-us">
            <span className="text-[10px] font-semibold text-muted-foreground mr-2">美股</span>
            <span className="text-[11px]">{data.summary.us}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Existing dashboard helpers (KPICard, StockRow, WatchlistEditor…) ─────────

function KPICard({
  title,
  value,
  change,
  icon: Icon,
  isLoading,
  isStale,
  dataAge,
}: {
  title: string;
  value: string;
  change: number;
  icon: any;
  isLoading?: boolean;
  isStale?: boolean;
  dataAge?: string;
}) {
  const isPositive = change >= 0;
  return (
    <Card className="border-border" data-testid={`kpi-${title}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground font-medium">{title}</span>
          <Icon className="w-4 h-4 text-muted-foreground" />
        </div>
        {isLoading ? (
          <div className="space-y-1.5">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold tabular-nums">{value}</span>
              <span className={cn("text-xs font-medium tabular-nums", isPositive ? "text-gain" : "text-loss")}>
                {change.toFixed(2)}%
              </span>
              {isStale && (
                <AlertCircle className="w-3 h-3 text-muted-foreground/60 shrink-0" aria-label="數據稍舊" />
              )}
            </div>
            {dataAge && (
              <div className="text-[10px] text-muted-foreground mt-0.5">{dataAge}</div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StockRow({ stock, onRemove }: { stock: StockQuote; onRemove?: () => void }) {
  const isPositive = stock.changePercent >= 0;
  const financeUrl = getFinanceUrl(stock.symbol, stock.market);
  return (
    <div
      className="flex items-center justify-between py-2.5 px-3 rounded-md hover:bg-muted/30 transition-colors group"
      data-testid={`stock-row-${stock.symbol}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          <span className="text-[10px] font-semibold text-primary">{stock.market}</span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <a href={financeUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium truncate hover:text-[#66c6df] hover:underline transition-colors" onClick={(e) => e.stopPropagation()}>{stock.symbol}</a>
            {stock.quoteStatus === "error" && (
              <AlertCircle
                className="w-3 h-3 text-amber-400 shrink-0"
                aria-label="資料獲取失敗（顯示緩存值）"
              />
            )}
            {!stock.quoteStatus && stock.isStale && (
              <AlertCircle
                className="w-3 h-3 text-muted-foreground/50 shrink-0"
                aria-label="前一日收盤價"
              />
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">{stock.name}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-right shrink-0">
          <div className="text-sm font-medium tabular-nums">
            {stock.market === "TW" ? "NT" : "$"}{stock.price.toLocaleString()}
          </div>
          <div className={cn("text-xs tabular-nums font-medium", isPositive ? "text-gain" : "text-loss")}>
            {stock.changePercent.toFixed(2)}%
          </div>
        </div>
        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/20 transition-all"
            title="從自選移除"
            data-testid={`btn-remove-${stock.symbol}`}
          >
            <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
          </button>
        )}
      </div>
    </div>
  );
}

function StockRowSkeleton() {
  return (
    <div className="flex items-center justify-between py-2.5 px-3">
      <div className="flex items-center gap-3">
        <Skeleton className="w-9 h-9 rounded-md" />
        <div className="space-y-1">
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="space-y-1 text-right">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag-and-drop Watchlist Editor
// ---------------------------------------------------------------------------

function WatchlistEditor({ market }: { market: "TW" | "US" }) {
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const dragItemId = useRef<number | null>(null);

  const { data: watchlistItems = [] } = useQuery<WatchlistItem[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
  });

  const addMutation = useMutation({
    mutationFn: (item: { symbol: string; name: string; market: string }) =>
      apiRequest("POST", "/api/watchlist", item).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlist"] });
      queryClient.invalidateQueries({ queryKey: ["/api/quotes"] });
      setSymbol("");
      setName("");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/watchlist/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlist"] });
      queryClient.invalidateQueries({ queryKey: ["/api/quotes"] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (payload: { dragId: number; dropId: number }) =>
      apiRequest("PATCH", `/api/watchlist/reorder`, payload).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlist"] });
      queryClient.invalidateQueries({ queryKey: ["/api/quotes"] });
    },
  });

  const filtered = watchlistItems.filter((item) => item.market === market);

  const handleAdd = () => {
    const trimmedSymbol = symbol.trim().toUpperCase();
    const trimmedName = name.trim();
    if (!trimmedSymbol || !trimmedName) return;
    if (filtered.some((item) => item.symbol === trimmedSymbol)) {
      return; // already exists
    }
    addMutation.mutate({ symbol: trimmedSymbol, name: trimmedName, market });
  };

  const handleDragStart = (e: React.DragEvent, id: number) => {
    dragItemId.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
    requestAnimationFrame(() => {
      (e.target as HTMLElement).style.opacity = "0.4";
    });
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.target as HTMLElement).style.opacity = "1";
    setDragOverId(null);
    dragItemId.current = null;
  };

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragItemId.current !== id) {
      setDragOverId(id);
    }
  };

  const handleDragLeave = () => {
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, dropId: number) => {
    e.preventDefault();
    setDragOverId(null);
    const dragId = dragItemId.current;
    if (!dragId || dragId === dropId) return;
    reorderMutation.mutate({ dragId, dropId });
    dragItemId.current = null;
  };

  return (
    <div className="space-y-4">
      {/* Add form */}
      <div className="flex gap-2">
        <Input
          placeholder={market === "TW" ? "股票代號 (如 2317)" : "Ticker (e.g. AAPL)"}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="flex-1 h-9 text-sm"
          data-testid="input-watchlist-symbol"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Input
          placeholder={market === "TW" ? "名稱 (如 鴻海)" : "Name (e.g. Apple)"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 h-9 text-sm"
          data-testid="input-watchlist-name"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!symbol.trim() || !name.trim() || addMutation.isPending}
          className="h-9 px-3"
          data-testid="btn-add-watchlist"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        共 {filtered.length} 個標的。拖曳左側 <GripVertical className="inline w-3 h-3" /> 圖示可重新排序。
      </p>

      {/* Drag-and-drop list */}
      <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">尚無標的</div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => handleDragStart(e, item.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, item.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, item.id)}
              className={cn(
                "flex items-center gap-2 py-1.5 px-2 rounded transition-all select-none",
                dragOverId === item.id
                  ? "bg-primary/20 border border-primary/40"
                  : "hover:bg-muted/30 border border-transparent"
              )}
              data-testid={`watchlist-item-${item.symbol}`}
            >
              <span className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground shrink-0 touch-none">
                <GripVertical className="w-4 h-4" />
              </span>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono shrink-0">
                  {item.symbol}
                </Badge>
                <span className="text-sm truncate">{item.name}</span>
              </div>
              <button
                onClick={() => removeMutation.mutate(item.id)}
                disabled={removeMutation.isPending}
                className="p-1 rounded hover:bg-destructive/20 transition-all shrink-0"
                title="刪除此標的"
                data-testid={`btn-remove-watchlist-${item.symbol}`}
              >
                <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [editingMarket, setEditingMarket] = useState<"TW" | "US" | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<QuotesResponse>({
    queryKey: ["/api/quotes"],
    queryFn: () => apiRequest("GET", "/api/quotes").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 5 * 60_000,
    placeholderData: (prev: QuotesResponse | undefined) => prev,
  });

  const { data: watchlistItems = [] } = useQuery<WatchlistItem[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/watchlist/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlist"] });
      queryClient.invalidateQueries({ queryKey: ["/api/quotes"] });
    },
  });

  const quoteMap = new Map<string, StockQuote>();
  data?.quotes.forEach((q) => quoteMap.set(q.symbol, q));
  data?.indices.forEach((q) => quoteMap.set(q.symbol, q));

  const watchlistMap = new Map<string, WatchlistItem>();
  watchlistItems.forEach((item) => watchlistMap.set(`${item.symbol}_${item.market}`, item));

  const allQuotes = data?.quotes ?? [];
  const sortedQuotes = [...allQuotes].sort((a, b) => {
    const wa = watchlistMap.get(`${a.symbol}_${a.market}`);
    const wb = watchlistMap.get(`${b.symbol}_${b.market}`);
    return (wa?.sortOrder ?? 999) - (wb?.sortOrder ?? 999);
  });

  const twStocks = sortedQuotes.filter((q) => q.market === "TW");
  const usStocks = sortedQuotes.filter((q) => q.market === "US");

  const twiiIdx = quoteMap.get("TWII");
  const usdtwd  = quoteMap.get("USDTWD");
  const sp500   = quoteMap.get("GSPC");

  const lastFetchTime = data?.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString("zh-TW", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div className="p-6 space-y-6" data-testid="dashboard-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">市場總覽</h1>
          <p className="text-sm text-muted-foreground mt-0.5">即時台股與美股行情追蹤</p>
        </div>
        <div className="flex items-center gap-2">
          {lastFetchTime && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              更新於 {lastFetchTime}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded hover:bg-muted/40 transition-colors disabled:opacity-50"
            title="手動刷新"
            data-testid="btn-refresh-quotes"
          >
            <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", isFetching && "animate-spin")} />
          </button>
          <Badge variant="outline" className="text-xs tabular-nums gap-1">
            <Activity className="w-3 h-3" />
            即時更新
          </Badge>
        </div>
      </div>

      {/* Error banner */}
      {isError && (
        <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          無法連接行情服務，顯示最後已知數據。請稍後重試。
        </div>
      )}
      {data?.errors && data.errors.length > 0 && (
        <div className="text-[11px] text-amber-400/80 bg-amber-400/5 border border-amber-400/15 rounded-lg px-3 py-1.5">
          部分股票取得失敗：{data.errors.join(" · ")}
        </div>
      )}

      {/* ── NEW: Market Indicators Section ── */}
      <MarketOverviewSection />

      {/* Stock Lists */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* TW Stocks */}
        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">台股自選</CardTitle>
              <div className="flex items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">{twStocks.length || TW_SYMBOLS.length} 檔</Badge>
                <Dialog open={editingMarket === "TW"} onOpenChange={(open) => setEditingMarket(open ? "TW" : null)}>
                  <DialogTrigger asChild>
                    <button
                      className="p-1 rounded hover:bg-muted/40 transition-colors"
                      title="編輯台股自選"
                      data-testid="btn-edit-tw-watchlist"
                    >
                      <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="text-base">編輯台股自選標的</DialogTitle>
                    </DialogHeader>
                    <WatchlistEditor market="TW" />
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            <div className="divide-y divide-border/50">
              {isLoading
                ? TW_SYMBOLS.map((s) => <StockRowSkeleton key={s} />)
                : twStocks.map((stock) => {
                    const wlItem = watchlistMap.get(`${stock.symbol}_TW`);
                    return (
                      <StockRow
                        key={stock.symbol}
                        stock={stock}
                        onRemove={wlItem ? () => removeMutation.mutate(wlItem.id) : undefined}
                      />
                    );
                  })}
            </div>
          </CardContent>
        </Card>

        {/* US Stocks */}
        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">美股自選</CardTitle>
              <div className="flex items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">{usStocks.length || US_SYMBOLS.length} 檔</Badge>
                <Dialog open={editingMarket === "US"} onOpenChange={(open) => setEditingMarket(open ? "US" : null)}>
                  <DialogTrigger asChild>
                    <button
                      className="p-1 rounded hover:bg-muted/40 transition-colors"
                      title="編輯美股自選"
                      data-testid="btn-edit-us-watchlist"
                    >
                      <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="text-base">編輯美股自選標的</DialogTitle>
                    </DialogHeader>
                    <WatchlistEditor market="US" />
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            <div className="divide-y divide-border/50">
              {isLoading
                ? US_SYMBOLS.map((s) => <StockRowSkeleton key={s} />)
                : usStocks.map((stock) => {
                    const wlItem = watchlistMap.get(`${stock.symbol}_US`);
                    return (
                      <StockRow
                        key={stock.symbol}
                        stock={stock}
                        onRemove={wlItem ? () => removeMutation.mutate(wlItem.id) : undefined}
                      />
                    );
                  })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Market Heatmap — split TW / US */}
      <Card className="border-border">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">今日漲跌排行</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {isLoading ? (
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: 14 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : (
            <>
              {twStocks.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-muted-foreground mb-2 tracking-wide">台股</div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(twStocks.length, 6)}, minmax(0, 1fr))` }}>
                    {[...twStocks]
                      .sort((a, b) => b.changePercent - a.changePercent)
                      .map((stock) => {
                        const intensity = Math.min(Math.abs(stock.changePercent) / 3, 1);
                        const isPositive = stock.changePercent >= 0;
                        return (
                          <div
                            key={stock.symbol}
                            className="rounded-md p-2 text-center"
                            style={{
                              backgroundColor: isPositive
                                ? `rgba(239, 68, 68, ${intensity * 0.25})`
                                : `rgba(34, 197, 94, ${intensity * 0.25})`,
                            }}
                            data-testid={`heatmap-${stock.symbol}`}
                          >
                            <div className="text-[10px] font-semibold truncate leading-tight">{stock.name}</div>
                            <div className={cn("text-xs font-bold tabular-nums mt-0.5", isPositive ? "text-gain" : "text-loss")}>
                              {stock.changePercent.toFixed(1)}%
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
              {usStocks.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-muted-foreground mb-2 tracking-wide">美股</div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(usStocks.length, 8)}, minmax(0, 1fr))` }}>
                    {[...usStocks]
                      .sort((a, b) => b.changePercent - a.changePercent)
                      .map((stock) => {
                        const intensity = Math.min(Math.abs(stock.changePercent) / 3, 1);
                        const isPositive = stock.changePercent >= 0;
                        return (
                          <div
                            key={stock.symbol}
                            className="rounded-md p-2 text-center"
                            style={{
                              backgroundColor: isPositive
                                ? `rgba(239, 68, 68, ${intensity * 0.25})`
                                : `rgba(34, 197, 94, ${intensity * 0.25})`,
                            }}
                            data-testid={`heatmap-${stock.symbol}`}
                          >
                            <div className="text-[10px] font-semibold truncate leading-tight">{stock.symbol}</div>
                            <div className={cn("text-xs font-bold tabular-nums mt-0.5", isPositive ? "text-gain" : "text-loss")}>
                              {stock.changePercent.toFixed(1)}%
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Data source attribution */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ExternalLink className="w-3 h-3" />
        數據來源：
        <a
          href="https://finance.yahoo.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground transition-colors"
        >
          Yahoo Finance （台股）
        </a>
        <span>·</span>
        <a
          href="https://perplexity.ai/finance"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground transition-colors"
        >
          Perplexity Finance
        </a>
        {data?.fetchedAt && (
          <span className="ml-1 tabular-nums">· 最後取得 {lastFetchTime}</span>
        )}
      </div>
    </div>
  );
}
