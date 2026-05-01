/**
 * FundamentalAnalysis.tsx — V6.0 基本面分析頁
 *
 * UI 依照 v6-fundamentals-lly-mockup-v4.html 設計。
 * - 個股切換：右側既有 AnalysisSymbolSidebar（透過 StockAnalysisLayout）
 * - 評級色系：台股規則（極佳=紅最強, 良好=紅, 中性=白, 疲弱=綠, 差勁=綠最強）
 * - 資料來源：GET /api/fundamentals/:symbol?market=
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, ReferenceLine, CartesianGrid, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";
import { AnalysisSymbolSidebarMobile } from "@/components/AnalysisSymbolSidebar";
import type {
  FundamentalResult,
  MetricItem,
  PillarCard,
  QuarterlyBar,
  EpsPoint,
  FinancialEvent,
  SummaryRow,
  FundamentalRating,
} from "@/types/fundamental";

// ---------------------------------------------------------------------------
// ETF / Bond exclusion list (shared with sidebar filter in App.tsx)
// ---------------------------------------------------------------------------
export const EXCLUDED_FUNDAMENTAL_SYMBOLS = new Set(["0050", "00719B", "00891"]);

// ---------------------------------------------------------------------------
// Rating badge
// ---------------------------------------------------------------------------
const RATING_LABEL: Record<FundamentalRating, string> = {
  excellent: "極佳",
  good:      "良好",
  neutral:   "中性",
  weak:      "疲弱",
  poor:      "差勁",
};

// Taiwan color convention: gain=red (bullish), loss=green (bearish), neutral=white
const RATING_STYLE: Record<FundamentalRating, string> = {
  excellent: "text-[#fb7185] bg-[rgba(251,113,133,.15)] border border-[rgba(251,113,133,.24)]",
  good:      "text-[#ef4444] bg-[rgba(239,68,68,.14)] border border-[rgba(239,68,68,.22)]",
  neutral:   "text-[#f3f4f6] bg-[rgba(255,255,255,.09)] border border-[rgba(255,255,255,.14)]",
  weak:      "text-[#34d399] bg-[rgba(52,211,153,.14)] border border-[rgba(52,211,153,.24)]",
  poor:      "text-[#10b981] bg-[rgba(16,185,129,.14)] border border-[rgba(16,185,129,.22)]",
};

// Score number color
const SCORE_COLOR: Record<string, string> = {
  high:    "text-[#ef4444]",  // red (good)
  medium:  "text-[#f3f4f6]",  // white (neutral)
  low:     "text-[#10b981]",  // green (bad)
};

function scoreColor(score: number): string {
  if (score >= 65) return SCORE_COLOR.high;
  if (score >= 40) return SCORE_COLOR.medium;
  return SCORE_COLOR.low;
}

function RatingBadge({ rating }: { rating: FundamentalRating }) {
  return (
    <span className={cn(
      "inline-flex items-center justify-center min-w-[52px] px-2.5 py-[5px]",
      "rounded-full text-[12px] font-extrabold whitespace-nowrap",
      RATING_STYLE[rating]
    )}>
      {RATING_LABEL[rating]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Metric row
// ---------------------------------------------------------------------------
function MetricRow({ metric }: { metric: MetricItem }) {
  const isPositive = metric.value.startsWith("+") || (!metric.value.startsWith("-") && !metric.value.startsWith("N"));
  const hasSign = metric.value.startsWith("+") || metric.value.startsWith("-");
  const colorClass = hasSign
    ? (metric.value.startsWith("+") ? "text-[#ef4444]" : "text-[#10b981]")
    : "text-[#e6eef8]";

  return (
    <div className="border-t border-white/[0.06] pt-3.5 pb-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] text-[#dce6f3]">{metric.name}</span>
        <RatingBadge rating={metric.rating} />
      </div>
      <div className={cn("mt-2 text-[26px] font-extrabold", colorClass)}>
        {metric.value}
      </div>
      <div className="mt-1.5 text-[13px] text-[#8ea1b6] leading-snug">
        {metric.commentary}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pillar card
// ---------------------------------------------------------------------------
function PillarCardComponent({ card }: { card: PillarCard }) {
  return (
    <Card className="border border-white/[0.08] rounded-[22px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.98), rgba(7,12,20,.98))" }}>
      <CardContent className="p-[18px]">
        <div className="flex items-end justify-between mb-2.5">
          <h3 className="text-[17px] font-bold text-[#e6eef8]">{card.title}</h3>
          <span className={cn("text-[44px] font-black leading-none", scoreColor(card.score))}>
            {card.score}
          </span>
        </div>
        <p className="text-[14px] text-[#c8d6e7] leading-relaxed mb-1">
          {card.summary}
        </p>
        <div className="space-y-0">
          {card.metrics.map((m, i) => (
            <MetricRow key={i} metric={m} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rating legend
// ---------------------------------------------------------------------------
function RatingLegend() {
  const items: Array<[FundamentalRating, string]> = [
    ["excellent", "最好，偏多解讀"],
    ["good",      "正向但未到極強"],
    ["neutral",   "無明顯優劣"],
    ["weak",      "需追蹤留意"],
    ["poor",      "相對不利"],
  ];
  return (
    <Card className="border border-white/[0.08] rounded-[18px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.9), rgba(8,14,22,.94))" }}>
      <CardContent className="p-4">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-3">五級評價說明</h3>
        <div className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2.5 text-[14px]">
          {items.map(([rating, desc]) => (
            <>
              <div key={`badge-${rating}`}><RatingBadge rating={rating} /></div>
              <div key={`desc-${rating}`} className="flex items-center text-[#d7e3f1]">{desc}</div>
            </>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quarterly bar chart
// ---------------------------------------------------------------------------
function fmt(n: number, currency: string): string {
  if (currency === "TWD") {
    if (Math.abs(n) >= 1e12) return `NT ${(n / 1e12).toFixed(2)}T`;
    if (Math.abs(n) >= 1e9)  return `NT ${(n / 1e9).toFixed(1)}B`;
    if (Math.abs(n) >= 1e6)  return `NT ${(n / 1e6).toFixed(0)}M`;
    return `NT ${n.toLocaleString()}`;
  }
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function QuarterlyChart({ bars, currency }: { bars: QuarterlyBar[]; currency: string }) {
  if (bars.length === 0) return null;

  const chartData = bars.map((b) => ({
    quarter: b.quarter,
    revenue:         b.revenue,
    grossProfit:     b.grossProfit,
    operatingIncome: b.operatingIncome,
    netIncome:       b.netIncome,
  }));

  return (
    <Card className="border border-white/[0.08] rounded-[22px] mt-4" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.96), rgba(7,12,20,.96))" }}>
      <CardContent className="p-[18px]">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-1">季度營收與獲利</h3>
        <p className="text-[12px] text-[#8ea1b6] mb-3">柱狀 = 營收，折線 = 毛利 / 營業利益</p>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
              <XAxis dataKey="quarter" tick={{ fill: "#8ea1b6", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => fmt(v, currency)} tick={{ fill: "#8ea1b6", fontSize: 10 }} axisLine={false} tickLine={false} width={72} />
              <Tooltip
                contentStyle={{ background: "#0b1420", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#e6eef8", fontSize: 12 }}
                formatter={(v: number, name: string) => [fmt(v, currency), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "#8ea1b6" }} />
              <Bar dataKey="revenue"         name="營收"     fill="rgba(139,211,255,.22)" stroke="rgba(139,211,255,.16)" radius={[4,4,0,0]} />
              <Line type="monotone" dataKey="grossProfit"     name="毛利"     stroke="#fb7185" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="operatingIncome" name="營業利益" stroke="#7dd3fc" strokeWidth={2} dot={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EPS history chart
// ---------------------------------------------------------------------------
function EpsChart({ eps }: { eps: EpsPoint[] }) {
  if (eps.length === 0) return null;
  return (
    <Card className="border border-white/[0.08] rounded-[22px] mt-4" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.96), rgba(7,12,20,.96))" }}>
      <CardContent className="p-[18px]">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-1">EPS — 實際 vs 預估</h3>
        <p className="text-[12px] text-[#8ea1b6] mb-3">每股盈餘近 8 季對比</p>
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={eps} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
              <XAxis dataKey="quarter" tick={{ fill: "#8ea1b6", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#8ea1b6", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: "#0b1420", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#e6eef8", fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "#8ea1b6" }} />
              <Line type="monotone" dataKey="actual"   name="實際 EPS"  stroke="#fb7185" strokeWidth={2} dot={{ r: 3, fill: "#fb7185" }} />
              <Line type="monotone" dataKey="estimate" name="預估 EPS"  stroke="#8bd3ff" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Margin trend chart
// ---------------------------------------------------------------------------
function MarginChart({ bars, currency }: { bars: QuarterlyBar[]; currency: string }) {
  if (bars.length === 0) return null;
  const data = bars.map((b) => ({
    quarter: b.quarter,
    grossMargin: b.revenue > 0 ? +(b.grossProfit / b.revenue * 100).toFixed(1) : null,
    opMargin:    b.revenue > 0 ? +(b.operatingIncome / b.revenue * 100).toFixed(1) : null,
    netMargin:   b.revenue > 0 ? +(b.netIncome / b.revenue * 100).toFixed(1) : null,
  })).filter((d) => d.grossMargin != null);

  if (data.length === 0) return null;
  return (
    <Card className="border border-white/[0.08] rounded-[22px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.96), rgba(7,12,20,.96))" }}>
      <CardContent className="p-[18px]">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-1">獲利率趨勢</h3>
        <p className="text-[12px] text-[#8ea1b6] mb-3">毛利率 / 營益率 / 淨利率</p>
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
              <XAxis dataKey="quarter" tick={{ fill: "#8ea1b6", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: "#8ea1b6", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: "#0b1420", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#e6eef8", fontSize: 12 }}
                formatter={(v: number) => [`${v.toFixed(1)}%`]}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "#8ea1b6" }} />
              <Line type="monotone" dataKey="grossMargin" name="毛利率" stroke="#fb7185" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="opMargin"    name="營益率" stroke="#7dd3fc" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="netMargin"   name="淨利率" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Valuation summary (PE chart placeholder)
// ---------------------------------------------------------------------------
function ValuationCard({ data }: { data: FundamentalResult }) {
  const tpe = data.trailingPE;
  const fpe = data.forwardPE;
  if (!tpe && !fpe) return null;

  const items = [
    tpe != null ? { label: "Trailing PE", value: `${tpe.toFixed(1)}x` } : null,
    fpe != null ? { label: "Forward PE",  value: `${fpe.toFixed(1)}x` } : null,
    data.pegRatio != null ? { label: "PEG Ratio", value: `${data.pegRatio.toFixed(2)}` } : null,
    data.grossMargins != null ? { label: "毛利率", value: `${(data.grossMargins * 100).toFixed(1)}%` } : null,
    data.operatingMargins != null ? { label: "營益率", value: `${(data.operatingMargins * 100).toFixed(1)}%` } : null,
    data.profitMargins != null ? { label: "淨利率", value: `${(data.profitMargins * 100).toFixed(1)}%` } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <Card className="border border-white/[0.08] rounded-[22px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.96), rgba(7,12,20,.96))" }}>
      <CardContent className="p-[18px]">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-3">估值與利潤率摘要</h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {items.map((item) => (
            <div key={item.label} className="flex justify-between items-center border-b border-white/[0.05] pb-2">
              <span className="text-[12px] text-[#8ea1b6]">{item.label}</span>
              <span className="text-[14px] font-semibold text-[#e6eef8] tabular-nums">{item.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------
function SummaryTable({ rows }: { rows: SummaryRow[] }) {
  return (
    <Card className="border border-white/[0.08] rounded-[22px] mt-4" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.96), rgba(7,12,20,.96))" }}>
      <CardContent className="p-[18px]">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-3">核心判讀摘要</h3>
        <div className="grid grid-cols-[120px_auto_1fr] gap-x-3.5 gap-y-2.5 text-[14px] items-center">
          {rows.map((row, i) => (
            <>
              <div key={`dim-${i}`} className="text-[#8ea1b6]">{row.dimension}</div>
              <div key={`badge-${i}`}><RatingBadge rating={row.rating} /></div>
              <div key={`comment-${i}`} className="text-[#d7e3f1]">{row.commentary}</div>
            </>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Financial events timeline
// ---------------------------------------------------------------------------
function EventsTimeline({ events }: { events: FinancialEvent[] }) {
  if (events.length === 0) return null;

  function daysLabel(days: number): string {
    if (days === 0) return "今日";
    if (days < 0) return `T${days}`;
    return `T+${days}`;
  }

  const typeLabel: Record<string, string> = {
    earnings:      "財報發布日 Earnings",
    dividend:      "除息日 Dividend",
    fiscalYearEnd: "會計年度結束",
  };

  return (
    <Card className="border border-white/[0.08] rounded-[22px] mt-4" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.96), rgba(7,12,20,.96))" }}>
      <CardContent className="p-[18px]">
        <h3 className="text-[16px] font-bold text-[#e6eef8] mb-1">重要財務日</h3>
        <p className="text-[12px] text-[#8ea1b6] mb-3">未來 90 天</p>
        <div className="space-y-2">
          {events.slice(0, 5).map((ev, i) => (
            <div key={i} className="grid grid-cols-[110px_1fr_76px] gap-3 items-center px-3 py-2.5 border border-white/[0.06] rounded-[14px] bg-white/[0.03]">
              <div className="text-[14px] font-bold text-[#dce7f5]">{ev.date}</div>
              <div className="text-[13px] text-[#8ea1b6]">{typeLabel[ev.type] ?? ev.label}</div>
              <div className="text-right text-[13px] font-bold" style={{ color: ev.daysFromNow <= 7 ? "#f5b4b4" : "#8ea1b6" }}>
                {daysLabel(ev.daysFromNow)}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------
function FundamentalSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-5 w-80" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[420px] rounded-[22px]" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-[22px]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function FundamentalAnalysis() {
  const { activeSymbol, activeMarket } = useActiveSymbol();
  const qc = useQueryClient();

  // Don't show fundamentals for excluded ETF/bond symbols
  const isExcluded = EXCLUDED_FUNDAMENTAL_SYMBOLS.has(activeSymbol);

  const { data, isLoading: _isLoading, isError, error } = useQuery<FundamentalResult>({
    queryKey: ["/api/fundamentals", activeSymbol, activeMarket],
    queryFn: () =>
      apiRequest("GET", `/api/fundamentals/${activeSymbol}?market=${activeMarket}`)
        .then((r) => r.json()),
    enabled: !!activeSymbol && !isExcluded,
    staleTime: 6 * 60 * 60_000,     // 6h client-side stale (server TTL is 7 days)
    placeholderData: (prev) => prev,
  });

  const isLoading = data === undefined && !isExcluded;

  const resyncMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/fundamentals/${activeSymbol}/resync?market=${activeMarket}`)
        .then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/fundamentals", activeSymbol, activeMarket] });
    },
  });

  // Excluded symbol message
  if (isExcluded) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <p className="text-[16px] text-[#8ea1b6]">
            {activeSymbol} 為 ETF / 債券型基金，不提供基本面分析。
          </p>
          <p className="text-[13px] text-[#8ea1b6]/60">請從右側選擇個股。</p>
        </div>
      </div>
    );
  }

  if (isLoading) return <FundamentalSkeleton />;

  if (isError || !data) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <p className="text-[16px] text-[#8ea1b6]">
            無法載入 {activeSymbol} 基本面資料
          </p>
          <p className="text-[12px] text-[#8ea1b6]/60">{String(error ?? "未知錯誤")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => resyncMutation.mutate()}
            disabled={resyncMutation.isPending}
            className="gap-2"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", resyncMutation.isPending && "animate-spin")} />
            重新抓取
          </Button>
        </div>
      </div>
    );
  }

  const fetchAge = Math.round((Date.now() - data.fetchedAt) / 3600000);
  const fetchLabel = fetchAge < 1 ? "剛更新" : fetchAge < 24 ? `${fetchAge}h 前` : `${Math.round(fetchAge / 24)}d 前`;

  return (
    <div className="p-5 pb-12 max-w-[1200px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[36px] sm:text-[42px] font-black tracking-tight text-[#e6eef8] leading-tight">
            {activeSymbol} · {data.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[#8ea1b6] text-[14px]">
            <span>市場：{activeMarket === "TW" ? "台股" : "美股"}</span>
            <span>·</span>
            <span>{data.industry || data.sector || "—"}</span>
            {data.isStale && (
              <span className="text-[12px] text-amber-400/70">資料較舊（{fetchLabel}）</span>
            )}
            {!data.isStale && (
              <span className="text-[12px] text-[#8ea1b6]/50">{fetchLabel}</span>
            )}
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border text-[#dbe7f5]"
              style={{ background: "rgba(255,255,255,.03)", borderColor: "rgba(255,255,255,.08)" }}
            >
              評級色系：台股規則
            </span>
          </div>
        </div>

        {/* Mobile symbol selector + resync button */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <AnalysisSymbolSidebarMobile symbolFilter={(item) => !EXCLUDED_FUNDAMENTAL_SYMBOLS.has(item.symbol)} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => resyncMutation.mutate()}
            disabled={resyncMutation.isPending}
            className="gap-1.5 text-xs"
            title="強制重新抓取基本面資料"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", resyncMutation.isPending && "animate-spin")} />
            重新抓取
          </Button>
        </div>
      </div>

      {/* Rating legend */}
      <div className="mt-4">
        <RatingLegend />
      </div>

      {/* Three pillar cards */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {data.pillars.map((card) => (
          <PillarCardComponent key={card.pillar} card={card} />
        ))}
      </div>

      {/* Quarterly chart */}
      <QuarterlyChart bars={data.quarterlyBars} currency={data.currency} />

      {/* Summary table */}
      <SummaryTable rows={data.summaryRows} />

      {/* Two-column charts: margin trend + valuation */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MarginChart bars={data.quarterlyBars} currency={data.currency} />
        <ValuationCard data={data} />
      </div>

      {/* EPS chart */}
      <EpsChart eps={data.epsHistory} />

      {/* Financial events */}
      <EventsTimeline events={data.financialEvents} />
    </div>
  );
}
