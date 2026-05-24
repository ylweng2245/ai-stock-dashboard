import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EarningsRow {
  symbol: string;
  name: string;
  market: "US" | "TW" | string;
  earningsDate: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
}

interface EarningsCalendarData {
  rows: EarningsRow[];
  fetchedAt: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRevenue(val: number | null): string {
  if (val === null) return "—";
  if (Math.abs(val) >= 1_000_000_000) {
    return `$${(val / 1_000_000_000).toFixed(1)}B`;
  }
  if (Math.abs(val) >= 1_000_000) {
    return `$${(val / 1_000_000).toFixed(0)}M`;
  }
  return `$${val.toLocaleString()}`;
}

function daysFromNow(dateStr: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function isWithinDays(dateStr: string, days: number): boolean {
  const d = daysFromNow(dateStr);
  return d >= 0 && d <= days;
}

function isUpcoming30(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = daysFromNow(dateStr);
  return d >= 0 && d <= 30;
}

// ─── Market Badge ──────────────────────────────────────────────────────────────

function MarketBadge({ market }: { market: string }) {
  if (market === "US") {
    return (
      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-[#1cb8be]/40 bg-[#1cb8be]/10 text-[#1cb8be]">
        US
      </span>
    );
  }
  if (market === "TW") {
    return (
      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-orange-500/40 bg-orange-500/10 text-orange-400">
        TW
      </span>
    );
  }
  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-white/20 bg-white/5 text-muted-foreground">
      {market}
    </span>
  );
}

// ─── Earnings Row ──────────────────────────────────────────────────────────────

function EarningsRowItem({ row }: { row: EarningsRow }) {
  const hasDate = !!row.earningsDate;
  const days = hasDate ? daysFromNow(row.earningsDate!) : null;
  const isThisWeek = hasDate && isWithinDays(row.earningsDate!, 7);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors">
      {/* Symbol + Name */}
      <div className="flex items-center gap-2 min-w-0 flex-[2]">
        <span className="text-[13px] font-bold text-[#9fe7f8] shrink-0">{row.symbol}</span>
        <span className="text-[12px] text-muted-foreground truncate">{row.name}</span>
        <MarketBadge market={row.market} />
      </div>

      {/* Earnings Date */}
      <div className="flex items-center gap-1.5 flex-[1.5] min-w-0">
        {hasDate ? (
          <>
            <span className="text-[13px] text-foreground/90 tabular-nums">
              {row.earningsDate}
            </span>
            {isThisWeek && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-[#ef4444] shrink-0">
                本週
              </span>
            )}
          </>
        ) : (
          <span className="text-[12px] text-muted-foreground/50">尚無資料</span>
        )}
      </div>

      {/* EPS Estimate */}
      <div className="flex-1 text-right">
        {row.epsEstimate != null ? (
          <span className="text-[12px] tabular-nums text-foreground/80">
            {row.epsEstimate.toFixed(2)}
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground/40">—</span>
        )}
      </div>

      {/* Revenue Estimate */}
      <div className="flex-1 text-right">
        <span className="text-[12px] tabular-nums text-foreground/80">
          {formatRevenue(row.revenueEstimate)}
        </span>
      </div>

      {/* Days Until */}
      <div className="flex-none w-20 text-right">
        {days !== null ? (
          <span className={cn(
            "text-[12px] font-semibold tabular-nums",
            days === 0
              ? "text-[#ef4444]"
              : days <= 7
              ? "text-orange-400"
              : "text-muted-foreground"
          )}>
            {days === 0 ? "今天" : `+${days}天`}
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground/40">—</span>
        )}
      </div>
    </div>
  );
}

// ─── Table Header ──────────────────────────────────────────────────────────────

function TableHeader() {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-white/8 bg-white/[0.015]">
      <div className="flex-[2] text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        標的
      </div>
      <div className="flex-[1.5] text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        財報日期
      </div>
      <div className="flex-1 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        預估 EPS
      </div>
      <div className="flex-1 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        預估營收
      </div>
      <div className="w-20 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        距今
      </div>
    </div>
  );
}

