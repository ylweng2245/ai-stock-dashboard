/**
 * FundamentalAnalysis.tsx — V6.0 基本面分析頁
 *
 * UI 依照 v6-fundamentals-lly-mockup-v4.html 設計。
 * - 個股切換：右側既有 AnalysisSymbolSidebar（透過 StockAnalysisLayout）
 * - 評級色系：台股規則（極佳=紅最強, 良好=紅, 中性=白, 疲弱=綠, 差勁=綠最強）
 * - 資料來源：GET /api/fundamentals/:symbol?market=
 */

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ComposedChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Line, ReferenceLine, CartesianGrid,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";
import { STOCK_META } from "@/lib/stockData";
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
// Quarterly chart helpers
// ---------------------------------------------------------------------------

/** Format revenue number to compact display (百萬/億/兆) */
function fmtRev(n: number, currency: string): string {
  if (currency === "TWD") {
    if (Math.abs(n) >= 1e12) return `NT${(n/1e12).toFixed(1)}T`;
    if (Math.abs(n) >= 1e8)  return `NT${(n/1e8).toFixed(0)}億`;
    if (Math.abs(n) >= 1e6)  return `NT${(n/1e6).toFixed(0)}M`;
    return `NT${n.toLocaleString()}`;
  }
  if (Math.abs(n) >= 1e12) return `$${(n/1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9)  return `$${(n/1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6)  return `$${(n/1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

/** Sort quarter label e.g. "2025Q3" ascending (oldest → newest) */
function sortQuartersAsc(bars: QuarterlyBar[]): QuarterlyBar[] {
  return [...bars].sort((a, b) => a.quarter.localeCompare(b.quarter));
}

/** Build chart data with YoY and QoQ computed from quarterlyBars */
function buildRevenueRows(bars: QuarterlyBar[]) {
  // Sort oldest→newest — use ALL bars for YoY lookup, then slice last 8 to display
  const all = sortQuartersAsc(bars);
  const display = all.slice(-8);
  return display.map((b) => {
    const allIdx = all.indexOf(b);
    const prev = all[allIdx - 1];   // previous quarter (QoQ)
    const yoy  = all[allIdx - 4];   // same quarter last year (YoY)
    const qoq = prev && prev.revenue > 0
      ? +((b.revenue - prev.revenue) / prev.revenue * 100).toFixed(2)
      : null;
    const yoyPct = yoy && yoy.revenue > 0
      ? +((b.revenue - yoy.revenue) / yoy.revenue * 100).toFixed(2)
      : null;
    return { quarter: b.quarter, revenue: b.revenue, qoq, yoy: yoyPct };
  });
}

/** Build profit chart data: EPS bar + gross margin % + net margin % lines */
function buildProfitRows(bars: QuarterlyBar[], eps: EpsPoint[]) {
  const arr = sortQuartersAsc(bars).slice(-8);
  // Build EPS map by quarter label
  const epsMap = new Map(eps.map(e => [e.quarter, e.actual]));
  return arr.map((b) => {
    const grossMarginPct = b.revenue > 0 ? +((b.grossProfit / b.revenue) * 100).toFixed(2) : null;
    const netMarginPct   = b.revenue > 0 ? +((b.netIncome   / b.revenue) * 100).toFixed(2) : null;
    const epsVal = epsMap.get(b.quarter) ?? null;
    return {
      quarter: b.quarter,
      eps: epsVal,
      grossMargin: grossMarginPct,
      netMargin: netMarginPct,
    };
  });
}

/** Pct color: positive = gain red, negative = loss green */
function pctColor(v: number | null): string {
  if (v === null) return "text-muted-foreground";
  if (v > 0)  return "text-[#ef4444]";
  if (v < 0)  return "text-[#10b981]";
  return "text-muted-foreground";
}
function pctStr(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "" : ""}${v.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Revenue card (left)
// ---------------------------------------------------------------------------
function RevenueCard({ bars, currency }: { bars: QuarterlyBar[]; currency: string }) {
  if (bars.length === 0) return null;
  const rows = buildRevenueRows(bars);
  // Table: newest at top, oldest at bottom
  const tableRows = [...rows].reverse();

  // Axis domains
  const pctVals = rows.flatMap(r => [r.qoq, r.yoy]).filter(v => v !== null) as number[];
  const pctMin = pctVals.length ? Math.floor(Math.min(...pctVals) / 10) * 10 - 10 : -50;
  const pctMax = pctVals.length ? Math.ceil(Math.max(...pctVals) / 10) * 10 + 10 : 150;

  const barColor = "rgba(28,184,190,0.75)";

  return (
    <Card className="border border-white/[0.08] rounded-[18px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.98), rgba(7,12,20,.98))" }}>
      <CardContent className="p-4">
        {/* Title row */}
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-[14px] font-bold text-[#e6eef8]">季度營收</h3>
          <span className="text-[11px] text-[#8ea1b6]">{currency === "TWD" ? "*幣別：台幣" : "*幣別：美元"}</span>
        </div>
        {/* Chart */}
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
              <XAxis dataKey="quarter" tick={{ fill: "#8ea1b6", fontSize: 10 }} axisLine={false} tickLine={false} interval={0} angle={-30} textAnchor="end" height={36} />
              <YAxis
                yAxisId="rev"
                orientation="left"
                tickFormatter={(v) => fmtRev(v, currency)}
                tick={{ fill: "#8ea1b6", fontSize: 10 }}
                axisLine={false} tickLine={false} width={54}
              />
              <YAxis
                yAxisId="pct"
                orientation="right"
                domain={[pctMin, pctMax]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: "#8ea1b6", fontSize: 10 }}
                axisLine={false} tickLine={false} width={38}
              />
              <Tooltip
                contentStyle={{ background: "#0b1420", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#e6eef8", fontSize: 11 }}
                formatter={(val: any, name: string) => {
                  if (name === "營收") return [fmtRev(val, currency), name];
                  return [val !== null ? `${val > 0 ? "" : ""}${(+val).toFixed(2)}%` : "—", name];
                }}
              />
              <ReferenceLine yAxisId="pct" y={0} stroke="rgba(255,255,255,.15)" strokeDasharray="3 3" />
              <Bar yAxisId="rev" dataKey="revenue" name="營收" fill={barColor} radius={[3,3,0,0]} maxBarSize={28} />
              <Line yAxisId="pct" type="monotone" dataKey="qoq" name="QoQ(%)" stroke="#7dd3fc" strokeWidth={1.5} dot={{ r: 2.5, fill: "#7dd3fc" }} connectNulls />
              <Line yAxisId="pct" type="monotone" dataKey="yoy" name="YoY(%)" stroke="#fb7185" strokeWidth={1.5} dot={{ r: 2.5, fill: "#fb7185" }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-4 mt-1 mb-3 px-1">
          <span className="flex items-center gap-1.5 text-[10px] text-[#8ea1b6]">
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(28,184,190,0.75)", display: "inline-block" }} />
            營收
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-[#8ea1b6]">
            <span style={{ width: 16, height: 2, background: "#7dd3fc", display: "inline-block" }} />
            QoQ(%)
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-[#8ea1b6]">
            <span style={{ width: 16, height: 2, background: "#fb7185", display: "inline-block" }} />
            YoY(%)
          </span>
        </div>
        {/* Table */}
        <table className="w-full text-[12.5px] border-collapse">
          <thead>
            <tr className="border-b border-white/[0.1]">
              <th className="text-left text-[#8ea1b6] font-normal pb-2 pr-2">年/季</th>
              <th className="text-right text-[#8ea1b6] font-normal pb-2 pr-2">營收</th>
              <th className="text-right text-[#8ea1b6] font-normal pb-2 pr-2">QoQ</th>
              <th className="text-right text-[#8ea1b6] font-normal pb-2">YoY</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((r, i) => (
              <tr key={i} className="border-b border-white/[0.05]">
                <td className="py-2 pr-2 text-white font-normal tabular-nums">{r.quarter}</td>
                <td className="py-2 pr-2 text-right tabular-nums text-white">{fmtRev(r.revenue, currency)}</td>
                <td className={cn("py-2 pr-2 text-right tabular-nums font-normal", pctColor(r.qoq))}>{pctStr(r.qoq)}</td>
                <td className={cn("py-2 text-right tabular-nums font-normal", pctColor(r.yoy))}>{pctStr(r.yoy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Profit card (right)
// ---------------------------------------------------------------------------
function ProfitCard({ bars, eps, currency }: { bars: QuarterlyBar[]; eps: EpsPoint[]; currency: string }) {
  if (bars.length === 0) return null;
  const rows = buildProfitRows(bars, eps);
  // Table: newest at top, oldest at bottom
  const tableRows = [...rows].reverse();

  const pctVals = rows.flatMap(r => [r.grossMargin, r.netMargin]).filter(v => v !== null) as number[];
  const pctMin = pctVals.length ? Math.floor(Math.min(...pctVals) / 10) * 10 - 5 : -20;
  const pctMax = pctVals.length ? Math.ceil(Math.max(...pctVals) / 10) * 10 + 5 : 80;

  // EPS bar color: positive=teal, negative=green
  const epsBarColor = (val: number | null) => val !== null && val < 0 ? "#10b981" : "#1cb8be";

  return (
    <Card className="border border-white/[0.08] rounded-[18px]" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.98), rgba(7,12,20,.98))" }}>
      <CardContent className="p-4">
        {/* Title row */}
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-[14px] font-bold text-[#e6eef8]">季度獲利</h3>
          <span className="text-[11px] text-[#8ea1b6]">{currency === "TWD" ? "*幣別：台幣" : "*幣別：美元"}</span>
        </div>
        {/* Chart */}
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" />
              <XAxis dataKey="quarter" tick={{ fill: "#8ea1b6", fontSize: 10 }} axisLine={false} tickLine={false} interval={0} angle={-30} textAnchor="end" height={36} />
              <YAxis
                yAxisId="eps"
                orientation="left"
                tick={{ fill: "#8ea1b6", fontSize: 10 }}
                axisLine={false} tickLine={false} width={36}
                label={{ value: "EPS", angle: -90, position: "insideLeft", fill: "#8ea1b6", fontSize: 9, dy: 20 }}
              />
              <YAxis
                yAxisId="pct"
                orientation="right"
                domain={[pctMin, pctMax]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: "#8ea1b6", fontSize: 10 }}
                axisLine={false} tickLine={false} width={40}
              />
              <Tooltip
                contentStyle={{ background: "#0b1420", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#e6eef8", fontSize: 11 }}
                formatter={(val: any, name: string) => {
                  if (name === "EPS") return [val !== null ? (+val).toFixed(2) : "—", name];
                  return [val !== null ? `${(+val).toFixed(2)}%` : "—", name];
                }}
              />
              <ReferenceLine yAxisId="eps" y={0} stroke="rgba(255,255,255,.15)" strokeDasharray="3 3" />
              <ReferenceLine yAxisId="pct" y={0} stroke="rgba(255,255,255,.08)" />
              <Bar yAxisId="eps" dataKey="eps" name="EPS" maxBarSize={28} radius={[3,3,0,0]}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={epsBarColor(r.eps)} fillOpacity={0.75} />
                ))}
              </Bar>
              <Line yAxisId="pct" type="monotone" dataKey="grossMargin" name="毛利率(%)" stroke="#fb7185" strokeWidth={1.5} dot={{ r: 2.5, fill: "#fb7185" }} connectNulls />
              <Line yAxisId="pct" type="monotone" dataKey="netMargin" name="淨利率(%)" stroke="#a78bfa" strokeWidth={1.5} dot={{ r: 2.5, fill: "#a78bfa" }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-4 mt-1 mb-3 px-1">
          <span className="flex items-center gap-1.5 text-[10px] text-[#8ea1b6]">
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#1cb8be", opacity: 0.75, display: "inline-block" }} />
            EPS
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-[#8ea1b6]">
            <span style={{ width: 16, height: 2, background: "#fb7185", display: "inline-block" }} />
            毛利率(%)
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-[#8ea1b6]">
            <span style={{ width: 16, height: 2, background: "#a78bfa", display: "inline-block" }} />
            淨利率(%)
          </span>
        </div>
        {/* Table */}
        <table className="w-full text-[12.5px] border-collapse">
          <thead>
            <tr className="border-b border-white/[0.1]">
              <th className="text-left text-[#8ea1b6] font-normal pb-2 pr-2">年/季</th>
              <th className="text-right text-[#8ea1b6] font-normal pb-2 pr-2">毛利率</th>
              <th className="text-right text-[#8ea1b6] font-normal pb-2 pr-2">淨利率</th>
              <th className="text-right text-[#8ea1b6] font-normal pb-2">EPS</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((r, i) => (
              <tr key={i} className="border-b border-white/[0.05]">
                <td className="py-2 pr-2 text-white font-normal tabular-nums">{r.quarter}</td>
                <td className="py-2 pr-2 text-right tabular-nums text-white">{r.grossMargin !== null ? `${r.grossMargin.toFixed(2)}%` : "—"}</td>
                <td className={cn("py-2 pr-2 text-right tabular-nums font-normal", r.netMargin !== null ? (r.netMargin >= 0 ? "text-[#ef4444]" : "text-[#10b981]") : "text-muted-foreground")}>
                  {r.netMargin !== null ? `${r.netMargin.toFixed(2)}%` : "—"}
                </td>
                <td className={cn("py-2 text-right tabular-nums font-normal", r.eps !== null ? (r.eps >= 0 ? "text-[#ef4444]" : "text-[#10b981]") : "text-muted-foreground")}>
                  {r.eps !== null ? r.eps.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ETF / Bond exclusion list (shared with sidebar filter in App.tsx)
// ---------------------------------------------------------------------------
export const EXCLUDED_FUNDAMENTAL_SYMBOLS = new Set([
  "0050", "00891", "00881", "00981A", "00830", "00662", "00719B",
]);

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
// Financial events timeline (compact card, no outer mt)
// ---------------------------------------------------------------------------
function EventsTimeline({ events }: { events: FinancialEvent[] }) {
  function daysLabel(days: number): string {
    if (days === 0) return "今日";
    if (days < 0) return `T${days}`;
    return `T+${days}`;
  }

  function fmtRevenue(v: number | null | undefined): string {
    if (v == null) return "";
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    return `$${v.toLocaleString()}`;
  }

  const HOUR_BADGE: Record<string, { label: string; color: string }> = {
    bmo: { label: "盤前",  color: "rgba(251,191,36,.18)" },
    amc: { label: "盤後",  color: "rgba(99,179,237,.18)" },
    dmh: { label: "盤中",  color: "rgba(167,139,250,.18)" },
  };

  return (
    <Card className="border border-white/[0.08] rounded-[18px] h-full" style={{ background: "linear-gradient(180deg, rgba(11,20,32,.9), rgba(8,14,22,.94))" }}>
      <CardContent className="p-4">
        <h3 className="text-[13px] font-semibold text-[#8ea1b6] uppercase tracking-wider mb-2">重要財務日</h3>
        {events.length === 0 ? (
          <p className="text-[13px] text-[#8ea1b6]/50 py-2">近期無重要財務事件</p>
        ) : (
          <div className="space-y-1.5">
            {events.slice(0, 5).map((ev, i) => {
              const hourBadge = ev.hour ? HOUR_BADGE[ev.hour] : null;
              const isUrgent = ev.daysFromNow >= 0 && ev.daysFromNow <= 14;
              return (
                <div key={i} className="px-2.5 py-2 border border-white/[0.06] rounded-[10px] bg-white/[0.02] space-y-1">
                  {/* Row 1: date | label + badge | T+N */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-bold tabular-nums" style={{ color: isUrgent ? "#fb7185" : "#dce7f5", minWidth: 88 }}>
                      {ev.date}
                    </span>
                    <span className="flex-1 text-[12px] text-[#8ea1b6] truncate">{ev.label}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {hourBadge && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ background: hourBadge.color, color: "#e6eef8" }}
                        >
                          {hourBadge.label}
                        </span>
                      )}
                      <span className="text-[12px] font-bold" style={{ color: isUrgent ? "#fb7185" : "#8ea1b6" }}>
                        {daysLabel(ev.daysFromNow)}
                      </span>
                    </div>
                  </div>
                  {/* Row 2: EPS + Revenue estimates (earnings only) */}
                  {ev.type === "earnings" && (ev.epsEstimate != null || ev.revenueEstimate != null) && (
                    <div className="flex gap-3 text-[10.5px] text-[#7a90a8]">
                      {ev.epsEstimate != null && (
                        <span>EPS 預估 <span className="text-[#b8cde0] font-semibold">${ev.epsEstimate.toFixed(2)}</span></span>
                      )}
                      {ev.revenueEstimate != null && (
                        <span>營收預估 <span className="text-[#b8cde0] font-semibold">{fmtRevenue(ev.revenueEstimate)}</span></span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
  const [resyncing, setResyncing] = useState(false);

  const handleResync = async () => {
    if (resyncing) return;
    setResyncing(true);
    try {
      await apiRequest("POST", `/api/fundamentals/${activeSymbol}/resync?market=${activeMarket}`);
      // Invalidate query so UI re-fetches fresh data
      await qc.invalidateQueries({ queryKey: ["/api/fundamentals", activeSymbol, activeMarket] });
    } catch (e) {
      console.error("Resync failed:", e);
    } finally {
      setResyncing(false);
    }
  };

  // Watchlist meta — use user-entered name (same pattern as TechnicalAnalysis)
  const { data: watchlist } = useQuery<{ id: number; symbol: string; name: string; market: "TW" | "US"; sortOrder: number }[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const meta = useMemo(() => {
    const wItem = watchlist?.find((w) => w.symbol === activeSymbol);
    if (wItem) return { name: wItem.name };
    return STOCK_META[activeSymbol] ? { name: STOCK_META[activeSymbol].name } : { name: activeSymbol };
  }, [watchlist, activeSymbol]);

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
          {/* Company name — use watchlist user-entered name, same as TechnicalAnalysis */}
          <h1 className="text-2xl font-bold leading-tight">
            {meta.name}
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
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleResync}
            disabled={resyncing}
            title="重新整理基本資訊"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", resyncing && "animate-spin")} />
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

      {/* Revenue + Profit cards (50/50) */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RevenueCard bars={data.quarterlyBars} currency={data.currency} />
        <ProfitCard bars={data.quarterlyBars} eps={data.epsHistory} currency={data.currency} />
      </div>
    </div>
  );
}
