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
// 極佳=深紅(rose), 良好=紅(red), 中性=白, 疲弱=淡綠(emerald), 差勁=深綠
const RATING_STYLE: Record<FundamentalRating, string> = {
  excellent: "text-[#ef4444] bg-[rgba(239,68,68,.14)] border border-[rgba(239,68,68,.22)]",
  good:      "text-[#fb7185] bg-[rgba(251,113,133,.15)] border border-[rgba(251,113,133,.24)]",
  neutral:   "text-[#f3f4f6] bg-[rgba(255,255,255,.09)] border border-[rgba(255,255,255,.14)]",
  weak:      "text-[#10b981] bg-[rgba(16,185,129,.14)] border border-[rgba(16,185,129,.22)]",
  poor:      "text-[#34d399] bg-[rgba(52,211,153,.14)] border border-[rgba(52,211,153,.24)]",
};

// Score number color (matches rating tiers: high=極佳 red, medium=neutral white, low=差勁 green)
const SCORE_COLOR: Record<string, string> = {
  high:    "text-[#ef4444]",  // 極佳: red
  medium:  "text-[#f3f4f6]",  // 中性: white
  low:     "text-[#34d399]",  // 差勁: deep green
};

function scoreColor(score: number): string {
  if (score >= 65) return SCORE_COLOR.high;
  if (score >= 40) return SCORE_COLOR.medium;
  return SCORE_COLOR.low;
}

