import { useState, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ExternalLink, RefreshCw, ChevronDown, History } from "lucide-react";
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

const FEATURE_LABELS: Record<string, string> = {
  analyst_bullish_pct: '分析師樂觀占比',
  analyst_bearish_pct: '分析師悲觀占比',
  analyst_pt_upside: '目標價上行空間',
  analyst_upgrade_net: '評級淨升級',
  analyst_pt_dispersion: '目標價離散度',
  pt_change_30d_pct: '目標價30日變化',
  pt_revision_count: '目標價修訂次數',
  revenue_qoq: '營收季增率',
  revenue_yoy: '營收年增率',
  gross_margin: '毛利率',
  net_margin: '淨利率',
  eps_qoq: 'EPS季增率',
  days_since_earnings: '距財報天數',
  days_to_earnings: '距下次財報天數',
  fear_greed: '恐懼貪婪指數',
  fear_greed_delta_7d: '恐貪7日變化',
  vix_level: 'VIX水準',
  vix_5d_change: 'VIX5日變化',
  sector_rs_5d: '板塊5日RS',
  sector_rs_20d: '板塊20日RS',
  macro_sentiment_score: '宏觀情緒分',
  macro_sentiment_3d_avg: '宏觀3日情緒均值',
  news_sentiment_score: '新聞情緒分',
  news_bullish_ratio: '新聞看多比率',
  news_sentiment_3d_avg: '情緒3日均值',
  news_article_count: '新聞熱度',
};

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
  if (label === "賣出")     return "text-[#10b981]";
  return "text-[#10b981]"; // 強烈賣出
}

