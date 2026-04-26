import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
import {
  type CandleData,
  calculateRSI,
  calculateMACD,
  calculateBollinger,
  STOCK_META,
  formatDataAge,
} from "@/lib/stockData";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart, Area,
} from "recharts";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";
import { AnalysisSymbolSidebarMobile } from "@/components/AnalysisSymbolSidebar";

// ─── Trade dot types ─────────────────────────────────────────────────────────
interface TradeDot {
  date: string;       // chart date key ("MM-DD")
  fullDate: string;   // "YYYY-MM-DD"
  side: "buy" | "sell";
  price: number;
  shares: number;
  currency: string;
}

interface Transaction {
  id: number;
  tradeDate: string;
  symbol: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  shares: number;
  currency: string;
  name: string;
}

// ─── Analyst target types ────────────────────────────────────────────────────
interface AnalystOverlayEvent {
  date: string;
  institution: string;
  rating: string;
  ratingCategory: "bullish" | "neutral" | "bearish";
  targetPrice: number;
  previousTargetPrice: number | null;
  direction: "up" | "down" | "flat";
}

interface AnalystRow {
  id: number;
  symbol: string;
  market: string;
  institution: string;
  rating: string;
  ratingCategory: "bullish" | "neutral" | "bearish";
  score: number;
  targetPrice: number;
  previousTargetPrice: number | null;
  analystDate: string;
}

interface AnalystSummary {
  consensusLabel: string;
  averageScore: number;
  bullishCount: number;
  neutralCount: number;
  bearishCount: number;
  bullishPct: number;
  neutralPct: number;
  bearishPct: number;
  averageTargetPrice: number;
  highTargetPrice: number;
  lowTargetPrice: number;
  sampleCount: number;
}

interface AnalystData {
  symbol: string;
  market: string;
  hasData: boolean;
  summary?: AnalystSummary;
  overlayEvents?: AnalystOverlayEvent[];
  rows?: AnalystRow[];
}

// ─── Consensus colour helpers ─────────────────────────────────────────────────
function consensusColor(label: string): string {
  if (label === "強烈買入") return "text-[#ef4444]";
  if (label === "買入")     return "text-[#f87171]";
  if (label === "持有")     return "text-muted-foreground";
  if (label === "賣出")     return "text-[#4ade80]";
  return "text-[#22c55e]"; // 強烈賣出
}

