import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Brain, TrendingUp, TrendingDown, RefreshCw, Target,
  History, ChevronRight, Zap, BarChart2, AlertTriangle, User,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Legend,
} from "recharts";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PricePt { date: string; price: number; }

interface PredictionResult {
  ok: boolean;
  error?: string;
  runAt: string;
  horizonDays: number;
  startDate: string;
  endDate: string;
  medianPath: PricePt[];
  upperPath: PricePt[];
  lowerPath: PricePt[];
  p25Path?: PricePt[];
  p75Path?: PricePt[];
  modelName?: string;
  upProbability?: number;
  bullProb?: number;
  baseProb?: number;
  bearProb?: number;
  confidenceScore?: number;
  expectedReturnPct?: number;
  rangeReturnLow?: number;
  rangeReturnHigh?: number;
  topFeatures?: { feature: string; label: string; importance: number }[];
  meta?: { trainSamples?: number; trainWindowYears?: number; featureVersion?: string; useAnalyst?: boolean };
}

interface HorizonSummary {
  horizonDays: number;
  expectedReturnPct: number | null;
  downsideRiskPct: number | null;
  upsidePotentialPct: number | null;
  upProbability?: number | null;
}

interface PositionState {
  shares: number;
  avgCost: number;
  currentPrice: number | null;
  positionValue: number | null;
  unrealizedPct: number | null;
  avgHoldingDays: number | null;
}

interface PersonalAdvice {
  primaryAction: "hold" | "add_on_dip" | "take_profit_partial" | "cut_loss" | "avoid_new_entry";
  reasons: string[];
  positionState?: PositionState | null;
  horizonPredictions?: HorizonSummary[];
  analystFeatures?: { hasConsensus: boolean; upsideAvgRatio?: number | null; avgScore?: number | null; bullishRatio?: number | null };
}