// ─── Custom dot renderer for buy/sell marks ───────────────────────────────────
function TradeDotRenderer(props: any) {
  const { cx, cy, payload } = props;
  if (!payload?.tradeInfo) return null;
  const { side } = payload.tradeInfo as TradeDot;
  const color = side === "buy" ? "#ef4444" : "#10b981";
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
            <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: p.tradeInfo.side === "buy" ? "#ef4444" : "#10b981" }} />
            <span className="font-semibold" style={{ color: p.tradeInfo.side === "buy" ? "#ef4444" : "#10b981" }}>
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
            <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: ae.direction === "up" ? "#ef4444" : ae.direction === "down" ? "#10b981" : "#94a3b8" }} />
            <span className="font-semibold text-muted-foreground">{ae.institution}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">評級</span>
            <span className="font-medium" style={{ color: ae.ratingCategory === "bullish" ? "#ef4444" : ae.ratingCategory === "bearish" ? "#10b981" : "#cbd5e1" }}>{ae.rating}</span>
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
            <span style={{ color: ae.direction === "up" ? "#ef4444" : ae.direction === "down" ? "#10b981" : "#94a3b8" }}>
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
  const color = event.direction === "up" ? "#ef4444" : event.direction === "down" ? "#10b981" : "#94a3b8";
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
                <div className="text-[22px] font-semibold text-[#10b981] leading-tight">{summary.bearishCount}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{summary.bearishPct}%</div>
              </div>
            </div>
          </div>

          {/* ── Right: 52W target price band ── */}
          <div className="px-6 py-4">
            <div className="text-[13px] font-medium text-foreground mb-3">
              分析師 52W 目標價
              <span className="ml-2 text-[11px] text-muted-foreground font-normal">
                近 4 個月樣本：{summary.sampleCount} 筆
              </span>
            </div>

            {/* Price labels row — fixed equal-width 4 columns */}
            <div className="grid grid-cols-4 mb-2">
              {/* Low — left-aligned */}
              <div>
                <div className="text-[12px] font-semibold text-[#10b981] tabular-nums">{currencySymbol}{lowTargetPrice.toLocaleString()}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[10px] text-muted-foreground">低</span>
                </div>
              </div>
              {/* Current — center */}
              <div className="text-center">
                <div className="text-[12px] font-semibold text-foreground tabular-nums">{currencySymbol}{currentPrice > 0 ? currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</div>
                <div className="flex items-center gap-1 mt-0.5 justify-center">
                  <span style={{ width: 9, height: 9, borderRadius: "50%", border: "2px solid #fff", background: "transparent", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[10px] text-muted-foreground">目前</span>
                </div>
              </div>
              {/* Average — center */}
              <div className="text-center">
                <div className="text-[12px] font-semibold text-[#fda4af] tabular-nums">{currencySymbol}{averageTargetPrice.toLocaleString()}</div>
                <div className="flex items-center gap-1 mt-0.5 justify-center">
                  <span style={{ width: 9, height: 9, borderRadius: "50%", border: "2px solid #fda4af", background: "transparent", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[10px] text-muted-foreground">平均 ({Number(upsidePct) >= 0 ? "+" : ""}{upsidePct}%)</span>
                </div>
              </div>
              {/* High — right-aligned */}
              <div className="text-right">
                <div className="text-[12px] font-semibold text-[#ef4444] tabular-nums">{currencySymbol}{highTargetPrice.toLocaleString()}</div>
                <div className="flex items-center gap-1 mt-0.5 justify-end">
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ef4444", display: "inline-block", flexShrink: 0 }} />
                  <span className="text-[10px] text-muted-foreground">高</span>
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
                background: "linear-gradient(90deg, rgba(16,185,129,.3) 0%, rgba(255,255,255,.12) 50%, rgba(239,68,68,.35) 100%)",
              }} />
              {/* Low dot — small solid green */}
              <span style={{
                position: "absolute", top: "50%", left: `${lowPct}%`,
                transform: "translate(-50%,-50%)",
                width: 8, height: 8, borderRadius: "50%",
                background: "#10b981", display: "block",
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


// ─── Stock Note Card (自治版) ─────────────────────────────────────────────────
function StockNoteCard({ symbol, market }: { symbol: string; market: string }) {
  const queryClient = useQueryClient();
  const qKey = ["/api/stock-notes", symbol, market];

  // 自治 fetch，staleTime 設大避免切換時無謂 refetch 帶起舊資料閃爍
  const { data, isLoading: noteLoading } = useQuery<{ content: string }>({
    queryKey: qKey,
    queryFn: () =>
      apiRequest("GET", `/api/stock-notes/${symbol}?market=${market}`)
        .then(r => r.json()),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    enabled: !!symbol,
  });

  const saveMutation = useMutation({
    mutationFn: (content: string) =>
      apiRequest("PUT", `/api/stock-notes/${symbol}?market=${market}`, { content })
        .then(r => r.json()),
    onSuccess: (_res, content) => {
      // 直接寫入快取，不 refetch，確保顯示內容不閃
      queryClient.setQueryData(qKey, { content });
    },
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 顯示用：永遠讀 query 快取，不用 draft state
  const savedContent = data?.content ?? "";

  const handleDoubleClick = () => {
    setDraft(savedContent);   // 從快取載入最新內容進草稿
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 30);
  };

  const handleSave = () => {
    saveMutation.mutate(draft);
    setEditing(false);
  };

  const handleCancel = () => {
    setEditing(false);
    // 不動 draft；退出編輯後顯示的是 savedContent（query 快取），不是 draft
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <Card className="border-border mb-4">
      <CardHeader className="pb-1.5 pt-3 px-4 flex-row items-center justify-between">
        <CardTitle className="text-xs font-semibold">個股投資筆記</CardTitle>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <span className="text-[10px] text-muted-foreground">Ctrl+Enter 儲存・Esc 取消</span>
              <button
                onClick={handleCancel}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5"
              >取消</button>
              <button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="text-[11px] text-[#1cb8be] hover:text-[#66c6df] transition-colors px-1.5 font-medium disabled:opacity-50"
              >{saveMutation.isPending ? "儲存中…" : "儲存"}</button>
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground">雙擊進行編輯</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full h-[120px] bg-muted/30 border border-[#1cb8be]/40 rounded-md px-3 py-2 text-xs text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-[#1cb8be]/60 placeholder:text-muted-foreground"
            placeholder="在這裡記錄投資摘要、觀察、進出場策略…"
          />
        ) : (
          <div
            onDoubleClick={handleDoubleClick}
            className="h-[120px] overflow-y-auto px-3 py-2 rounded-md cursor-text hover:bg-muted/20 transition-colors"
          >
            {noteLoading ? (
              <span className="text-xs text-muted-foreground">載入中…</span>
            ) : savedContent ? (
              <pre className="text-xs text-foreground whitespace-pre-wrap font-sans leading-relaxed">{savedContent}</pre>
            ) : (
              <span className="text-xs text-muted-foreground italic">雙擊新增筆記…</span>
            )}
          </div>
        )}
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
    if (cat === "bullish") return "bg-[rgba(239,68,68,.12)] text-[#ef4444] border border-[rgba(239,68,68,.22)]";
    if (cat === "bearish") return "bg-[rgba(16,185,129,.12)] text-[#10b981] border border-[rgba(16,185,129,.22)]";
    return "bg-slate-500/10 text-slate-300 border border-slate-500/20";
  };

  return (
    <Card className="border-border mt-4">
      <CardHeader className="pb-1.5 pt-3 px-4 flex-row items-center justify-between">
        <CardTitle className="text-xs font-semibold">分析師目標價資料表</CardTitle>
        <span className="text-[10px] text-muted-foreground">近 6 個月，同機構歷史集中顯示</span>
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
            {(() => {
              // 分組：依機構归併，同機構內依日期新→舊排列。最新行先出現（以最新行日期排機構順序）
              const grouped = new Map<string, typeof rows>();
              for (const row of rows) {
                if (!grouped.has(row.institution)) grouped.set(row.institution, []);
                grouped.get(row.institution)!.push(row);
              }
              // Sort each group newest first
              for (const grp of grouped.values()) {
                grp.sort((a, b) => (a.analystDate > b.analystDate ? -1 : 1));
              }
              // Sort institution groups by their latest date descending
              const sortedGroups = Array.from(grouped.entries()).sort(
                ([, a], [, b]) => (a[0].analystDate > b[0].analystDate ? -1 : 1)
              );

              return sortedGroups.flatMap(([institution, grp]) =>
                grp.map((row, idx) => {
                  const isFirst = idx === 0;
                  const upsidePct = currentPrice > 0
                    ? ((row.targetPrice - currentPrice) / currentPrice * 100)
                    : null;
                  const upsideColor = upsidePct === null ? "" : upsidePct > 0 ? "text-[#ef4444]" : upsidePct < 0 ? "text-[#10b981]" : "text-muted-foreground";
                  const dateFormatted = row.analystDate ? row.analystDate.replace(/-/g, "/") : "—";

                  return (
                    <tr
                      key={row.id ?? `${institution}-${idx}`}
                      className={cn(
                        "border-b border-border/50 hover:bg-muted/20 transition-colors",
                        !isFirst && "bg-muted/5"
                      )}
                    >
                      {/* 機構欄：第一筆顯示名稱，後續筆縮排 */}
                      <td className="px-3 py-1.5 font-medium">
                        {isFirst ? (
                          <span>{institution}</span>
                        ) : (
                          <span className="pl-4 text-muted-foreground">└ {institution}</span>
                        )}
                      </td>
                      <td className={cn(
                        "px-3 py-1.5 font-bold",
                        !isFirst && "pl-7",
                        row.ratingCategory === "bullish" ? "text-[#ef4444]" :
                        row.ratingCategory === "bearish" ? "text-[#10b981]" :
                        "text-foreground"
                      )}>{row.rating}</td>
                      <td className={cn("px-3 py-1.5 tabular-nums font-medium", !isFirst && "pl-7")}>
                        {currencySymbol}{row.targetPrice.toLocaleString()}
                      </td>
                      <td className={cn("px-3 py-1.5 tabular-nums text-muted-foreground", !isFirst && "pl-7")}>
                        {row.previousTargetPrice !== null && row.previousTargetPrice !== undefined
                          ? `${currencySymbol}${row.previousTargetPrice.toLocaleString()}`
                          : "—"}
                      </td>
                      <td className={cn("px-3 py-1.5 tabular-nums font-medium", upsideColor, !isFirst && "pl-7")}>
                        {upsidePct === null ? "—" : `${upsidePct >= 0 ? "+" : ""}${upsidePct.toFixed(1)}%`}
                      </td>
                      <td className={cn("px-3 py-1.5 text-muted-foreground tabular-nums", !isFirst && "pl-7")}>
                        {dateFormatted}
                      </td>
                    </tr>
                  );
                })
              );
            })()}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ─── ML Prediction types ────────────────────────────────────────────────────
interface HorizonPoint {
  targetDate: string;
  medianPrice: number;
  lowerPrice: number;
  upperPrice: number;
  medianReturn: number;  // % units
  upProbability: number;
  topFeatures: Array<{ feature: string; label: string; importance: number }>;
}

interface PredictionRun {
  ok: boolean;
  found?: boolean;
  queued?: boolean;  // true when server auto-queued a background prediction
  run_id: string | null;
  runAt: string;
  baseDate: string | null;
  basePrice: number | null;
  symbol: string;
  market: string;
  horizons: Record<string, HorizonPoint> | null;
  meta?: {
    featureCoverage?: {
      total: number;
      available: number;
      missing: string[];
    };
  };
}

interface HistoryRunItem {
  run_id: string;
  runAt: string;
  baseDate: string;
}

/** Build sorted array of {date, median, lower, upper} from horizons dict */
function buildPredPoints(run: PredictionRun): Array<{ date: string; median: number; lower: number; upper: number }> {
  if (!run.horizons) return [];
  return Object.keys(run.horizons)
    .map(Number)
    .sort((a, b) => a - b)
    .map(h => ({
      date:   run.horizons![String(h)].targetDate,
      median: run.horizons![String(h)].medianPrice,
      lower:  run.horizons![String(h)].lowerPrice,
      upper:  run.horizons![String(h)].upperPrice,
    }));
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
  const [range, setRange] = useState("6mo");
  const queryClient = useQueryClient();

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

  // Force resync history from Yahoo for current symbol
  const resyncMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/history/${activeSymbol}/resync?market=${meta.market}`)
        .then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/history", activeSymbol] });
    },
  });

  // Force resync ALL watchlist symbols at once
  const resyncAllMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/history/resync-all")
        .then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
    },
  });

  // Historical data (full 1-year pool)
  const { data, isLoading: _isLoading, isError, isFetching } = useQuery<HistoryResponse>({
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

  // Stock notes — query 移至 StockNoteCard 內部自治

  // ─── ML Prediction state ──────────────────────────────────
  const [comparePrediction, setComparePrediction] = useState<PredictionRun | null>(null);
  const [compareRunId, setCompareRunId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Fetch latest prediction for current symbol
  // When found=false & queued=true, refetch every 10s until prediction arrives
  const { data: latestPrediction, isLoading: isPredLoading } = useQuery<PredictionRun>({
    queryKey: ["/api/predictions/latest", activeSymbol, meta.market],
    queryFn: () =>
      apiRequest("GET", `/api/predictions/latest?symbol=${activeSymbol}&market=${meta.market}`)
        .then(r => r.json()),
    staleTime: 5 * 60_000,
    enabled: !!activeSymbol,
    placeholderData: (prev) => prev,
    // Poll every 10s while the background prediction is running (found=false + queued=true)
    refetchInterval: (query) => {
      const d = query.state.data as PredictionRun | undefined;
      return d && !d.found && d.queued ? 10_000 : false;
    },
  });

  // Fetch prediction run history list
  const { data: predHistory } = useQuery<{ ok: boolean; runs: HistoryRunItem[] }>({
    queryKey: ["/api/predictions/history", activeSymbol, meta.market],
    queryFn: () =>
      apiRequest("GET", `/api/predictions/history?symbol=${activeSymbol}&market=${meta.market}&limit=10`)
        .then(r => r.json()),
    staleTime: 5 * 60_000,
    enabled: historyOpen && !!activeSymbol,
  });

  // Fetch a historical run by run_id for comparison
  const { isFetching: isCompareFetching } = useQuery<PredictionRun>({
    queryKey: ["/api/predictions/run", compareRunId],
    queryFn: () =>
      apiRequest("GET", `/api/predictions/run/${compareRunId}`)
        .then(r => r.json()),
    staleTime: Infinity,
    enabled: !!compareRunId,
    onSuccess: (data: PredictionRun) => setComparePrediction(data),
  } as any);

  // Trigger a new prediction run
  const triggerPredMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/predictions/trigger", { symbol: activeSymbol, market: meta.market })
        .then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/predictions/latest", activeSymbol, meta.market] });
      queryClient.invalidateQueries({ queryKey: ["/api/predictions/history", activeSymbol, meta.market] });
      setComparePrediction(null);
      setCompareRunId(null);
    },
  });

  // isPending = true only when no cached/placeholder data exists at all (first ever load for this symbol)
  const isLoading = data === undefined;

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

  // ─── Build merged chart data = historical + future prediction points ──────
  const showPredOverlay = ["3mo", "6mo", "1y"].includes(range);

  const predPoints = useMemo(() =>
    showPredOverlay && latestPrediction?.horizons ? buildPredPoints(latestPrediction) : []
  , [latestPrediction, showPredOverlay]);

  const comparePredPoints = useMemo(() =>
    showPredOverlay && comparePrediction?.horizons ? buildPredPoints(comparePrediction) : []
  , [comparePrediction, showPredOverlay]);

  // Whether the compare baseDate is visible in current chart window
  const compareBaseDateVisible = useMemo(() => {
    if (!comparePrediction?.baseDate || !candleData.length) return true;
    return comparePrediction.baseDate >= candleData[0].time;
  }, [comparePrediction, candleData]);

  // Merged data: historical bars + future prediction dates
  const mergedChartData = useMemo(() => {
    if (!showPredOverlay || predPoints.length === 0) return chartData;
    const existingDates = new Set(chartData.map((d: any) => d.fullDate));
    const future = predPoints
      .filter(p => !existingDates.has(p.date))
      .map(p => ({
        date: p.date.slice(5),
        fullDate: p.date,
        open: null, high: null, low: null, close: null, volume: null,
        rsi: null, macd: null, signal: null, histogram: null,
        bbUpper: null, bbMiddle: null, bbLower: null,
        tradeDot: null, tradeInfo: null, analystEvent: null, analystDot: null,
      }));
    return [...chartData, ...future];
  }, [chartData, predPoints, showPredOverlay]);

  // Build lookup maps for prediction lines on mergedChartData
  const latestPredMap = useMemo(() => {
    const m = new Map<string, { median: number; lower: number; upper: number }>();
    for (const p of predPoints) m.set(p.date, p);
    return m;
  }, [predPoints]);

  const comparePredMap = useMemo(() => {
    const m = new Map<string, { median: number; lower: number; upper: number }>();
    for (const p of comparePredPoints) m.set(p.date, p);
    return m;
  }, [comparePredPoints]);

  // Extend mergedChartData with prediction columns
  const extendedChartData = useMemo(() => {
    if (!showPredOverlay) return mergedChartData;
    return mergedChartData.map((d: any) => ({
      ...d,
      predMedian:  latestPredMap.get(d.fullDate)?.median  ?? null,
      predLower:   latestPredMap.get(d.fullDate)?.lower   ?? null,
      predUpper:   latestPredMap.get(d.fullDate)?.upper   ?? null,
      cmpMedian:   comparePredMap.get(d.fullDate)?.median ?? null,
      cmpLower:    comparePredMap.get(d.fullDate)?.lower  ?? null,
      cmpUpper:    comparePredMap.get(d.fullDate)?.upper  ?? null,
    }));
  }, [mergedChartData, latestPredMap, comparePredMap, showPredOverlay]);

  const extendedXInterval = Math.max(1, Math.floor(extendedChartData.length / 12));

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
                近 4 個月分析師樣本：{analystData!.summary!.sampleCount} 筆
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
            <button
              onClick={() => resyncAllMutation.mutate()}
              disabled={resyncAllMutation.isPending || resyncMutation.isPending}
              title="清除并重新從 Yahoo 拉取所有個股的完整歷史收盤價"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] border border-border/60 text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/30 transition-colors disabled:opacity-40"
            >
              <RefreshCw size={12} className={resyncAllMutation.isPending ? "animate-spin" : ""} />
              {resyncAllMutation.isPending
                ? "全部同步中..."
                : resyncAllMutation.isSuccess
                ? `完成 (${resyncAllMutation.data?.total ?? 0} 支)`
                : "全部重新同步"}
            </button>
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

      {/* ── 個股投資筆記 ── */}
      <StockNoteCard
        symbol={activeSymbol}
        market={meta.market}
      />

      {/* Signal Cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">RSI (14日)</div>
            {isLoading ? <Skeleton className="h-7 w-full" /> : (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tabular-nums">{lastRSI.toFixed(1)}</span>
                <Badge
                  className={cn(
                    "text-[10px] border",
                    rsiSignal === "超買"
                      ? "bg-[rgba(239,68,68,.15)] text-[#ef4444] border-[rgba(239,68,68,.25)]"
                      : rsiSignal === "超賣"
                      ? "bg-[rgba(16,185,129,.14)] text-[#10b981] border-[rgba(16,185,129,.22)]"
                      : "bg-[rgba(255,255,255,.08)] text-muted-foreground border-[rgba(255,255,255,.12)]"
                  )}
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
                  className={cn(
                    "text-[10px] border",
                    macdSignal === "多頭"
                      ? "bg-[rgba(239,68,68,.15)] text-[#ef4444] border-[rgba(239,68,68,.25)]"
                      : "bg-[rgba(16,185,129,.14)] text-[#10b981] border-[rgba(16,185,129,.22)]"
                  )}
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
            <div className="flex items-center gap-2">
              {data && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {data.dataFrom} → {data.dataTo}
                </span>
              )}
              <button
                onClick={() => resyncMutation.mutate()}
                disabled={resyncMutation.isPending}
                title="重新從 Yahoo 同步歷史收盤價"
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-40"
              >
                <RefreshCw size={11} className={resyncMutation.isPending ? "animate-spin" : ""} />
                {resyncMutation.isPending ? "同步中..." : resyncMutation.isSuccess ? "完成" : "重新同步"}
              </button>
            </div>
          </div>

          {/* ── ML Prediction controls row (3mo+ only) ── */}
          {showPredOverlay && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {/* Latest prediction label */}
              {latestPrediction?.found && latestPrediction.baseDate && (
                <span className="text-[11px] text-[#F97316] font-medium flex items-center gap-1">
                  <span className="inline-block w-4 h-0.5 bg-[#F97316] opacity-70 mr-0.5" style={{borderTop: '2px dashed #F97316', background: 'none'}} />
                  預測 {latestPrediction.baseDate}
                </span>
              )}
              {/* Background queued: show pulsing indicator */}
              {!latestPrediction?.found && latestPrediction?.queued && !isPredLoading && (
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#F97316] animate-pulse" />
                  背景預測中...
                </span>
              )}
              {!latestPrediction?.found && !latestPrediction?.queued && !isPredLoading && (
                <span className="text-[11px] text-muted-foreground">尚無預測資料</span>
              )}
              {isPredLoading && (
                <span className="text-[11px] text-muted-foreground">載入預測中...</span>
              )}
              {/* Trigger new prediction button */}
              <button
                onClick={() => triggerPredMutation.mutate()}
                disabled={triggerPredMutation.isPending}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border border-[#F97316]/40 text-[#F97316] hover:bg-[#F97316]/10 transition-colors disabled:opacity-40"
              >
                <RefreshCw size={10} className={triggerPredMutation.isPending ? "animate-spin" : ""} />
                {triggerPredMutation.isPending ? "預測中..." : "重新預測"}
              </button>

              {/* Feature coverage badge */}
              {latestPrediction?.meta?.featureCoverage && (() => {
                const fc = latestPrediction.meta!.featureCoverage!;
                const color = fc.available >= fc.total
                  ? '#10b981'
                  : fc.available / fc.total >= 0.8
                  ? '#f59e0b'
                  : '#ef4444';
                return (
                  <div className="relative group cursor-default">
                    <span
                      className="text-xs px-2 py-0.5 rounded border"
                      style={{ color, borderColor: color }}
                    >
                      預測指標 ({fc.available}/{fc.total})
                    </span>
                    {fc.missing.length > 0 && (
                      <div className="absolute bottom-full left-0 mb-1 z-50 hidden group-hover:flex flex-col bg-gray-900 border border-gray-700 rounded p-2 min-w-[160px] shadow-lg">
                        <span className="text-xs text-gray-400 mb-1">缺少資料：</span>
                        {fc.missing.map((key) => (
                          <span key={key} className="text-xs text-gray-200">
                            • {FEATURE_LABELS[key] ?? key}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Compare history dropdown */}
              <div className="relative">
                <button
                  onClick={() => setHistoryOpen(v => !v)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border border-border/60 text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/30 transition-colors"
                >
                  <History size={10} />
                  {comparePrediction ? (
                    <span className="text-[#EAB308]">對比：{comparePrediction.runAt?.slice(0,10)}</span>
                  ) : (
                    <span>+ 對比歷史預測</span>
                  )}
                  <ChevronDown size={9} />
                </button>
                {historyOpen && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-background border border-border rounded-md shadow-lg z-50 py-1">
                    {comparePrediction && (
                      <button
                        className="w-full text-left px-3 py-1.5 text-[11px] text-[#10b981] hover:bg-muted/40"
                        onClick={() => { setComparePrediction(null); setCompareRunId(null); setHistoryOpen(false); }}
                      >
                        清除對比
                      </button>
                    )}
                    {!predHistory?.runs?.length && (
                      <div className="px-3 py-2 text-[11px] text-muted-foreground">無歷史預測資料</div>
                    )}
                    {predHistory?.runs?.filter(r => r.run_id !== latestPrediction?.run_id).map(run => (
                      <button
                        key={run.run_id}
                        className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted/40 ${
                          compareRunId === run.run_id ? 'text-[#EAB308]' : 'text-foreground'
                        }`}
                        onClick={() => {
                          setCompareRunId(run.run_id);
                          setHistoryOpen(false);
                        }}
                      >
                        {run.runAt?.slice(0, 10)}
                      </button>
                    ))}
                    {isCompareFetching && (
                      <div className="px-3 py-1.5 text-[11px] text-muted-foreground">載入中...</div>
                    )}
                  </div>
                )}
              </div>

              {/* Out-of-range warning */}
              {comparePrediction && !compareBaseDateVisible && (
                <span className="text-[11px] text-amber-400">此預測超出當前顯示範圍，請切換至更長 range</span>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="px-2 pb-3">
          {isLoading ? (
            <Skeleton className="w-full h-[320px] rounded-md" />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={extendedChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={extendedXInterval} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={65} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip content={<BollingerTooltip />} />

                {/* == Prediction channel bands (rendered first = lowest layer) == */}
                {showPredOverlay && comparePredPoints.length > 0 && compareBaseDateVisible && (
                  <>
                    <Area type="monotone" dataKey="cmpUpper" stroke="none" fill="#EAB308" fillOpacity={0.08} connectNulls={false} isAnimationActive={false} legendType="none" />
                    <Area type="monotone" dataKey="cmpLower" stroke="none" fill="hsl(var(--background))" fillOpacity={0.5} connectNulls={false} isAnimationActive={false} legendType="none" />
                  </>
                )}
                {showPredOverlay && predPoints.length > 0 && (
                  <>
                    <Area type="monotone" dataKey="predUpper" stroke="none" fill="#F97316" fillOpacity={0.12} connectNulls={false} isAnimationActive={false} legendType="none" />
                    <Area type="monotone" dataKey="predLower" stroke="none" fill="hsl(var(--background))" fillOpacity={1} connectNulls={false} isAnimationActive={false} legendType="none" />
                  </>
                )}

                {/* == Prediction median lines (above bands, below Bollinger+K-line) == */}
                {showPredOverlay && comparePredPoints.length > 0 && compareBaseDateVisible && (
                  <Line type="monotone" dataKey="cmpMedian" stroke="#EAB308" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} name="對比預測" legendType="none" />
                )}
                {showPredOverlay && predPoints.length > 0 && (
                  <Line type="monotone" dataKey="predMedian" stroke="#F97316" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} name="ML預測中位數" legendType="none" />
                )}

                {/* == Bollinger + K-line rendered on top == */}
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
                    const color = payload.tradeInfo.side === "buy" ? "#ef4444" : "#10b981";
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
                    const color = payload.tradeInfo.side === "buy" ? "#ef4444" : "#10b981";
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
                    ? avg > currentPrice ? "#ef4444" : avg < currentPrice ? "#10b981" : "#ffffff"
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
                      const color = ev.direction === "up" ? "#ef4444" : ev.direction === "down" ? "#10b981" : "#94a3b8";
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

                {/* baseDate vertical markers (rendered on top of everything) */}
                {showPredOverlay && latestPrediction?.baseDate && (
                  <ReferenceLine x={latestPrediction.baseDate.slice(5)} stroke="#9CA3AF" strokeWidth={1} strokeDasharray="4 3" opacity={0.6} label={false} />
                )}
                {showPredOverlay && comparePrediction?.baseDate && compareBaseDateVisible && (
                  <ReferenceLine x={comparePrediction.baseDate.slice(5)} stroke="#EAB308" strokeWidth={1} strokeDasharray="3 3" opacity={0.4} label={false} />
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
                  <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 3" />
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