// ─── Custom dot renderer for buy/sell marks ───────────────────────────────────
function TradeDotRenderer(props: any) {
  const { cx, cy, payload } = props;
  if (!payload?.tradeInfo) return null;
  const { side } = payload.tradeInfo as TradeDot;
  const color = side === "buy" ? "#ef4444" : "#22c55e";
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={color} stroke="#fff" strokeWidth={1.5} opacity={0.92} style={{ cursor: "pointer" }} />
      <circle cx={cx} cy={cy} r={9} fill={color} opacity={0.15} />
    </g>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────
function BollingerTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  const hasTrade = !!p?.tradeInfo;
  const curr = p?.tradeInfo?.currency ?? "TWD";
  const sym = curr === "USD" ? "$" : "NT";
  // analyst overlay event for this date
  const hasAnalyst = !!p?.analystEvent;
  const ae: AnalystOverlayEvent | null = p?.analystEvent ?? null;
  return (
    <div style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "8px 12px", fontSize: 12, minWidth: 180 }}>
      <p className="text-muted-foreground mb-1">{p?.fullDate ?? label}</p>
      {payload.map((item: any, i: number) => {
        if (!item.value && item.value !== 0) return null;
        if (["buyDot", "sellDot", "analystDot"].includes(item.dataKey)) return null;
        return (
          <div key={i} className="flex justify-between gap-4">
            <span style={{ color: item.color }}>{item.name}</span>
            <span className="tabular-nums font-medium">{typeof item.value === "number" ? item.value.toLocaleString() : item.value}</span>
          </div>
        );
      })}
      {hasTrade && (
        <div style={{ borderTop: "1px solid hsl(var(--border))", marginTop: 6, paddingTop: 6 }}>
          <div className="flex items-center gap-1.5">
            <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: p.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e" }} />
            <span className="font-semibold" style={{ color: p.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e" }}>
              {p.tradeInfo.side === "buy" ? "買進" : "賣出"}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">成交價</span>
            <span className="tabular-nums font-medium">{sym}{p.tradeInfo.price.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">股數</span>
            <span className="tabular-nums font-medium">{p.tradeInfo.shares.toLocaleString()}</span>
          </div>
        </div>
      )}
      {hasAnalyst && ae && (
        <div style={{ borderTop: "1px solid hsl(var(--border))", marginTop: 6, paddingTop: 6 }}>
          <div className="flex items-center gap-1.5 mb-1">
            <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: ae.direction === "up" ? "#ef4444" : ae.direction === "down" ? "#22c55e" : "#94a3b8" }} />
            <span className="font-semibold text-muted-foreground">{ae.institution}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">評級</span>
            <span className="font-medium" style={{ color: ae.ratingCategory === "bullish" ? "#f87171" : ae.ratingCategory === "bearish" ? "#4ade80" : "#cbd5e1" }}>{ae.rating}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">目標價</span>
            <span className="tabular-nums font-medium">${ae.targetPrice.toLocaleString()}</span>
          </div>
          {ae.previousTargetPrice !== null && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">原目標價</span>
              <span className="tabular-nums font-medium text-muted-foreground">${ae.previousTargetPrice.toLocaleString()}</span>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">調整</span>
            <span style={{ color: ae.direction === "up" ? "#ef4444" : ae.direction === "down" ? "#22c55e" : "#94a3b8" }}>
              {ae.direction === "up" ? "上調" : ae.direction === "down" ? "下修" : "維持"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analyst ReferenceLine label: T-shaped SVG label ────────────────────────
// Uses Recharts built-in ReferenceLine (Y = targetPrice) with a custom SVG label.
// This is the most stable approach — no xAxisMap/yAxisMap access needed.
function AnalystRefLabel(props: any) {
  const { viewBox, event }: { viewBox?: { x: number; y: number }; event: AnalystOverlayEvent } = props;
  if (!viewBox) return null;
  const { x, y } = viewBox;
  const color = event.direction === "up" ? "#ef4444" : event.direction === "down" ? "#22c55e" : "#94a3b8";
  const hLen = 14;
  return (
    <g>
      {/* Horizontal bar at new target price */}
      <line x1={x - hLen} y1={y} x2={x + hLen} y2={y} stroke={color} strokeWidth={2.5} opacity={0.88} />
      {/* Centre dot */}
      <circle cx={x} cy={y} r={3} fill={color} opacity={0.92} />
      {/* Direction tick */}
      {event.direction !== "flat" && (
        <line
          x1={x} y1={y}
          x2={x} y2={y + (event.direction === "up" ? -16 : 16)}
          stroke={color} strokeWidth={1.5} opacity={0.75}
        />
      )}
    </g>
  );
}



// ─── Wide consensus + target price card ──────────────────────────────────────
// Redesigned to match reference: compact single-row layout, thin typography,
// custom track bar with labelled dots above the bar.
function AnalystWideCard({
  summary,
  currentPrice,
  currencySymbol,
}: {
  summary: AnalystSummary;
  currentPrice: number;
  currencySymbol: string;
}) {
  const { lowTargetPrice, highTargetPrice, averageTargetPrice } = summary;

  const range = highTargetPrice - lowTargetPrice;
  const safeRange = range <= 0 ? 1 : range;

  // Position of each point on 0-100 scale, clamped to [4, 96] to keep dots visible
  const pctOf = (v: number) =>
    Math.max(4, Math.min(96, Math.round(((v - lowTargetPrice) / safeRange) * 100)));

  const lowPct  = 4;
  const highPct = 96;
  const currPct = Math.max(6, Math.min(94, pctOf(Math.max(lowTargetPrice, Math.min(highTargetPrice, currentPrice)))));
  const avgPct  = Math.max(6, Math.min(94, pctOf(averageTargetPrice)));

  const upsidePct = currentPrice > 0
    ? ((averageTargetPrice - currentPrice) / currentPrice * 100).toFixed(1)
    : "—";

  return (
    <Card className="border-border mb-4">
      <CardContent className="p-0">
        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">

          {/* ── Left: Consensus ── */}
          <div className="px-6 py-4">
            <div className="text-[13px] font-medium text-foreground mb-3">分析師共識</div>
            <div className="grid grid-cols-5 gap-3 items-start">
              {/* Consensus result — spans 2 cols so the three count cols sit to the right */}
              <div className="col-span-2">
                <div className="text-[12px] text-muted-foreground mb-1">共識</div>
                <div className={cn("text-[16px] font-semibold leading-tight whitespace-nowrap", consensusColor(summary.consensusLabel))}>
                  {summary.consensusLabel}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  平均分數 {summary.averageScore}
                </div>
              </div>
              {/* Bullish */}
              <div>
                <div className="text-[12px] text-muted-foreground mb-1">看漲</div>
                <div className="text-[22px] font-semibold text-[#ef4444] leading-tight">{summary.bullishCount}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{summary.bullishPct}%</div>
              </div>
              {/* Neutral */}
              <div>
                <div className="text-[12px] text-muted-foreground mb-1">中性</div>
                <div className="text-[22px] font-semibold text-foreground leading-tight">{summary.neutralCount}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{summary.neutralPct}%</div>
              </div>
              {/* Bearish */}
              <div>
                <div className="text-[12px] text-muted-foreground mb-1">看跌</div>
                <div className="text-[22px] font-semibold text-[#22c55e] leading-tight">{summary.bearishCount}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{summary.bearishPct}%</div>
              </div>
            </div>
          </div>

          {/* ── Right: 52W target price band ── */}
          <div className="px-6 py-4">
            <div className="text-[13px] font-medium text-foreground mb-3">
              分析師 52W 目標價
              <span className="ml-2 text-[11px] text-muted-foreground font-normal">
                近 6 個月樣本：{summary.sampleCount} 筆
              </span>
            </div>

            {/* Price labels row */}
            <div className="grid grid-cols-4 gap-2 mb-2">
              <div>
                <div className="text-[13px] font-semibold text-[#22c55e] tabular-nums">
                  {currencySymbol}{lowTargetPrice.toLocaleString()}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[11px] text-muted-foreground">低</span>
                </div>
              </div>
              <div>
                <div className="text-[13px] font-semibold text-foreground tabular-nums">
                  {currencySymbol}{currentPrice > 0 ? currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #fff", background: "transparent", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[11px] text-muted-foreground">目前</span>
                </div>
              </div>
              <div>
                <div className="text-[13px] font-semibold text-[#fda4af] tabular-nums">
                  {currencySymbol}{averageTargetPrice.toLocaleString()}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #fda4af", background: "transparent", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[11px] text-muted-foreground">平均 ({Number(upsidePct) >= 0 ? "+" : ""}{upsidePct}%)</span>
                </div>
              </div>
              <div>
                <div className="text-[13px] font-semibold text-[#ef4444] tabular-nums">
                  {currencySymbol}{highTargetPrice.toLocaleString()}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[11px] text-muted-foreground">高</span>
                </div>
              </div>
            </div>

            {/* Track bar */}
            <div className="relative mt-3" style={{ height: 20 }}>
              {/* Bar */}
              <div style={{
                position: "absolute",
                top: "50%",
                left: 0,
                right: 0,
                height: 4,
                borderRadius: 999,
                transform: "translateY(-50%)",
                background: "linear-gradient(90deg, rgba(34,197,94,.3) 0%, rgba(255,255,255,.12) 50%, rgba(239,68,68,.35) 100%)",
              }} />
              {/* Low dot — small solid green */}
              <span style={{
                position: "absolute", top: "50%", left: `${lowPct}%`,
                transform: "translate(-50%,-50%)",
                width: 8, height: 8, borderRadius: "50%",
                background: "#22c55e", display: "block",
              }} />
              {/* Current dot — larger open circle white */}
              <span style={{
                position: "absolute", top: "50%", left: `${currPct}%`,
                transform: "translate(-50%,-50%)",
                width: 14, height: 14, borderRadius: "50%",
                border: "2.5px solid #ffffff",
                background: "hsl(var(--card))", display: "block",
              }} />
              {/* Average dot — open circle pink */}
              <span style={{
                position: "absolute", top: "50%", left: `${avgPct}%`,
                transform: "translate(-50%,-50%)",
                width: 12, height: 12, borderRadius: "50%",
                border: "2px solid #fda4af",
                background: "hsl(var(--card))", display: "block",
              }} />
              {/* High dot — small solid red */}
              <span style={{
                position: "absolute", top: "50%", left: `${highPct}%`,
                transform: "translate(-50%,-50%)",
                width: 8, height: 8, borderRadius: "50%",
                background: "#ef4444", display: "block",
              }} />
            </div>
          </div>

        </div>
      </CardContent>
    </Card>
  );
}

// ─── Analyst target price table ───────────────────────────────────────────────
function AnalystTargetTable({
  rows,
  currentPrice,
  currencySymbol,
}: {
  rows: AnalystRow[];
  currentPrice: number;
  currencySymbol: string;
}) {
  if (!rows.length) return null;

  const ratingPillClass = (cat: string) => {
    if (cat === "bullish") return "bg-red-500/10 text-red-300 border border-red-500/20";
    if (cat === "bearish") return "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20";
    return "bg-slate-500/10 text-slate-300 border border-slate-500/20";
  };

  return (
    <Card className="border-border mt-4">
      <CardHeader className="pb-1.5 pt-3 px-4 flex-row items-center justify-between">
        <CardTitle className="text-xs font-semibold">分析師目標價資料表</CardTitle>
        <span className="text-[10px] text-muted-foreground">依日期新到舊，近 6 個月資料</span>
      </CardHeader>
      <CardContent className="p-0 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-card/80">
              <th className="text-left text-muted-foreground font-medium px-3 py-1.5 border-b border-border">機構</th>
              <th className="text-left text-muted-foreground font-medium px-3 py-1.5 border-b border-border">評級</th>
              <th className="text-left text-muted-foreground font-medium px-3 py-1.5 border-b border-border">新目標價</th>
              <th className="text-left text-muted-foreground font-medium px-3 py-1.5 border-b border-border">原目標價</th>
              <th className="text-left text-muted-foreground font-medium px-3 py-1.5 border-b border-border">上行空間</th>
              <th className="text-left text-muted-foreground font-medium px-3 py-1.5 border-b border-border">日期</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const upsidePct = currentPrice > 0
                ? ((row.targetPrice - currentPrice) / currentPrice * 100)
                : null;

              const upsideColor = upsidePct === null ? "" : upsidePct > 0 ? "text-[#f87171]" : upsidePct < 0 ? "text-[#4ade80]" : "text-muted-foreground";

              const dateFormatted = row.analystDate
                ? row.analystDate.replace(/-/g, "/")
                : "—";

              return (
                <tr key={row.id ?? i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-1.5 font-medium">{row.institution}</td>
                  <td className={cn(
                    "px-3 py-1.5 font-bold",
                    row.ratingCategory === "bullish" ? "text-[#fca5a5]" :
                    row.ratingCategory === "bearish" ? "text-[#4ade80]" :
                    "text-foreground"
                  )}>{row.rating}</td>
                  <td className="px-3 py-1.5 tabular-nums font-medium">
                    {currencySymbol}{row.targetPrice.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                    {row.previousTargetPrice !== null && row.previousTargetPrice !== undefined
                      ? `${currencySymbol}${row.previousTargetPrice.toLocaleString()}`
                      : "—"}
                  </td>
                  <td className={cn("px-3 py-1.5 tabular-nums font-medium", upsideColor)}>
                    {upsidePct === null ? "—" : `${upsidePct >= 0 ? "+" : ""}${upsidePct.toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground tabular-nums">{dateFormatted}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── Range options ────────────────────────────────────────────────────────────
interface HistoryResponse {
  symbol: string;
  bars: CandleData[];
  fetchedAt: number;
  source: string;
  dataFrom: string;
  dataTo: string;
  dataSource: string;
  fromDatabase?: boolean;
  fromCache?: boolean;
  refreshAttempted?: boolean;
  refreshSucceeded?: boolean;
  lastStoredDate?: string;
}

const RANGE_OPTIONS = [
  { value: "1mo", label: "1個月" },
  { value: "3mo", label: "3個月" },
  { value: "6mo", label: "6個月" },
  { value: "1y",  label: "1年" },
];

/** Client-side slice of the full-year bars pool */
function sliceFullYearBars(bars: CandleData[], range: string): CandleData[] {
  if (!bars.length) return bars;
  const cutoff = new Date();
  if (range === "1mo")      cutoff.setMonth(cutoff.getMonth() - 1);
  else if (range === "3mo") cutoff.setMonth(cutoff.getMonth() - 3);
  else if (range === "6mo") cutoff.setMonth(cutoff.getMonth() - 6);
  else return bars;
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return bars.filter((b) => b.time >= cutoffStr);
}

export default function TechnicalAnalysis() {
  const { activeSymbol, activeMarket } = useActiveSymbol();
  const [range, setRange] = useState("3mo");

  // Watchlist meta
  const { data: watchlist } = useQuery<{ id: number; symbol: string; name: string; market: "TW" | "US"; sortOrder: number }[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  const meta = useMemo(() => {
    const wItem = watchlist?.find((w) => w.symbol === activeSymbol);
    if (wItem) return { name: wItem.name, market: wItem.market };
    return STOCK_META[activeSymbol] ?? { name: activeSymbol, market: activeMarket };
  }, [watchlist, activeSymbol, activeMarket]);

  // Historical data (full 1-year pool)
  const { data, isLoading, isError, isFetching } = useQuery<HistoryResponse>({
    queryKey: ["/api/history", activeSymbol, meta.market],
    queryFn: () =>
      apiRequest("GET", `/api/history/${activeSymbol}?market=${meta.market}&range=1y`)
        .then((r) => r.json()),
    staleTime: 55_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev: HistoryResponse | undefined) => prev,
  });

  // Transactions for buy/sell dots
  const { data: symbolTxns } = useQuery<Transaction[]>({
    queryKey: ["/api/transactions", activeSymbol],
    queryFn: () =>
      apiRequest("GET", `/api/transactions/${activeSymbol}?market=${meta.market}`)
        .then(r => r.json()),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  // Analyst targets
  const { data: analystData } = useQuery<AnalystData>({
    queryKey: [`/api/analyst-targets/${activeSymbol}`, meta.market],
    queryFn: () =>
      apiRequest("GET", `/api/analyst-targets/${activeSymbol}?market=${meta.market}`)
        .then(r => r.json()),
    staleTime: 60_000,
    enabled: !!activeSymbol,
    placeholderData: (prev) => prev,
  });

  // Client-side range slice
  const fullYearBars: CandleData[] = data?.bars ?? [];
  const candleData: CandleData[] = useMemo(
    () => sliceFullYearBars(fullYearBars, range),
    [fullYearBars, range]
  );

  const rsi          = useMemo(() => (candleData.length >= 15 ? calculateRSI(candleData) : []), [candleData]);
  const macdData     = useMemo(() => (candleData.length >= 27 ? calculateMACD(candleData) : { macd: [], signal: [], histogram: [] }), [candleData]);
  const bollingerData = useMemo(() => (candleData.length >= 20 ? calculateBollinger(candleData) : { upper: [], middle: [], lower: [] }), [candleData]);

  // Trade dot map
  const tradeDotMap = useMemo(() => {
    const map = new Map<string, TradeDot>();
    if (!symbolTxns?.length) return map;
    for (const tx of symbolTxns) {
      if (tx.side === "dividend" || tx.price <= 0) continue;
      map.set(tx.tradeDate, {
        date: tx.tradeDate.slice(5),
        fullDate: tx.tradeDate,
        side: tx.side,
        price: tx.price,
        shares: tx.shares,
        currency: tx.currency,
      });
    }
    return map;
  }, [symbolTxns]);

  // Analyst overlay event map (date → event, for single-event-per-date quick access in chartData)
  const analystEventMap = useMemo(() => {
    const map = new Map<string, AnalystOverlayEvent>();
    if (!analystData?.overlayEvents?.length) return map;
    for (const ev of analystData.overlayEvents) {
      // If multiple on same date, keep the last one for tooltip (all shown in chart via custom layer)
      map.set(ev.date, ev);
    }
    return map;
  }, [analystData]);

  const chartData = useMemo(
    () =>
      candleData.map((d, i) => {
        const tradeInfo   = tradeDotMap.get(d.time) ?? null;
        const analystEvent = analystEventMap.get(d.time) ?? null;
        return {
          date: d.time.slice(5),
          fullDate: d.time,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
          rsi: rsi[i] ?? null,
          macd: macdData.macd[i] ?? null,
          signal: macdData.signal[i] ?? null,
          histogram: macdData.histogram[i] ?? null,
          bbUpper: bollingerData.upper[i] ?? null,
          bbMiddle: bollingerData.middle[i] ?? null,
          bbLower: bollingerData.lower[i] ?? null,
          tradeDot: tradeInfo ? tradeInfo.price : null,
          tradeInfo,
          analystEvent,
          // analystDot: targetPrice when there's an event, so T-marker sits at correct price level
          analystDot: analystEvent?.targetPrice ?? null,
        };
      }),
    [candleData, rsi, macdData, bollingerData, tradeDotMap, analystEventMap]
  );

  const lastRSI    = rsi[rsi.length - 1] ?? 50;
  const lastMACD   = macdData.macd[macdData.macd.length - 1] ?? 0;
  const lastSignal = macdData.signal[macdData.signal.length - 1] ?? 0;
  const lastClose  = candleData[candleData.length - 1]?.close ?? 0;
  const lastBBUpper = bollingerData.upper[bollingerData.upper.length - 1] ?? lastClose * 1.02;
  const lastBBLower = bollingerData.lower[bollingerData.lower.length - 1] ?? lastClose * 0.98;

  const rsiSignal  = lastRSI > 70 ? "超買" : lastRSI < 30 ? "超賣" : "中性";
  const macdSignal = lastMACD > lastSignal ? "多頭" : "空頭";
  const bbPosition = lastClose > lastBBUpper ? "超漲" : lastClose < lastBBLower ? "超跌" : "區間內";
  const xInterval  = Math.max(1, Math.floor(chartData.length / 12));

  const currencySymbol = meta.market === "US" ? "$" : "NT";
  const hasAnalyst = !!analystData?.hasData &&
    !!analystData.summary &&
    isFinite(analystData.summary.averageTargetPrice) &&
    isFinite(analystData.summary.highTargetPrice) &&
    isFinite(analystData.summary.lowTargetPrice);
  // Filter overlay events to only those within the current sliced date range
  const visibleOverlayEvents = useMemo(() => {
    if (!analystData?.overlayEvents?.length || !candleData.length) return [];
    const firstDate = candleData[0].time;
    const lastDate  = candleData[candleData.length - 1].time;
    return analystData.overlayEvents.filter(ev => ev.date >= firstDate && ev.date <= lastDate);
  }, [analystData, candleData]);

  return (
    <div className="p-6 space-y-4" data-testid="analysis-page">
      {/* ── Header: stock name + symbol + analyst mini card ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold leading-tight">{meta.name}</h1>
          <div className="flex items-center gap-2 mt-1.5 text-sm text-muted-foreground">
            <span>{activeSymbol}</span>
            <span>·</span>
            <span>{meta.market === "US" ? "NYSE / NASDAQ" : "台灣證交所"}</span>
            <Badge variant="outline" className="text-[11px] py-0.5">技術分析</Badge>
            {hasAnalyst && (
              <Badge variant="outline" className="text-[11px] py-0.5">
                近 6 個月分析師樣本：{analystData!.summary!.sampleCount} 筆
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <AnalysisSymbolSidebarMobile />
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-[110px]" data-testid="range-selector">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isFetching && <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />}
          </div>
        </div>
      </div>

      {/* Error */}
      {isError && (
        <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          無法取得 {activeSymbol} 歷史數據，請稍後重試。
        </div>
      )}

      {/* DB fallback notice */}
      {!isError && data?.fromDatabase && data?.refreshAttempted && !data?.refreshSucceeded && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          已顯示稍早資料（最新資料暫時無法取得，將在下次自動重試）
        </div>
      )}

      {/* ── Wide analyst card (above charts) ── */}
      {hasAnalyst && (
        <AnalystWideCard
          summary={analystData!.summary!}
          currentPrice={lastClose}
          currencySymbol={currencySymbol}
        />
      )}

      {/* Signal Cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">RSI (14日)</div>
            {isLoading ? <Skeleton className="h-7 w-full" /> : (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tabular-nums">{lastRSI.toFixed(1)}</span>
                <Badge
                  variant={rsiSignal === "超買" ? "destructive" : rsiSignal === "超賣" ? "default" : "secondary"}
                  className="text-[10px]"
                >
                  {rsiSignal}
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">MACD 訊號</div>
            {isLoading ? <Skeleton className="h-7 w-full" /> : (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tabular-nums">{lastMACD.toFixed(2)}</span>
                <Badge
                  variant={macdSignal === "多頭" ? "default" : "destructive"}
                  className={cn("text-[10px]", macdSignal === "多頭" ? "bg-red-500/20 text-red-500 border-red-500/30" : "bg-emerald-500/20 text-emerald-500 border-emerald-500/30")}
                >
                  {macdSignal}
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">布林通道</div>
            {isLoading ? <Skeleton className="h-7 w-full" /> : (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tabular-nums">{lastClose.toFixed(1)}</span>
                <Badge variant="secondary" className="text-[10px]">{bbPosition}</Badge>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Price + Bollinger Chart ── */}
      <Card className="border-border">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-semibold">
              {activeSymbol} — 價格走勢與布林通道
              {visibleOverlayEvents.length > 0 && (
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  紅色正 T = 調升目標價，綠色倒 T = 下修目標價
                </span>
              )}
            </CardTitle>
            {data && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {data.dataFrom} → {data.dataTo}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          {isLoading ? (
            <Skeleton className="w-full h-[320px] rounded-md" />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={xInterval} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={65} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip content={<BollingerTooltip />} />
                <Area type="monotone" dataKey="bbUpper" stroke="none" fill="hsl(var(--chart-1))" fillOpacity={0.06} />
                <Area type="monotone" dataKey="bbLower" stroke="none" fill="hsl(var(--background))" fillOpacity={1} />
                <Line type="monotone" dataKey="bbUpper" stroke="hsl(var(--chart-1))" strokeWidth={1} strokeDasharray="4 4" dot={false} name="布林上軌" />
                <Line type="monotone" dataKey="bbMiddle" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="2 2" dot={false} name="中軌" />
                <Line type="monotone" dataKey="bbLower" stroke="hsl(var(--chart-1))" strokeWidth={1} strokeDasharray="4 4" dot={false} name="布林下軌" />
                <Line type="monotone" dataKey="close" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="收盤價" />
                {/* Buy/sell trade dots */}
                <Line
                  type="monotone"
                  dataKey="tradeDot"
                  stroke="none"
                  dot={(props: any) => {
                    const { payload } = props;
                    if (!payload?.tradeInfo) return <g key={props.key} />;
                    const color = payload.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e";
                    return (
                      <g key={props.key}>
                        <circle cx={props.cx} cy={props.cy} r={8} fill={color} opacity={0.15} />
                        <circle cx={props.cx} cy={props.cy} r={5} fill={color} stroke="#fff" strokeWidth={1.5} opacity={0.95} />
                      </g>
                    );
                  }}
                  activeDot={(props: any) => {
                    const { payload } = props;
                    if (!payload?.tradeInfo) return <g key="active" />;
                    const color = payload.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e";
                    return (
                      <g key="active">
                        <circle cx={props.cx} cy={props.cy} r={10} fill={color} opacity={0.2} />
                        <circle cx={props.cx} cy={props.cy} r={6} fill={color} stroke="#fff" strokeWidth={2} />
                      </g>
                    );
                  }}
                  name="交易點"
                  legendType="none"
                />
                <Bar dataKey="volume" fill="hsl(var(--muted))" opacity={0.3} yAxisId="volume" name="成交量" />
                <YAxis yAxisId="volume" orientation="right" tick={false} width={0} domain={[0, (max: number) => max * 5]} />
                {/* Average target price horizontal dashed line */}
                {hasAnalyst && isFinite(analystData.summary.averageTargetPrice) && (() => {
                  const avg = analystData.summary.averageTargetPrice;
                  const currentPrice = data?.currentPrice ?? 0;
                  const avgLineColor = currentPrice > 0
                    ? avg > currentPrice ? "#ef4444" : avg < currentPrice ? "#22c55e" : "#ffffff"
                    : "#ffffff";
                  return (
                    <ReferenceLine
                      y={avg}
                      stroke={avgLineColor}
                      strokeWidth={1}
                      strokeDasharray="5 4"
                      opacity={0.6}
                      label={false}
                    />
                  );
                })()}
                {/* Analyst T-marker: rendered as custom dots on a dedicated Line at close price */}
                {visibleOverlayEvents.length > 0 && (
                  <Line
                    type="monotone"
                    dataKey="analystDot"
                    stroke="none"
                    dot={(props: any) => {
                      const ev: AnalystOverlayEvent | null = props.payload?.analystEvent ?? null;
                      if (!ev) return <g key={props.key} />;
                      const { cx, cy } = props;
                      const color = ev.direction === "up" ? "#ef4444" : ev.direction === "down" ? "#22c55e" : "#94a3b8";
                      const hLen = 10;
                      return (
                        <g key={props.key}>
                          <line x1={cx - hLen} y1={cy} x2={cx + hLen} y2={cy} stroke={color} strokeWidth={1} opacity={0.9} />
                        </g>
                      );
                    }}
                    activeDot={false}
                    legendType="none"
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* RSI + MACD */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">RSI 相對強弱指標 (14日)</CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            {isLoading ? (
              <Skeleton className="w-full h-[200px] rounded-md" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={xInterval} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={30} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                    formatter={(v: any) => [typeof v === "number" ? v.toFixed(1) : v, "RSI"]}
                  />
                  <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" />
                  <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="rsi" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="RSI" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">MACD (12/26/9)</CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            {isLoading ? (
              <Skeleton className="w-full h-[200px] rounded-md" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={xInterval} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={50} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                    formatter={(v: any, name: string) => [typeof v === "number" ? v.toFixed(3) : v, name]}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" />
                  <Bar dataKey="histogram" fill="hsl(var(--chart-4))" opacity={0.6} name="柱狀圖" />
                  <Line type="monotone" dataKey="macd" stroke="hsl(var(--chart-1))" strokeWidth={1.5} dot={false} name="MACD" connectNulls />
                  <Line type="monotone" dataKey="signal" stroke="#f97316" strokeWidth={1.5} dot={false} name="訊號線" connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Analyst target price table (bottom) ── */}
      {hasAnalyst && analystData!.rows && analystData!.rows!.length > 0 && (
        <AnalystTargetTable
          rows={analystData!.rows!}
          currentPrice={lastClose}
          currencySymbol={currencySymbol}
        />
      )}

      {/* Data source */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ExternalLink className="w-3 h-3" />
        歷史數據來源：
        <a href="https://finance.yahoo.com" target="_blank" rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground transition-colors">
          Yahoo Finance
        </a>
        {data && (
          <span className="tabular-nums ml-1">
            · 取得時間 {new Date(data.fetchedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })}
          </span>
        )}
        · 技術指標由本地計算
      </div>
    </div>
  );
}