// Return the text-color hex matching a rating (for numeric values in metric cards)
function ratingTextColor(rating: FundamentalRating): string {
  switch (rating) {
    case "excellent": return "#ef4444";
    case "good":      return "#fb7185";
    case "neutral":   return "#f3f4f6";
    case "weak":      return "#10b981";
    case "poor":      return "#34d399";
  }
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
// Metric mini-card (replaces MetricRow)
// ---------------------------------------------------------------------------
function MetricRow({ metric }: { metric: MetricItem }) {
  // Value color = rating color (not sign-based)
  const valColor = ratingTextColor(metric.rating);

  return (
    <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 space-y-1">
      {/* Top row: name left, badge right */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#8ea1b6] leading-none">{metric.name}</span>
        <RatingBadge rating={metric.rating} />
      </div>
      {/* Value — 50% smaller than old 20px → 10px = too small, use 13px for readability */}
      <div className="text-[13px] font-extrabold leading-none tabular-nums" style={{ color: valColor }}>
        {metric.value}
      </div>
      {/* Commentary */}
      <div className="text-[10px] text-[#7a90a8] leading-snug">
        {metric.commentary}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pillar card (compressed ~60%)
// ---------------------------------------------------------------------------
function PillarCardComponent({ card }: { card: PillarCard }) {
  return (
    <Card className="border border-white/[0.08] rounded-[18px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.98), rgba(7,12,20,.98))" }}>
      <CardContent className="p-[14px]">
        <div className="flex items-end justify-between mb-1.5">
          <h3 className="text-[15px] font-bold text-[#e6eef8]">{card.title}</h3>
          <span className={cn("text-[36px] font-black leading-none", scoreColor(card.score))}>
            {card.score}
          </span>
        </div>
        <p className="text-[12px] text-[#c8d6e7] leading-snug mb-0.5">
          {card.summary}
        </p>
        <div className="space-y-1.5 mt-2">
          {card.metrics.map((m, i) => (
            <MetricRow key={i} metric={m} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Investment strategy card (replaces rating legend)
// ---------------------------------------------------------------------------
function deriveStrategy(pillars: PillarCard[]): { title: string; description: string; badge: FundamentalRating } {
  const growth    = pillars.find(p => p.pillar === "growth")!;
  const quality   = pillars.find(p => p.pillar === "quality")!;
  const valuation = pillars.find(p => p.pillar === "valuation")!;
  const avg = Math.round((growth.score + quality.score + valuation.score) / 3);

  if (avg >= 78) {
    // High growth + high quality
    if (valuation.score >= 60)
      return { title: "積極持有 / 逢低加碼", description: "基本面全面優異，成長動能強且估值尚在合理區間。可積極持有，遇回檔視為加碼機會。", badge: "excellent" };
    else
      return { title: "持有 / 分批布局", description: "成長與財務體質俱佳，但估值已有溢價。建議持有現有部位，若估值收斂可考慮分批加碼。", badge: "good" };
  }
  if (avg >= 60) {
    if (valuation.score >= 65)
      return { title: "分批建倉", description: "基本面穩健，估值具合理安全邊際。可考慮分批建立部位，搭配財報節奏進場。", badge: "good" };
    else
      return { title: "觀望 / 小量持有", description: "基本面良好但估值偏高，進場CP值不足。建議小量持有或等待回調至合理估值再加碼。", badge: "neutral" };
  }
  if (avg >= 42) {
    return { title: "中性觀望", description: "各面向表現普通，尚無明確催化劑。建議觀望為主，等待財報或共識上修訊號再行動。", badge: "neutral" };
  }
  if (avg >= 28) {
    return { title: "減碼 / 謹慎", description: "基本面出現疲態，成長放緩或財務體質轉弱。建議降低部位比重，密切追蹤後續財報。", badge: "weak" };
  }
  return { title: "回避 / 出場", description: "多項指標亮燈，基本面明顯惡化。除非有特殊事件驅動，否則建議回避或評估出場。", badge: "poor" };
}

function StrategyCard({ pillars }: { pillars: PillarCard[] }) {
  const { title, description, badge } = deriveStrategy(pillars);
  return (
    <Card className="border border-white/[0.08] rounded-[18px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.9), rgba(8,14,22,.94))" }}>
      <CardContent className="p-4">
        <h3 className="text-[13px] font-semibold text-[#8ea1b6] uppercase tracking-wider mb-2">綜合投資策略</h3>
        <div className="flex items-center gap-2.5 mb-2.5">
          <RatingBadge rating={badge} />
          <span className="text-[16px] font-bold text-[#e6eef8]">{title}</span>
        </div>
        <p className="text-[13px] text-[#b8cde0] leading-relaxed">{description}</p>
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
// Financial events timeline (compact card, no outer mt)
// ---------------------------------------------------------------------------
function EventsTimeline({ events }: { events: FinancialEvent[] }) {
  function daysLabel(days: number): string {
    if (days === 0) return "今日";
    if (days < 0) return `T${days}`;
    return `T+${days}`;
  }

  const typeLabel: Record<string, string> = {
    earnings:      "財報日",
    dividend:      "除息日",
    fiscalYearEnd: "年度結束",
  };

  return (
    <Card className="border border-white/[0.08] rounded-[18px] h-full" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.9), rgba(8,14,22,.94))" }}>
      <CardContent className="p-4">
        <h3 className="text-[13px] font-semibold text-[#8ea1b6] uppercase tracking-wider mb-2">重要財務日</h3>
        {events.length === 0 ? (
          <p className="text-[13px] text-[#8ea1b6]/50 py-2">近期無重要財務事件</p>
        ) : (
          <div className="space-y-1.5">
            {events.slice(0, 4).map((ev, i) => (
              <div key={i} className="grid grid-cols-[90px_1fr_52px] gap-2 items-center px-2.5 py-2 border border-white/[0.06] rounded-[10px] bg-white/[0.02]">
                <div className="text-[12px] font-bold text-[#dce7f5]">{ev.date}</div>
                <div className="text-[12px] text-[#8ea1b6]">{typeLabel[ev.type] ?? ev.label}</div>
                <div className="text-right text-[12px] font-bold" style={{ color: ev.daysFromNow <= 7 ? "#fb7185" : "#8ea1b6" }}>
                  {daysLabel(ev.daysFromNow)}
                </div>
              </div>
            ))}
          </div>
        )}
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
        .then((r) => r.json())
        .then((json) => {
          if (json && json.error) throw new Error(json.error);
          return json as FundamentalResult;
        }),
    enabled: !!activeSymbol && !isExcluded,
    staleTime: 6 * 60 * 60_000,     // 6h client-side stale (server TTL is 7 days)
    placeholderData: (prev) => prev,
    retry: 1,
  });

  // isLoading: only show skeleton while genuinely fetching (not on error)
  const isLoading = data === undefined && !isExcluded && !isError;

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
      {/* Header — mirrors TechnicalAnalysis layout */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* Company name as primary title */}
          <h1 className="text-2xl font-bold leading-tight">
            {data.name || activeSymbol}
          </h1>
          {/* Symbol · market · industry · age */}
          <div className="flex items-center gap-2 mt-1.5 text-sm text-muted-foreground flex-wrap">
            <span>{activeSymbol}</span>
            <span>·</span>
            <span>{activeMarket === "TW" ? "台灣證交所" : "NYSE / NASDAQ"}</span>
            {(data.industry || data.sector) && (
              <>
                <span>·</span>
                <span>{data.industry || data.sector}</span>
              </>
            )}
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border"
              style={{ background: "rgba(255,255,255,.03)", borderColor: "rgba(255,255,255,.08)", color: "hsl(var(--muted-foreground))" }}
            >
              基本面分析
            </span>
            {data.isStale && (
              <span className="text-[11px] text-amber-400/70">資料較舊（{fetchLabel}）</span>
            )}
            {!data.isStale && (
              <span className="text-[11px] text-muted-foreground/50">{fetchLabel}</span>
            )}
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

      {/* Strategy card + Financial events (50/50) */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StrategyCard pillars={data.pillars} />
        <EventsTimeline events={data.financialEvents} />
      </div>

      {/* Three pillar cards */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
        {data.pillars.map((card) => (
          <PillarCardComponent key={card.pillar} card={card} />
        ))}
      </div>

      {/* Quarterly chart */}
      <QuarterlyChart bars={data.quarterlyBars} currency={data.currency} />

      {/* Two-column charts: margin trend + valuation */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MarginChart bars={data.quarterlyBars} currency={data.currency} />
        <ValuationCard data={data} />
      </div>

      {/* EPS chart */}
      <EpsChart eps={data.epsHistory} />
    </div>
  );
}