interface PredictionHistoryItem {
  runAt: string;
  horizonDays: number;
  startDate: string;
  endDate: string;
  medianPath: PricePt[];
  upperPath: PricePt[];
  lowerPath: PricePt[];
  modelName?: string;
  accuracy?: { mae: number; mape: number; directionCorrect: boolean };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HORIZONS = [
  { days: 5,  label: "5日",  sub: "短線" },
  { days: 20, label: "20日", sub: "主決策" },
  { days: 60, label: "60日", sub: "中線" },
] as const;

const ACTION_CONFIG: Record<PersonalAdvice["primaryAction"], { label: string; color: string }> = {
  hold:                { label: "持有觀望",     color: "text-muted-foreground border-muted" },
  add_on_dip:          { label: "逢低加碼",     color: "text-[#1cb8be] border-[#1cb8be]/40" },
  take_profit_partial: { label: "部分獲利了結", color: "text-[#ef4444] border-[#ef4444]/40" },
  cut_loss:            { label: "停損出場",     color: "text-[#10b981] border-[#10b981]/40" },
  avoid_new_entry:     { label: "避免新進場",   color: "text-amber-400 border-amber-400/40" },
};

const HISTORY_COLORS = ["#66c6df", "#f59e0b", "#a78bfa", "#fb923c", "#34d399"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number, forceSign = true) {
  const s = forceSign && v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}
function fmtPrice(v: number | null | undefined) {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function computeReturn(path: PricePt[]) {
  if (path.length < 2) return 0;
  return ((path[path.length - 1].price - path[0].price) / path[0].price) * 100;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function nDaysAgoStr(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10);
}
function probLabel(p: number): string {
  if (p >= 0.65) return "偏多";
  if (p >= 0.55) return "中性偏多";
  if (p >= 0.45) return "中性";
  if (p >= 0.35) return "中性偏空";
  return "偏空";
}
function probColor(p: number): string {
  if (p >= 0.6) return "text-[#ef4444]";
  if (p >= 0.5) return "text-[#ef4444]/70";
  if (p >= 0.4) return "text-muted-foreground";
  return "text-[#10b981]";
}

// ─── KPI Cards (top 4) ───────────────────────────────────────────────────────

function KpiCards({ results }: { results: Record<number, PredictionResult> }) {
  const r5  = results[5];
  const r20 = results[20];
  const r60 = results[60];

  const up5  = r5?.upProbability;
  const up20 = r20?.upProbability;
  const exp60 = r60?.expectedReturnPct;
  // volatility proxy: avg of std from 5D & 20D upper-lower spread
  const vol5  = r5  ? computeReturn(r5.upperPath)  - computeReturn(r5.lowerPath)  : null;
  const vol20 = r20 ? computeReturn(r20.upperPath) - computeReturn(r20.lowerPath) : null;
  const volAvg = vol5 != null && vol20 != null ? (vol5 + vol20) / 2 : null;
  const volLabel = volAvg == null ? "—" : volAvg > 15 ? "高波動" : volAvg > 8 ? "中波動" : "低波動";
  const volColor = volAvg == null ? "" : volAvg > 15 ? "text-[#ef4444]" : volAvg > 8 ? "text-amber-400" : "text-[#10b981]";

  const cards = [
    {
      title: "5日上漲機率",
      value: up5 != null ? `${(up5 * 100).toFixed(0)}%` : "—",
      note: up5 != null ? probLabel(up5) : "尚未執行",
      valueColor: up5 != null ? probColor(up5) : "text-muted-foreground",
    },
    {
      title: "20日上漲機率",
      value: up20 != null ? `${(up20 * 100).toFixed(0)}%` : "—",
      note: up20 != null ? probLabel(up20) : "尚未執行",
      valueColor: up20 != null ? probColor(up20) : "text-muted-foreground",
    },
    {
      title: "60日預期報酬",
      value: exp60 != null ? fmtPct(exp60) : "—",
      note: exp60 != null ? (exp60 >= 0 ? "中線看多" : "中線看空") : "尚未執行",
      valueColor: exp60 != null ? (exp60 >= 0 ? "text-[#ef4444]" : "text-[#10b981]") : "text-muted-foreground",
    },
    {
      title: "預估波動級別",
      value: volLabel,
      note: volAvg != null ? `信賴區間寬 ${volAvg.toFixed(1)}%` : "尚未執行",
      valueColor: volColor,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Card key={c.title} className="border-border">
          <CardContent className="p-4">
            <p className="text-[11px] text-muted-foreground mb-1">{c.title}</p>
            <p className={cn("text-2xl font-extrabold leading-none mb-1 tabular-nums", c.valueColor)}>{c.value}</p>
            <p className="text-[11px] text-muted-foreground">{c.note}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Hero summary card ────────────────────────────────────────────────────────

function HeroSummary({ advice, result20 }: { advice: PersonalAdvice | undefined; result20: PredictionResult | undefined }) {
  if (!advice && !result20) return null;
  const cfg = advice ? ACTION_CONFIG[advice.primaryAction] : null;
  const conf = result20?.confidenceScore;
  const up20 = result20?.upProbability;

  // Derive sentiment text
  const sentimentTitle = up20 == null ? "等待預測資料"
    : up20 >= 0.65 ? "模型偏多，多頭優勢明顯"
    : up20 >= 0.55 ? "中線偏多，短線仍需確認"
    : up20 >= 0.45 ? "多空拉鋸，方向未明"
    : up20 >= 0.35 ? "短線偏空，中線待觀察"
    : "模型偏空，風險控制優先";

  const sentimentDesc = up20 == null ? "請先執行各維度預測，待資料回填後自動更新。"
    : `20日上漲機率 ${up20 != null ? (up20 * 100).toFixed(0) : "—"}%，` +
      (result20?.expectedReturnPct != null ? `預期報酬 ${fmtPct(result20.expectedReturnPct)}。` : "") +
      (conf != null ? ` 模型信心分數 ${conf}/100。` : "");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 rounded-2xl border border-border bg-gradient-to-br from-[#1cb8be]/8 to-[#a78bfa]/6 p-5">
      {/* Left: sentiment */}
      <div>
        <h2 className="text-lg font-bold mb-2">{sentimentTitle}</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">{sentimentDesc}</p>
      </div>
      {/* Right: decision summary */}
      {(advice || result20) && (
        <div className="min-w-[220px]">
          <p className="text-[11px] text-muted-foreground mb-2 font-medium uppercase tracking-wide">決策摘要</p>
          <table className="w-full text-xs">
            <tbody>
              {cfg && (
                <tr className="border-b border-border/30">
                  <td className="py-2 pr-3 text-muted-foreground">操作建議</td>
                  <td className={cn("py-2 font-semibold text-right", cfg.color.split(" ")[0])}>{cfg.label}</td>
                </tr>
              )}
              {conf != null && (
                <tr className="border-b border-border/30">
                  <td className="py-2 pr-3 text-muted-foreground">模型信心</td>
                  <td className="py-2 font-semibold text-right">{conf} / 100</td>
                </tr>
              )}
              {result20?.rangeReturnLow != null && result20?.rangeReturnHigh != null && (
                <tr className="border-b border-border/30">
                  <td className="py-2 pr-3 text-muted-foreground">20日報酬區間</td>
                  <td className="py-2 font-semibold text-right tabular-nums">
                    <span className="text-[#10b981]">{fmtPct(result20.rangeReturnLow)}</span>
                    {" ~ "}
                    <span className="text-[#ef4444]">{fmtPct(result20.rangeReturnHigh)}</span>
                  </td>
                </tr>
              )}
              {advice?.reasons?.[0] && (
                <tr>
                  <td className="py-2 pr-3 text-muted-foreground">主要依據</td>
                  <td className="py-2 text-right">{advice.reasons[0]}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Price Forecast Chart ─────────────────────────────────────────────────────

function ForecastChart({ result }: { result: PredictionResult }) {
  const upperMap = new Map((result.upperPath ?? []).map(p => [p.date, p.price]));
  const lowerMap = new Map((result.lowerPath ?? []).map(p => [p.date, p.price]));
  const p75Map   = new Map((result.p75Path  ?? []).map(p => [p.date, p.price]));
  const p25Map   = new Map((result.p25Path  ?? []).map(p => [p.date, p.price]));

  const data = result.medianPath.map(p => ({
    date: p.date.slice(5),
    median: p.price,
    upper:  upperMap.get(p.date),
    lower:  lowerMap.get(p.date),
    p75:    p75Map.get(p.date),
    p25:    p25Map.get(p.date),
  }));

  const expectedReturn = computeReturn(result.medianPath);
  const upside  = result.upperPath.length >= 2 ? computeReturn(result.upperPath) : 0;
  const downside = result.lowerPath.length >= 2 ? computeReturn(result.lowerPath) : 0;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-[#1cb8be]" />
            多地平線價格區間（{result.horizonDays}日）
          </CardTitle>
          <span className="text-[11px] text-muted-foreground">
            {result.startDate} → {result.endDate}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-3">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={Math.floor(data.length / 6)} />
            <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={65} tickFormatter={(v: number) => v.toLocaleString()} />
            <Tooltip
              contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
              formatter={(v: number, name: string) => [v?.toLocaleString() ?? "—", name]}
            />
            {/* ±1σ outer band */}
            <Line type="monotone" dataKey="upper" stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3" dot={false} name="樂觀上界(+1σ)" strokeOpacity={0.4} connectNulls />
            <Line type="monotone" dataKey="lower" stroke="#10b981" strokeWidth={1} strokeDasharray="3 3" dot={false} name="保守下界(-1σ)" strokeOpacity={0.4} connectNulls />
            {/* p25/p75 inner band */}
            <Line type="monotone" dataKey="p75" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5 2" dot={false} name="75%樂觀區間" strokeOpacity={0.65} connectNulls />
            <Line type="monotone" dataKey="p25" stroke="#10b981" strokeWidth={1.5} strokeDasharray="5 2" dot={false} name="25%保守區間" strokeOpacity={0.65} connectNulls />
            {/* Median */}
            <Line type="monotone" dataKey="median" stroke="#1cb8be" strokeWidth={2.5} dot={false} name="中位數預測" connectNulls />
            {data[0] && (
              <ReferenceLine y={data[0].median} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeOpacity={0.35} />
            )}
          </LineChart>
        </ResponsiveContainer>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mt-3 px-2">
          {[
            { label: "預期報酬", val: expectedReturn, color: expectedReturn >= 0 ? "text-[#ef4444]" : "text-[#10b981]" },
            { label: "上行潛力", val: upside,  color: "text-[#ef4444]" },
            { label: "下行風險", val: downside, color: "text-[#10b981]" },
          ].map(item => (
            <div key={item.label} className="text-center">
              <p className="text-[10px] text-muted-foreground mb-0.5">{item.label}</p>
              <p className={cn("text-sm font-bold tabular-nums", item.color)}>{fmtPct(item.val)}</p>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 mt-3 px-2 pt-2 border-t border-border/30">
          {[
            { color: "#1cb8be", dash: false, label: "中位數預測" },
            { color: "#ef4444", dash: true,  label: "75% 樂觀區間" },
            { color: "#10b981", dash: true,  label: "25% 保守區間" },
          ].map(l => (
            <span key={l.label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="inline-block w-5 h-0.5 rounded" style={{ background: l.color, opacity: l.dash ? 0.65 : 1, borderTop: l.dash ? `2px dashed ${l.color}` : undefined, background: "none", borderBottom: `2px ${l.dash ? "dashed" : "solid"} ${l.color}` }} />
              {l.label}
            </span>
          ))}
        </div>

        {/* Meta row */}
        {result.meta && (
          <div className="flex flex-wrap items-center gap-4 mt-2 px-2">
            {result.meta.trainSamples != null && <span className="text-[10px] text-muted-foreground">訓練樣本 <span className="text-foreground">{result.meta.trainSamples}</span></span>}
            {result.meta.trainWindowYears != null && <span className="text-[10px] text-muted-foreground">年數 <span className="text-foreground">{result.meta.trainWindowYears}y</span></span>}
            {result.modelName && <span className="text-[10px] text-muted-foreground">模型 <span className="text-[#66c6df]">{result.modelName}</span></span>}
            {result.meta.useAnalyst && <span className="text-[10px] text-[#66c6df]">含分析師特徵</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Horizon Summary List ─────────────────────────────────────────────────────

function HorizonList({ results }: { results: Record<number, PredictionResult> }) {
  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-[#1cb8be]" />
          地平線摘要
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {HORIZONS.map(({ days, label, sub }) => {
          const r = results[days];
          const ret = r?.expectedReturnPct;
          const up  = r?.upProbability;
          const upPct = up != null ? up * 100 : null;
          const chipLabel = up == null ? "未執行" : up >= 0.6 ? "偏多" : up >= 0.5 ? "中性偏多" : up >= 0.4 ? "中性" : "偏空";
          const chipCls   = up == null ? "border-border text-muted-foreground"
            : up >= 0.6 ? "border-[#ef4444]/40 text-[#ef4444]"
            : up >= 0.5 ? "border-[#1cb8be]/40 text-[#1cb8be]"
            : up >= 0.4 ? "border-muted text-muted-foreground"
            : "border-[#10b981]/40 text-[#10b981]";

          return (
            <div key={days} className="rounded-xl border border-border/50 bg-muted/10 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-bold">{label} {sub}</span>
                </div>
                <Badge variant="outline" className={cn("text-[11px] px-2 py-0.5", chipCls)}>{chipLabel}</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2">
                中位報酬 <span className={cn("font-semibold", ret == null ? "text-muted-foreground" : ret >= 0 ? "text-[#ef4444]" : "text-[#10b981]")}>
                  {ret != null ? fmtPct(ret) : "—"}
                </span>
                {r?.rangeReturnLow != null && r?.rangeReturnHigh != null && (
                  <> ｜ 區間 <span className="text-[#10b981]">{fmtPct(r.rangeReturnLow)}</span> ~ <span className="text-[#ef4444]">{fmtPct(r.rangeReturnHigh)}</span></>
                )}
              </p>
              {/* Progress bar = up probability */}
              <div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#10b981] to-[#1cb8be]"
                  style={{ width: upPct != null ? `${Math.max(5, Math.min(95, upPct))}%` : "0%" }}
                />
              </div>
              {upPct != null && <p className="text-[10px] text-muted-foreground mt-1">上漲機率 {upPct.toFixed(0)}%</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Scenario & Confidence ────────────────────────────────────────────────────

function ScenarioCard({ result }: { result: PredictionResult }) {
  const bull = result.bullProb ?? 0;
  const base = result.baseProb ?? 0;
  const bear = result.bearProb ?? 0;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-[#1cb8be]" />
          情境機率
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <table className="w-full text-sm">
          <tbody>
            {[
              { label: "Bull", desc: "趨勢延續上行", val: bull, colorCls: "text-[#ef4444]", chipCls: "border-[#ef4444]/30 text-[#ef4444]" },
              { label: "Base", desc: "區間震盪",     val: base, colorCls: "text-foreground",   chipCls: "border-border text-foreground" },
              { label: "Bear", desc: "回落修正",     val: bear, colorCls: "text-[#10b981]", chipCls: "border-[#10b981]/30 text-[#10b981]" },
            ].map(row => (
              <tr key={row.label} className="border-b border-border/30 last:border-0">
                <td className="py-2.5 pr-3">
                  <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0.5 mr-2", row.chipCls)}>{row.label}</Badge>
                  <span className="text-muted-foreground">{row.desc}</span>
                </td>
                <td className={cn("py-2.5 text-right font-bold tabular-nums", row.colorCls)}>
                  {(row.val * 100).toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed">依各決策樹預測分佈計算。不建議把單一情境當作必然結果。</p>
      </CardContent>
    </Card>
  );
}

function ConfidenceCard({ result }: { result: PredictionResult }) {
  const conf = result.confidenceScore ?? 0;
  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Brain className="w-4 h-4 text-[#1cb8be]" />
          模型信心
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">整體信心分數</p>
          <p className={cn("text-4xl font-extrabold", conf >= 70 ? "text-[#ef4444]" : conf >= 50 ? "text-foreground" : "text-[#10b981]")}>{conf}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">訓練資料年數</p>
          <p className="text-lg font-bold text-[#1cb8be]">{result.meta?.trainWindowYears ?? "—"}y</p>
        </div>
        {result.meta?.useAnalyst && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">增強特徵</p>
            <p className="text-sm text-[#66c6df]">含分析師共識</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Feature Importance ──────────────────────────────────────────────────────

function DriverCard({ result }: { result: PredictionResult }) {
  const features = result.topFeatures ?? [];
  if (features.length === 0) return null;
  const maxImp = Math.max(...features.map(f => f.importance));

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[#1cb8be]" />
          模型驅動因子
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {features.map((f, i) => (
          <div key={f.feature}>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-foreground">{f.label}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">{(f.importance * 100).toFixed(1)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(f.importance / maxImp) * 100}%`,
                  background: i === 0 ? "#1cb8be" : i === 1 ? "#66c6df" : "hsl(var(--muted-foreground))",
                  opacity: 1 - i * 0.1,
                }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── Personal Advice ─────────────────────────────────────────────────────────

function PersonalAdviceCard({ symbol, market }: { symbol: string; market: string }) {
  const { data, isLoading } = useQuery<PersonalAdvice>({
    queryKey: ["/api/personal-advice", symbol, market],
    queryFn: () => apiRequest("GET", `/api/personal-advice?symbol=${symbol}&market=${market}`).then(r => r.json()),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const cfg = data ? ACTION_CONFIG[data.primaryAction] : null;
  const pos = data?.positionState;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Target className="w-4 h-4 text-[#1cb8be]" />
          個人操作建議
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {isLoading && <div className="h-16 bg-muted/20 rounded-md animate-pulse" />}
        {data && cfg && (
          <>
            <Badge variant="outline" className={cn("text-sm font-semibold px-3 py-1", cfg.color)}>{cfg.label}</Badge>
            <ul className="space-y-1">
              {data.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 text-[#66c6df]" />{r}
                </li>
              ))}
            </ul>
            {pos && pos.shares > 0 && (
              <div className="rounded-lg border border-border/50 bg-muted/10 px-3 py-3 mt-1">
                <p className="text-[10px] text-muted-foreground mb-2 flex items-center gap-1"><User className="w-3 h-3" /> 持倉狀態</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {[
                    ["持股數", pos.shares.toLocaleString()],
                    ["均攤成本", `$${fmtPrice(pos.avgCost)}`],
                    ["現價",   `$${fmtPrice(pos.currentPrice)}`],
                    ["浮動盈虧", pos.unrealizedPct != null
                      ? <span className={pos.unrealizedPct >= 0 ? "text-[#ef4444] font-bold" : "text-[#10b981] font-bold"}>{fmtPct(pos.unrealizedPct)}</span>
                      : "—"],
                    ["持倉市值", pos.positionValue != null ? `$${fmtPrice(pos.positionValue)}` : "—"],
                    ["平均持有", pos.avgHoldingDays != null ? `${Math.round(pos.avgHoldingDays)} 天` : "—"],
                  ].map(([k, v]) => (
                    <div key={String(k)} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(!pos || pos.shares <= 0) && <p className="text-[11px] text-muted-foreground">未持有此股票</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Walk-forward History ─────────────────────────────────────────────────────

function WalkForwardSection({ symbol, market, horizonDays }: { symbol: string; market: string; horizonDays: number }) {
  const [open, setOpen] = useState(false);
  const from = nDaysAgoStr(180);
  const to = todayStr();

  const { data, isLoading } = useQuery<PredictionHistoryItem[]>({
    queryKey: ["/api/prediction-history", symbol, market, horizonDays, from, to],
    queryFn: () =>
      apiRequest("GET", `/api/prediction-history?symbol=${symbol}&market=${market}&horizon=${horizonDays}&from=${from}&to=${to}`).then(r => r.json()),
    enabled: open,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  // Build overlay chart
  function buildOverlay(items: PredictionHistoryItem[]) {
    const recent = [...items].sort((a, b) => b.runAt.localeCompare(a.runAt)).slice(0, 5);
    const dateSet = new Set<string>();
    recent.forEach(item => item.medianPath.forEach(p => dateSet.add(p.date)));
    const dates = Array.from(dateSet).sort();
    return {
      chartData: dates.map(date => {
        const row: Record<string, any> = { date: date.slice(5) };
        recent.forEach((item, idx) => {
          const pt = item.medianPath.find(p => p.date === date);
          if (pt) row[`run${idx}`] = pt.price;
        });
        return row;
      }),
      runs: recent,
    };
  }

  const { chartData, runs } = data?.length ? buildOverlay(data) : { chartData: [], runs: [] };

  // Accuracy stats
  const withAccuracy = (data ?? []).filter(d => d.accuracy);
  const directionHit = withAccuracy.filter(d => d.accuracy!.directionCorrect).length;
  const hitRate = withAccuracy.length > 0 ? (directionHit / withAccuracy.length * 100) : null;
  const avgMape = withAccuracy.length > 0 ? withAccuracy.reduce((s, d) => s + d.accuracy!.mape, 0) / withAccuracy.length : null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <History className="w-4 h-4 text-[#1cb8be]" />
            Walk-forward 實戰成績
          </CardTitle>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setOpen(v => !v)}>
            {open ? "隱藏" : "顯示"}
            <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-90")} />
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="px-4 pb-4 space-y-4">
          {isLoading && <div className="h-32 bg-muted/20 rounded-md animate-pulse" />}

          {/* Summary stats */}
          {hitRate != null && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border/50 bg-muted/10 p-3 text-center">
                <p className="text-[10px] text-muted-foreground mb-1">方向命中率</p>
                <p className={cn("text-xl font-extrabold", hitRate >= 60 ? "text-[#ef4444]" : "text-foreground")}>{hitRate.toFixed(0)}%</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/10 p-3 text-center">
                <p className="text-[10px] text-muted-foreground mb-1">平均 MAPE</p>
                <p className="text-xl font-extrabold">{avgMape!.toFixed(1)}%</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/10 p-3 text-center">
                <p className="text-[10px] text-muted-foreground mb-1">已驗證次數</p>
                <p className="text-xl font-extrabold">{withAccuracy.length}</p>
              </div>
            </div>
          )}

          {/* Overlay chart */}
          {chartData.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-2">最近 {runs.length} 次預測路徑疊加</p>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} interval={Math.max(1, Math.floor(chartData.length / 5))} />
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} width={60} tickFormatter={(v: number) => v.toLocaleString()} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }} formatter={(v: number, name: string) => [v?.toLocaleString() ?? "—", name]} />
                  <Legend wrapperStyle={{ fontSize: "10px", paddingTop: "4px" }} formatter={(value: string) => { const idx = parseInt(value.replace("run", ""), 10); return runs[idx]?.runAt ?? value; }} />
                  {runs.map((run, idx) => (
                    <Line key={`run${idx}`} type="monotone" dataKey={`run${idx}`} stroke={HISTORY_COLORS[idx % HISTORY_COLORS.length]} strokeWidth={idx === 0 ? 2 : 1.5} dot={false} strokeOpacity={idx === 0 ? 1 : 0.6} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Record list */}
          {data && data.length > 0 && (
            <div className="space-y-2">
              {[...data].sort((a, b) => b.runAt.localeCompare(a.runAt)).map((item, idx) => {
                const ret = computeReturn(item.medianPath);
                return (
                  <div key={idx} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 bg-muted/10">
                    <div>
                      <p className="text-xs font-medium">{item.runAt}</p>
                      <p className="text-[10px] text-muted-foreground">{item.startDate} → {item.endDate}</p>
                    </div>
                    <div className="text-right">
                      <p className={cn("text-xs font-bold tabular-nums", ret >= 0 ? "text-[#ef4444]" : "text-[#10b981]")}>{fmtPct(ret)}</p>
                      {item.accuracy && (
                        <p className="text-[10px] text-muted-foreground">
                          MAPE {item.accuracy.mape.toFixed(1)}% · {item.accuracy.directionCorrect
                            ? <span className="text-[#ef4444]">方向✓</span>
                            : <span className="text-[#10b981]">方向✗</span>}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {data && data.length === 0 && <p className="text-xs text-muted-foreground">尚無預測歷史紀錄。</p>}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Risk Tips ────────────────────────────────────────────────────────────────

function RiskCard({ result }: { result: PredictionResult }) {
  const up20 = result?.upProbability;
  const conf = result?.confidenceScore ?? 0;

  const tips = [
    {
      title: conf < 50 ? "模型信心偏低" : "注意信賴區間寬度",
      desc: conf < 50
        ? "訓練樣本或特徵覆蓋不足，預測結果不確定性較高，建議僅參考方向而非具體價位。"
        : "區間而非單點才是關鍵，預測中位值僅代表最可能路徑，實際走勢可能偏離。",
    },
    {
      title: "勿把模型當神諭",
      desc: "RF 模型學習歷史規律，無法反應突發事件（財報 miss、總體政策轉向）。事件前後應降低倉位或等確認。",
    },
    {
      title: "最有價值的是相對比較",
      desc: "同時對比 watchlist 中各股的 20D 機率，選出相對強勢標的，比單看絕對數字更實用。",
    },
  ];

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          風險提示
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {tips.map((t, i) => (
          <div key={i} className="rounded-lg border border-border/50 bg-muted/10 px-3 py-3">
            <p className="text-xs font-semibold mb-1">{t.title}</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{t.desc}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MLPrediction() {
  const { activeSymbol, activeMarket } = useActiveSymbol();

  // Store results per horizon
  const [results, setResults] = useState<Record<number, PredictionResult>>({});
  const [horizonDays, setHorizonDays] = useState<5 | 20 | 60>(20);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  // Reset on symbol change
  const symbolKey = `${activeSymbol}:${activeMarket}`;
  const [lastSymbolKey, setLastSymbolKey] = useState(symbolKey);
  if (symbolKey !== lastSymbolKey) {
    setLastSymbolKey(symbolKey);
    setResults({});
    setHasRun(false);
    setRunError(null);
  }

  const activeResult = results[horizonDays] ?? null;

  // Best result for hero (prefer 20D)
  const heroResult = results[20] ?? results[60] ?? results[5] ?? null;

  const { data: adviceData } = useQuery<PersonalAdvice>({
    queryKey: ["/api/personal-advice", activeSymbol, activeMarket],
    queryFn: () => apiRequest("GET", `/api/personal-advice?symbol=${activeSymbol}&market=${activeMarket}`).then(r => r.json()),
    staleTime: 5 * 60_000,
    retry: 1,
    enabled: hasRun,
  });

  const handleRunPrediction = async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      const res = await apiRequest("POST", "/api/prediction/run", {
        symbol: activeSymbol,
        market: activeMarket,
        horizonDays,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json();
      if (result.ok === false) throw new Error(result.error ?? "預測執行失敗");
      if (!result.medianPath || !Array.isArray(result.medianPath))
        throw new Error(`回傳資料格式錯誤：${JSON.stringify(result).slice(0, 100)}`);
      setResults(prev => ({ ...prev, [horizonDays]: result as PredictionResult }));
      setHasRun(true);
    } catch (e: any) {
      setRunError(e.message ?? "預測執行失敗");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="px-6 py-6 max-w-[1100px] mx-auto space-y-5">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight">股價走勢預測</h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">Random Forest 模型 · 多時間維度 · 機率區間輸出</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[11px] text-[#66c6df] border-[#66c6df]/30 bg-[#66c6df]/5">
            <Brain className="w-3 h-3 mr-1" />{activeSymbol} · {activeMarket}
          </Badge>
          {heroResult?.modelName && (
            <Badge variant="outline" className="text-[11px] text-muted-foreground border-border">
              {heroResult.modelName}
            </Badge>
          )}
        </div>
      </div>

      {/* ── Controls ── */}
      <Card className="border-border">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">預測時間維度</p>
              <div className="flex gap-1.5">
                {HORIZONS.map(({ days, label }) => (
                  <Button
                    key={days}
                    variant={horizonDays === days ? "default" : "outline"}
                    size="sm"
                    className={cn("h-8 px-3 text-xs",
                      horizonDays === days && "bg-[#1cb8be] hover:bg-[#1cb8be]/90 text-white border-transparent",
                      results[days] && horizonDays !== days && "border-[#66c6df]/40 text-[#66c6df]"
                    )}
                    onClick={() => setHorizonDays(days as 5 | 20 | 60)}
                  >
                    {label}
                    {results[days] && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-current opacity-70 inline-block" />}
                  </Button>
                ))}
              </div>
            </div>
            <div className="ml-auto">
              <Button onClick={handleRunPrediction} disabled={isRunning} className="gap-2 bg-[#1cb8be] hover:bg-[#1cb8be]/90 text-white">
                {isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
                {isRunning ? "運算中…" : `執行 ${horizonDays}日 預測`}
              </Button>
            </div>
          </div>
          {runError && <p className="mt-2 text-xs text-destructive">{runError}</p>}
        </CardContent>
      </Card>

      {/* ── Loading ── */}
      {isRunning && (
        <Card className="border-border">
          <CardContent className="p-4 space-y-3">
            <div className="h-5 bg-muted/30 rounded animate-pulse w-1/3" />
            <div className="h-[260px] bg-muted/20 rounded-md animate-pulse" />
            <div className="grid grid-cols-4 gap-3">{[1,2,3,4].map(i => <div key={i} className="h-14 bg-muted/20 rounded animate-pulse" />)}</div>
            <p className="text-xs text-muted-foreground text-center pt-1">首次執行需載入 Python 環境，約需 30–60 秒，請稍候…</p>
          </CardContent>
        </Card>
      )}

      {/* ── Empty state ── */}
      {!hasRun && !isRunning && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Brain className="w-14 h-14 opacity-15" />
          <p className="text-sm">選擇時間維度，點擊「執行預測」開始分析</p>
          <p className="text-xs opacity-60">支援 5日 / 20日 / 60日 分別執行，可累積多維度結果</p>
        </div>
      )}

      {/* ── Results ── */}
      {hasRun && !isRunning && (
        <>
          {/* KPI row */}
          <KpiCards results={results} />

          {/* Hero summary */}
          <HeroSummary advice={adviceData} result20={heroResult ?? undefined} />

          {/* Chart + Horizon list */}
          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
            {activeResult
              ? <ForecastChart result={activeResult} />
              : (
                <Card className="border-border flex items-center justify-center min-h-[280px]">
                  <p className="text-sm text-muted-foreground">請執行 {horizonDays}日 預測</p>
                </Card>
              )
            }
            <HorizonList results={results} />
          </div>

          {/* Scenario + Confidence + Drivers */}
          {heroResult && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <DriverCard result={heroResult} />
              <ScenarioCard result={heroResult} />
              <ConfidenceCard result={heroResult} />
            </div>
          )}

          {/* Personal advice + Walk-forward */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PersonalAdviceCard symbol={activeSymbol} market={activeMarket} />
            <WalkForwardSection symbol={activeSymbol} market={activeMarket} horizonDays={horizonDays} />
          </div>

          {/* Risk tips */}
          {heroResult && <RiskCard result={heroResult} />}
        </>
      )}

      {/* Disclaimer */}
      <Card className="border-border bg-muted/5">
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            ⚠️ 免責聲明：此 ML 預測模型以歷史收盤資料訓練，採 Random Forest 動量模型模擬。
            預測結果僅供參考，不構成投資建議。機器學習模型容易過擬合，
            實際投資決策請綜合基本面、市場環境與個人風險承受度。
          </p>
        </CardContent>
      </Card>

    </div>
  );
}