// ─── Skeleton Rows ─────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
          <div className="flex-[2]"><Skeleton className="h-4 w-32" /></div>
          <div className="flex-[1.5]"><Skeleton className="h-4 w-24" /></div>
          <div className="flex-1 flex justify-end"><Skeleton className="h-4 w-10" /></div>
          <div className="flex-1 flex justify-end"><Skeleton className="h-4 w-14" /></div>
          <div className="w-20 flex justify-end"><Skeleton className="h-4 w-10" /></div>
        </div>
      ))}
    </>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function EarningsCalendar() {
  const [activeTab, setActiveTab] = useState<"upcoming" | "all">("upcoming");

  const { data, isLoading, isError } = useQuery<EarningsCalendarData>({
    queryKey: ["/api/earnings-calendar"],
    queryFn: () => apiRequest("GET", "/api/earnings-calendar").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Sort: rows with a date first (ascending), then no-date rows
  const allRows = [...(data?.rows ?? [])].sort((a, b) => {
    if (a.earningsDate && b.earningsDate) {
      return new Date(a.earningsDate).getTime() - new Date(b.earningsDate).getTime();
    }
    if (a.earningsDate) return -1;
    if (b.earningsDate) return 1;
    return 0;
  });

  const upcomingRows = allRows.filter((r) => isUpcoming30(r.earningsDate));
  const displayRows = activeTab === "upcoming" ? upcomingRows : allRows;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-[28px] font-bold tracking-tight flex items-center gap-2">
          <Calendar className="w-6 h-6 text-[#1cb8be]" />
          財報日曆
        </h1>
        <p className="text-[13px] text-muted-foreground mt-1.5">
          自選股下次財報日期總覽，數據來源：Yahoo Finance / Finnhub
        </p>
      </div>

      {/* Tab Selector */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setActiveTab("upcoming")}
          className={cn(
            "text-[13px] px-4 py-1.5 rounded-lg border transition-colors font-medium",
            activeTab === "upcoming"
              ? "border-[#1cb8be]/60 bg-[#1cb8be]/10 text-[#1cb8be]"
              : "border-white/10 text-muted-foreground hover:border-white/20 hover:text-foreground/80"
          )}
        >
          即將公布
          {!isLoading && upcomingRows.length > 0 && (
            <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-[#1cb8be]/20 text-[#1cb8be]">
              {upcomingRows.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("all")}
          className={cn(
            "text-[13px] px-4 py-1.5 rounded-lg border transition-colors font-medium",
            activeTab === "all"
              ? "border-[#1cb8be]/60 bg-[#1cb8be]/10 text-[#1cb8be]"
              : "border-white/10 text-muted-foreground hover:border-white/20 hover:text-foreground/80"
          )}
        >
          全部
          {!isLoading && allRows.length > 0 && (
            <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-white/8 text-muted-foreground">
              {allRows.length}
            </span>
          )}
        </button>
      </div>

      {/* Card */}
      <Card className="border-border">
        <TableHeader />

        {isLoading && <SkeletonRows />}

        {isError && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
            <AlertCircle className="w-8 h-8 opacity-40" />
            <p className="text-[13px]">載入失敗，請重新整理</p>
          </div>
        )}

        {!isLoading && !isError && displayRows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
            <Calendar className="w-10 h-10 opacity-20" />
            <p className="text-[14px] font-medium">
              {activeTab === "upcoming" ? "未來 30 天內無財報排程" : "尚無財報資料"}
            </p>
            <p className="text-[12px] opacity-60">請先到市場總覽新增自選股標的</p>
          </div>
        )}

        {!isLoading && !isError && displayRows.map((row) => (
          <EarningsRowItem key={row.symbol} row={row} />
        ))}
      </Card>

      {/* Footer note */}
      <p className="text-[11px] text-muted-foreground/60 flex items-center gap-1.5">
        <Clock className="w-3 h-3" />
        財報數據由每日 Cron 同步，如需最新資料請至基本面分析頁手動重新整理
      </p>
    </div>
  );
}
