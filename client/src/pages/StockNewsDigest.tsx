import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  RefreshCw, Clock, TrendingUp, TrendingDown, Minus,
  ExternalLink, ChevronDown, ChevronUp, Newspaper,
  AlertCircle, Loader2, BookOpen, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DigestEntry {
  id: number;
  ticker: string;
  digestDate: string;
  generatedAt: number;
  priceClose: number | null;
  priceChangePct: number | null;
  summaryText: string;
  aiTakeaway?: string; // removed in v5.2, kept for DB compatibility
  sentimentLabel: string;
  sourceCount: number;
  status: string;
}

interface StockDigestData {
  symbol: string;
  name: string;
  sectorTag: string;
  digests: DigestEntry[];
}

interface DigestSource {
  id: number;
  sourceName: string;
  articleTitle: string;
  articleUrl: string;
  publishedAt: string;
  sourceDomain: string;
}

interface PageData {
  stocks: StockDigestData[];
  stats: {
    totalStocks: number;
    updatedToday: number;
    historyDays: number;
    maxSourceCount: number;
  };
  lastUpdated: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${m}月${d}日`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-TW", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
  }) + " ET";
}

function formatLastUpdated(ms: number | null): string {
  if (!ms) return "尚未更新";
  return new Date(ms).toLocaleString("zh-TW", {
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "America/New_York",
  }) + " ET";
}

function tickerInitials(symbol: string): string {
  return symbol.slice(0, 2).toUpperCase();
}

// ─── Source Drawer ────────────────────────────────────────────────────────────

function SourceDrawer({
  digestId,
  onClose,
}: {
  digestId: number;
  onClose: () => void;
}) {
  const { data: sources, isLoading } = useQuery<DigestSource[]>({
    queryKey: ["/api/news-digest/sources", digestId],
    queryFn: () => apiRequest("GET", `/api/news-digest/${digestId}/sources`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg max-h-[80vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[#0d1726] border border-white/10 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <span className="font-semibold text-sm text-foreground">原始新聞來源</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-3 space-y-3">
          {isLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              載入中…
            </div>
          )}
          {!isLoading && (!sources || sources.length === 0) && (
            <p className="text-center text-muted-foreground text-sm py-8">無來源記錄</p>
          )}
          {sources?.map((src, i) => (
            <a
              key={src.id}
              href={src.articleUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 p-3 rounded-xl border border-white/6 bg-white/2 hover:bg-white/5 hover:border-white/12 transition-colors group"
            >
              <div className="w-8 h-8 shrink-0 rounded-full bg-[#163042] border border-white/10 flex items-center justify-center text-[11px] font-bold text-[#9fe7f8]">
                {src.sourceName.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                  <span className="text-[11px] font-semibold text-[#66c6df]">{src.sourceName || src.sourceDomain}</span>
                  {src.publishedAt && (
                    <span className="text-[10px] text-muted-foreground">{src.publishedAt}</span>
                  )}
                </div>
                <p className="text-[13px] text-foreground/90 line-clamp-2 leading-snug group-hover:text-foreground transition-colors">
                  {src.articleTitle || "（無標題）"}
                </p>
              </div>
              <ExternalLink className="w-3.5 h-3.5 shrink-0 text-muted-foreground group-hover:text-[#66c6df] transition-colors mt-0.5" />
            </a>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-white/8">
          <p className="text-[11px] text-muted-foreground">點擊各條新聞在新分頁開啟原始來源</p>
        </div>
      </div>
    </div>
  );
}

// ─── Digest Timeline Item ─────────────────────────────────────────────────────

function DigestTimelineItem({
  entry,
  isFirst,
}: {
  entry: DigestEntry;
  isFirst: boolean;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const changePct = entry.priceChangePct;
  const isUp = changePct != null && changePct > 0;
  const isDown = changePct != null && changePct < 0;

  const sentimentColor =
    entry.sentimentLabel === "positive"
      ? "text-gain"
      : entry.sentimentLabel === "negative"
      ? "text-loss"
      : "text-muted-foreground";

  if (entry.status === "error") {
    return (
      <div className="relative pl-5">
        <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-[#162338] border-2 border-destructive/60" />
        <div className="text-[13px] text-destructive/80 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{formatDate(entry.digestDate)} — 更新失敗，請重試</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-5">
      {/* Timeline dot */}
      <div
        className={cn(
          "absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full border-2",
          isFirst
            ? "bg-[#66c6df] border-[#66c6df] shadow-[0_0_6px_rgba(102,198,223,0.6)]"
            : "bg-[#163042] border-[#66c6df]/50"
        )}
      />

      {/* Date + time */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[14px] font-bold text-foreground/90">{formatDate(entry.digestDate)}</span>
        {entry.generatedAt > 0 && (
          <span className="text-[11px] text-muted-foreground">{formatTime(entry.generatedAt)}</span>
        )}
      </div>

      {/* Price row */}
      {entry.priceClose != null && (
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="text-[15px] font-bold">${entry.priceClose.toFixed(2)}</span>
          {changePct != null && (
            <span className={cn("flex items-center gap-0.5 text-[13px] font-semibold", isUp ? "text-gain" : isDown ? "text-loss" : "text-muted-foreground")}>
              {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : isDown ? <TrendingDown className="w-3.5 h-3.5" /> : <Minus className="w-3 h-3" />}
              {isUp ? "+" : ""}{changePct.toFixed(2)}%
            </span>
          )}
          {entry.sourceCount > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#66c6df]/10 text-[#b4eaf7] font-semibold border border-[#66c6df]/15">
              {entry.sourceCount} 個來源
            </span>
          )}
        </div>
      )}

      {/* Summary text */}
      {entry.summaryText && (
        <p className="text-[14px] text-foreground/80 leading-relaxed mb-2">
          {entry.summaryText}
        </p>
      )}

      {/* Sources */}
      {entry.sourceCount > 0 && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-[#66c6df] transition-colors mt-1"
        >
          <BookOpen className="w-3.5 h-3.5" />
          查看 {entry.sourceCount} 個原始來源
          <ExternalLink className="w-3 h-3" />
        </button>
      )}

      {drawerOpen && (
        <SourceDrawer digestId={entry.id} onClose={() => setDrawerOpen(false)} />
      )}
    </div>
  );
}

// ─── Stock Digest Card ────────────────────────────────────────────────────────

function StockDigestCard({
  stock,
  onScrollTo,
  isActive,
}: {
  stock: StockDigestData;
  onScrollTo?: () => void;
  isActive?: boolean;
}) {
  const latestDigest = stock.digests[0];

  const latestChangePct = latestDigest?.priceChangePct;
  const isUp = latestChangePct != null && latestChangePct > 0;
  const isDown = latestChangePct != null && latestChangePct < 0;

  return (
    <article
      className={cn(
        "flex flex-col rounded-[18px] border bg-gradient-to-b from-[rgba(17,29,48,0.95)] to-[rgba(12,22,36,0.96)] shadow-[0_10px_30px_rgba(0,0,0,0.28)]",
        isActive ? "border-[#66c6df]/30" : "border-white/8"
      )}
      style={{ minHeight: 560 }}
    >
      {/* Card Header */}
      <div className="flex items-start justify-between gap-3 p-5 pb-3">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 shrink-0 rounded-[14px] bg-[#66c6df]/12 flex items-center justify-center text-[#9fe7f8] font-bold text-[15px]">
            {tickerInitials(stock.symbol)}
          </div>
          <div>
            <h4 className="text-[20px] font-bold leading-tight">
              {stock.name}{" "}
              <span className="text-muted-foreground text-[14px] font-normal ml-1">{stock.symbol}</span>
            </h4>
            {stock.sectorTag && (
              <p className="text-[12px] text-muted-foreground mt-0.5">{stock.sectorTag}</p>
            )}
          </div>
        </div>
        {/* Latest price badge */}
        {latestDigest?.priceClose != null && (
          <div className="shrink-0 text-right">
            <div className="text-[15px] font-bold">${latestDigest.priceClose.toFixed(2)}</div>
            {latestChangePct != null && (
              <div className={cn("text-[12px] font-semibold", isUp ? "text-gain" : isDown ? "text-loss" : "text-muted-foreground")}>
                {isUp ? "+" : ""}{latestChangePct.toFixed(2)}%
              </div>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="h-px bg-white/6 mx-5" />

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-5 py-4" style={{ maxHeight: 460 }}>
        {/* Timeline track */}
        <div
          className="relative pl-1 space-y-5"
          style={{
            backgroundImage: "linear-gradient(180deg, rgba(102,198,223,0.35) 0%, rgba(102,198,223,0.04) 100%)",
            backgroundSize: "2px 100%",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "4px 0",
          }}
        >
          {stock.digests.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
              <Newspaper className="w-8 h-8 opacity-30" />
              <p className="text-[13px]">尚未建立今日新聞彙總</p>
              <p className="text-[12px] opacity-60">點擊右上方「更新新聞彙總」即可產生</p>
            </div>
          )}
          {stock.digests.map((entry, i) => (
            <DigestTimelineItem key={entry.id} entry={entry} isFirst={i === 0} />
          ))}
        </div>
      </div>
    </article>
  );
}

// ─── Watchlist Sidebar ────────────────────────────────────────────────────────

function DigestWatchlistSidebar({
  stocks,
  activeSymbol,
  onSelect,
}: {
  stocks: StockDigestData[];
  activeSymbol: string | null;
  onSelect: (symbol: string) => void;
}) {
  return (
    <aside className="w-[220px] shrink-0 border-l border-border bg-sidebar flex flex-col">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-[14px] font-semibold">分析標的</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">美股自選</p>
      </div>
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {stocks.map((s) => {
          const latest = s.digests[0];
          const pct = latest?.priceChangePct;
          const isUp = pct != null && pct > 0;
          const isDown = pct != null && pct < 0;
          const isActive = s.symbol === activeSymbol;
          return (
            <button
              key={s.symbol}
              onClick={() => onSelect(s.symbol)}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-colors",
                isActive
                  ? "bg-[#66c6df]/12 border border-[#66c6df]/15"
                  : "border border-transparent hover:bg-muted/30"
              )}
            >
              <div>
                <div className="text-[13px] font-semibold">{s.symbol}</div>
                <div className="text-[11px] text-muted-foreground truncate max-w-[110px]">{s.name}</div>
              </div>
              {pct != null && (
                <span className={cn("text-[12px] font-semibold shrink-0", isUp ? "text-gain" : isDown ? "text-loss" : "text-muted-foreground")}>
                  {isUp ? "+" : ""}{pct.toFixed(2)}%
                </span>
              )}
            </button>
          );
        })}
        {stocks.length === 0 && (
          <p className="text-[12px] text-muted-foreground px-3 py-4">尚未新增美股自選標的</p>
        )}
      </div>
    </aside>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function StockNewsDigest() {
  const queryClient = useQueryClient();
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const { data, isLoading, isError } = useQuery<PageData>({
    queryKey: ["/api/news-digest/stocks"],
    queryFn: () => apiRequest("GET", "/api/news-digest/stocks").then((r) => r.json()),
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const updateMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/news-digest/update").then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/news-digest/stocks"] });
    },
  });

  const handleScrollTo = useCallback((symbol: string) => {
    setActiveSymbol(symbol);
    const el = cardRefs.current[symbol];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const stocks = data?.stocks ?? [];
  const stats = data?.stats;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 max-w-[1400px] mx-auto">

          {/* Topbar */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-[32px] font-bold tracking-tight">個股每日新聞彙總</h2>
              <p className="text-[14px] text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
                僅針對美股自選個股，依自選順序顯示。每張卡片保留該股票的歷史新聞摘要時間軸，可向下捲動回看過去彙總，並保留原始來源連結。
              </p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/8 bg-white/2 text-[12px] text-muted-foreground">
                <Clock className="w-3.5 h-3.5" />
                {data?.lastUpdated ? `最後更新 ${formatLastUpdated(data.lastUpdated)}` : "尚未更新"}
              </div>
              <Button
                size="sm"
                onClick={() => updateMutation.mutate()}
                disabled={updateMutation.isPending}
                className="gap-1.5 bg-gradient-to-b from-[#1f9dc3] to-[#187e9e] hover:from-[#2ab0d8] hover:to-[#1a8fb3] border-[#66c6df]/25 text-white font-semibold"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {updateMutation.isPending ? "更新中…" : "更新新聞彙總"}
              </Button>
            </div>
          </div>

          {/* Error from update */}
          {updateMutation.isError && (
            <div className="mb-4 flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-[13px]">
              <AlertCircle className="w-4 h-4 shrink-0" />
              更新失敗：{(updateMutation.error as any)?.message ?? "未知錯誤"}
            </div>
          )}

          {/* Stats bar */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                { label: "自選股票數", value: stats.totalStocks, sub: "依 watchlist 順序排列" },
                { label: "今日已更新", value: `${stats.updatedToday} / ${stats.totalStocks}`, sub: stats.updatedToday < stats.totalStocks ? `${stats.totalStocks - stats.updatedToday} 檔待刷新` : "全部已更新" },
                { label: "歷史天數", value: stats.historyDays, sub: "可保留最多 180 天" },
                { label: "最大來源數", value: stats.maxSourceCount, sub: "當前卡片最高來源數" },
              ].map((s) => (
                <div key={s.label} className="p-4 rounded-xl border border-white/6 bg-white/[0.02]">
                  <div className="text-[11px] text-muted-foreground mb-1">{s.label}</div>
                  <div className="text-[22px] font-bold">{s.value}</div>
                  <div className="text-[11px] text-muted-foreground/60 mt-0.5">{s.sub}</div>
                </div>
              ))}
            </div>
          )}

          {/* Loading skeleton */}
          {isLoading && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rounded-[18px] border border-white/8 bg-white/[0.02] animate-pulse" style={{ minHeight: 400 }} />
              ))}
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <AlertCircle className="w-10 h-10 opacity-40" />
              <p className="text-[14px]">載入失敗，請重新整理</p>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !isError && stocks.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <Newspaper className="w-12 h-12 opacity-20" />
              <p className="text-[15px] font-medium">尚未新增美股自選標的</p>
              <p className="text-[13px] opacity-60">請先到「市場總覽」的自選清單新增美股標的</p>
            </div>
          )}

          {/* Cards grid */}
          {!isLoading && stocks.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {stocks.map((stock) => (
                <div
                  key={stock.symbol}
                  ref={(el) => { cardRefs.current[stock.symbol] = el; }}
                >
                  <StockDigestCard
                    stock={stock}
                    isActive={activeSymbol === stock.symbol}
                    onScrollTo={() => handleScrollTo(stock.symbol)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right sidebar */}
      <DigestWatchlistSidebar
        stocks={stocks}
        activeSymbol={activeSymbol}
        onSelect={handleScrollTo}
      />
    </div>
  );
}
