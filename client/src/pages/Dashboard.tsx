import { useState, useRef } from "react";
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
  stale: boolean;
}

interface MarketOverviewPayload {
  tw: IndicatorCard[];
  us: IndicatorCard[];
  summary: { tw: string; us: string };
  updatedAt: string;
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

// ─── Sparkline ────────────────────────────────────────────────────────────────

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
  const polyline = coords.join(" ");
  // Color by signal
  const stroke =
    signal === "strong_bull" || signal === "bull" ? "#f87171"
    : signal === "strong_bear" || signal === "bear" ? "#34d399"
    : "#6b7280";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 opacity-70">
      <polyline
        points={polyline}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Indicator Card (Market Overview) ────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtChange(v: number | null | undefined, decimals = 2, pct = false): string {
  if (v === null || v === undefined) return "";
  const sign = v > 0 ? "+" : "";
  const str = Math.abs(v).toLocaleString("zh-TW", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${sign === "+" ? "" : ""}${v < 0 ? "-" : sign}${str}${pct ? "%" : ""}`;
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

  // ─── TAIEX ─────────────────────────────────────────────────────────
  if (card.key === "taiex") {
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 0)}</span>
          {card.changePct !== null && card.changePct !== undefined && (
            <span className={cn("text-xs tabular-nums font-medium", isGain(card.changePct) ? "text-gain" : isLoss(card.changePct) ? "text-loss" : "text-muted-foreground")}>
              {fmtChange(card.changePct, 2, true)}
            </span>
          )}
        </div>
        {card.value2 !== null && card.value2 !== undefined && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            成交值 {fmt(card.value2, 0)} 億
          </div>
        )}
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── 成交值 ────────────────────────────────────────────────────────
  if (card.key === "tw_volume") {
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 0)}</span>
          <span className="text-[11px] text-muted-foreground">億</span>
        </div>
        <div className="mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
      </div>
    );
  }

  // ─── 漲跌家數 ───────────────────────────────────────────────────────
  if (card.key === "tw_adv_dec") {
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums text-gain">{fmt(card.value, 0)}</span>
          <span className="text-[11px] text-muted-foreground">漲</span>
          <span className="text-base font-semibold tabular-nums text-loss">{fmt(card.value2, 0)}</span>
          <span className="text-[11px] text-muted-foreground">跌</span>
        </div>
        <div className="mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
      </div>
    );
  }

  // ─── 外資買賣超 ─────────────────────────────────────────────────────
  if (card.key === "tw_foreign_net") {
    const v = card.value;
    const colorClass = isGain(v) ? "text-gain" : isLoss(v) ? "text-loss" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-1">
          <span className={cn("text-base font-semibold tabular-nums", colorClass)}>
            {fmtChange(v, 0)}
          </span>
          <span className="text-[11px] text-muted-foreground">億</span>
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── 融資餘額 ───────────────────────────────────────────────────────
  if (card.key === "tw_margin") {
    const chg = card.value2;
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 0)}</span>
          <span className="text-[11px] text-muted-foreground">億</span>
          {chg !== null && chg !== undefined && (
            <span className={cn("text-xs tabular-nums ml-1", isGain(chg) ? "text-gain" : isLoss(chg) ? "text-loss" : "text-muted-foreground")}>
              ({fmtChange(chg, 0)})
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── USD/TWD ────────────────────────────────────────────────────────
  if (card.key === "usdtwd") {
    const chg = card.change;
    // TWD weakening (rate goes up) → red (bad for market)
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 3)}</span>
          {chg !== null && chg !== undefined && chg !== 0 && (
            <span className={cn("text-xs tabular-nums font-medium", colorClass)}>
              {fmtChange(chg, 3)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── DJIA / S&P500 / Nasdaq / SOX (US index with price + change%) ──
  if (["djia", "sp500", "nasdaq", "sox"].includes(card.key)) {
    const chgPct = card.changePct;
    const colorClass = isGain(chgPct) ? "text-gain" : isLoss(chgPct) ? "text-loss" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 0)}</span>
          {chgPct !== null && chgPct !== undefined && (
            <span className={cn("text-xs tabular-nums font-medium", colorClass)}>
              {fmtChange(chgPct, 2, true)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── VIX ────────────────────────────────────────────────────────────
  if (card.key === "vix") {
    const chg = card.change;
    // VIX going up = bearish (green = loss)
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums">{fmt(card.value, 2)}</span>
          {chg !== null && chg !== undefined && chg !== 0 && (
            <span className={cn("text-xs tabular-nums font-medium", colorClass)}>
              {fmtChange(chg, 2)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── Fear & Greed ────────────────────────────────────────────────────
  if (card.key === "fear_greed") {
    const score = card.value ?? 0;
    const pct = Math.min(100, Math.max(0, score));
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums">{card.value ?? "—"}</span>
          {card.meta && (
            <span className="text-[10px] text-muted-foreground">{card.meta}</span>
          )}
        </div>
        {/* Progress bar */}
        <div className="mt-1.5 h-1.5 bg-muted/50 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              background: pct >= 55 ? "#f87171" : pct >= 45 ? "#9ca3af" : "#34d399",
            }}
          />
        </div>
        <div className="mt-1">
          <SignalBadge signal={card.signal} text={card.signalText} />
        </div>
      </div>
    );
  }

  // ─── US 10Y ─────────────────────────────────────────────────────────
  if (card.key === "us_10y") {
    const chg = card.change;
    // Rising yield = bearish
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums">{card.value !== null && card.value !== undefined ? `${card.value.toFixed(2)}%` : "—"}</span>
          {chg !== null && chg !== undefined && chg !== 0 && (
            <span className={cn("text-xs tabular-nums font-medium", colorClass)}>
              {fmtChange(chg, 3, false)} pp
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── US CPI ─────────────────────────────────────────────────────────
  if (card.key === "us_cpi") {
    const chg = card.change;
    // Rising CPI = bearish
    const colorClass = isGain(chg) ? "text-loss" : isLoss(chg) ? "text-gain" : "text-muted-foreground";
    return (
      <div className="bg-card border border-border rounded-lg p-3" data-testid={`overview-card-${card.key}`}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{card.label}</span>
          {card.stale && <AlertCircle className="w-3 h-3 text-muted-foreground/50" />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold tabular-nums">{card.value !== null && card.value !== undefined ? `${card.value.toFixed(1)}%` : "—"}</span>
          {chg !== null && chg !== undefined && chg !== 0 && (
            <span className={cn("text-xs tabular-nums font-medium", colorClass)}>
              {fmtChange(chg, 1, false)} pp
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <SignalBadge signal={card.signal} text={card.signalText} />
          <Sparkline data={card.sparkline} signal={card.signal} />
        </div>
      </div>
    );
  }

  // ─── fallback generic ────────────────────────────────────────────────
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
    staleTime: 4 * 60 * 1000,
  });

  const tw = data?.tw ?? [];
  const us = data?.us ?? [];

  const updatedTime = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString("zh-TW", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="space-y-3" data-testid="market-overview-section">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">市場指標</h2>
          {updatedTime && (
            <span className="text-[10px] text-muted-foreground tabular-nums">更新 {updatedTime}</span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-muted/40 transition-colors disabled:opacity-50"
          title="刷新市場指標"
          data-testid="btn-refresh-market-overview"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", isFetching && "animate-spin")} />
        </button>
      </div>

      {isError && (
        <div className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          市場指標載入失敗，顯示最後緩存數據。
        </div>
      )}

      {/* TW indicators */}
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground tracking-widest mb-2 uppercase">台灣市場</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {isLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-lg p-3 space-y-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-3 w-12" />
                </div>
              ))
            : tw.map((card) => (
                <OverviewCard key={card.key} card={card} isLoading={false} />
              ))}
        </div>
      </div>

      {/* US indicators — DJIA first (guaranteed by server assembly order) */}
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground tracking-widest mb-2 uppercase">美國市場</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-lg p-3 space-y-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-3 w-12" />
                </div>
              ))
            : us.map((card) => (
                <OverviewCard key={card.key} card={card} isLoading={false} />
              ))}
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
            <span className="text-sm font-medium truncate">{stock.symbol}</span>
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
    staleTime: 55_000,
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

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          title="加權指數"
          value={twiiIdx ? twiiIdx.price.toLocaleString() : "—"}
          change={twiiIdx?.changePercent ?? 0}
          icon={BarChart3}
          isLoading={isLoading}
          isStale={twiiIdx?.isStale}
          dataAge={twiiIdx ? formatDataAge(twiiIdx.dataTimestamp) : undefined}
        />
        <KPICard
          title="台指期"
          value={twiiIdx ? twiiIdx.price.toLocaleString() : "—"}
          change={twiiIdx?.changePercent ?? 0}
          icon={TrendingUp}
          isLoading={isLoading}
          isStale={twiiIdx?.isStale}
          dataAge={twiiIdx ? formatDataAge(twiiIdx.dataTimestamp) : undefined}
        />
        <KPICard
          title="美元/台幣"
          value={usdtwd ? usdtwd.price.toFixed(2) : "—"}
          change={usdtwd?.changePercent ?? 0}
          icon={DollarSign}
          isLoading={isLoading}
          isStale={usdtwd?.isStale}
          dataAge={usdtwd ? formatDataAge(usdtwd.dataTimestamp) : undefined}
        />
        <KPICard
          title="S&P 500"
          value={sp500 ? sp500.price.toLocaleString() : "—"}
          change={sp500?.changePercent ?? 0}
          icon={TrendingUp}
          isLoading={isLoading}
          isStale={sp500?.isStale}
          dataAge={sp500 ? formatDataAge(sp500.dataTimestamp) : undefined}
        />
      </div>

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
