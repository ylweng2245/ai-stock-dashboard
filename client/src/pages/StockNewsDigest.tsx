import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  Clock, TrendingUp, TrendingDown, Minus,
  ExternalLink, Newspaper, AlertCircle, X,
} from "lucide-react";
import { AnalysisSymbolSidebarDesktop } from "@/components/AnalysisSymbolSidebar";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DigestEntry {
  id: number;
  ticker: string;
  digestDate: string;
  generatedAt: number;
  priceClose: number | null;
  priceChangePct: number | null;
  summaryText: string;
  aiTakeaway?: string;
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
  sortOrder: number; // 0-indexed → displayed as [sortOrder+1]
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

// ─── Text Parser ──────────────────────────────────────────────────────────────

interface QuestionBlock {
  title: string;
  bulls: string;
  bears: string;
  bullSourceIds: number[]; // 1-indexed source numbers
  bearSourceIds: number[];
}

/** Parse "[6, 9]" → [6, 9] */
function parseSourceIds(raw: string): number[] {
  if (!raw) return [];
  return raw
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

function parseSummaryText(raw: string): QuestionBlock[] {
  if (!raw) return [];
  const text = raw.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();

  const questionPattern = /\*\*問題\s*\d+[：:][^*]*\*\*/g;
  const matches = [...text.matchAll(questionPattern)];

  if (matches.length === 0) {
    const { bulls, bears, bullSources, bearSources } = extractBullsBears(text);
    if (bulls || bears) {
      return [{
        title: "",
        bulls,
        bears,
        bullSourceIds: parseSourceIds(bullSources),
        bearSourceIds: parseSourceIds(bearSources),
      }];
    }
    return [];
  }

  return matches.map((match, i) => {
    const startIdx = (match.index ?? 0) + match[0].length;
    const endIdx = matches[i + 1]?.index ?? text.length;
    const title = match[0].replace(/\*\*/g, "").trim();
    const chunk = text.slice(startIdx, endIdx);
    const { bulls, bears, bullSources, bearSources } = extractBullsBears(chunk);
    return {
      title,
      bulls,
      bears,
      bullSourceIds: parseSourceIds(bullSources),
      bearSourceIds: parseSourceIds(bearSources),
    };
  });
}

function extractBullsBears(chunk: string) {
  const bullMatch = chunk.match(
    /(?:🐂\s*\*\*多頭觀點[：:]?\*\*|🐂\s*多頭觀點[：:]?|\*\*多頭觀點[：:]\*\*)(.*?)(?=(?:🐻|$))/s
  );
  const bearMatch = chunk.match(
    /(?:🐻\s*\*\*空頭觀點[：:]?\*\*|🐻\s*空頭觀點[：:]?|\*\*空頭觀點[：:]\*\*)(.*?)(?=$)/s
  );
  const cleanBull = bullMatch ? cleanSegment(bullMatch[1]) : "";
  const cleanBear = bearMatch ? cleanSegment(bearMatch[1]) : "";
  const { text: bulls, sources: bullSources } = extractSources(cleanBull);
  const { text: bears, sources: bearSources } = extractSources(cleanBear);
  return { bulls, bears, bullSources, bearSources };
}

function cleanSegment(s: string): string {
  return s.replace(/\*\*/g, "").replace(/^\s*[：:]\s*/, "").trim();
}

function extractSources(text: string): { text: string; sources: string } {
  const m = text.match(/[-–]\s*來源[：:]\s*(\[[^\]]+\])\s*$/);
  if (m) return { text: text.slice(0, m.index).trim(), sources: m[1] };
  return { text: text.trim(), sources: "" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}月${d}日`;
}
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-TW", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei",
  });
}
function formatLastUpdated(ms: number | null): string {
  if (!ms) return "尚未更新";
  return new Date(ms).toLocaleString("zh-TW", {
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Taipei",
  });
}

// ─── Inline Source Popover ────────────────────────────────────────────────────

function InlineSourcePopover({
  sourceIds,    // 1-indexed numbers from text
  allSources,   // full list for this digest (sortOrder 0-indexed)
}: {
  sourceIds: number[];
  allSources: DigestSource[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Filter matching sources: sourceId 1 → sortOrder 0
  const matched = allSources.filter((s) => sourceIds.includes(s.sortOrder + 1));

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (matched.length === 0) {
    // No matched sources yet loaded — still show the label but not clickable
    return (
      <span className="ml-1.5 text-[11px] text-muted-foreground">
        — 來源 [{sourceIds.join(", ")}]
      </span>
    );
  }

  return (
    <span ref={ref} className="relative inline-block ml-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "text-[11px] font-medium px-1.5 py-0.5 rounded border transition-colors",
          open
            ? "bg-[#66c6df]/15 border-[#66c6df]/40 text-[#9fe7f8]"
            : "bg-white/4 border-white/10 text-muted-foreground hover:text-[#9fe7f8] hover:border-[#66c6df]/30"
        )}
      >
        來源 [{sourceIds.join(", ")}]
      </button>

      {open && (
        <div className="absolute z-50 bottom-full mb-2 left-0 w-80 rounded-xl bg-[#0d1726] border border-white/12 shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/8">
            <span className="text-[11px] font-semibold text-foreground/80">原始來源</span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5 p-2 max-h-60 overflow-y-auto">
            {matched.map((src) => (
              <a
                key={src.id}
                href={src.articleUrl || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2.5 p-2 rounded-lg border border-white/6 bg-white/2 hover:bg-white/5 hover:border-white/12 transition-colors group"
              >
                <div className="w-6 h-6 shrink-0 rounded-md bg-[#163042] border border-white/10 flex items-center justify-center text-[10px] font-bold text-[#9fe7f8]">
                  {src.sortOrder + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                    <span className="text-[10px] font-semibold text-[#66c6df]">{src.sourceName || src.sourceDomain}</span>
                    {src.publishedAt && (
                      <span className="text-[10px] text-muted-foreground">{src.publishedAt}</span>
                    )}
                  </div>
                  <p className="text-[12px] text-foreground/85 line-clamp-2 leading-snug group-hover:text-foreground transition-colors">
                    {src.articleTitle || "（無標題）"}
                  </p>
                </div>
                <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground group-hover:text-[#66c6df] transition-colors mt-0.5" />
              </a>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Bulls/Bears Column ────────────────────────────────────────────────────────

function BullBearColumn({
  side,
  blocks,
  allSources,
}: {
  side: "bull" | "bear";
  blocks: QuestionBlock[];
  allSources: DigestSource[];
}) {
  const isBull = side === "bull";

  return (
    <div
      className={cn(
        "flex-1 min-w-0 rounded-xl p-4 flex flex-col gap-3",
        isBull
          ? "bg-[rgba(239,68,68,0.04)] border border-[rgba(239,68,68,0.12)]"
          : "bg-[rgba(16,185,129,0.04)] border border-[rgba(16,185,129,0.12)]"
      )}
    >
      {/* Column header */}
      <div className={cn(
        "flex items-center gap-2 pb-2 border-b",
        isBull ? "border-[rgba(239,68,68,0.15)]" : "border-[rgba(16,185,129,0.15)]"
      )}>
        <span className="text-base">{isBull ? "🐂" : "🐻"}</span>
        <span className={cn(
          "text-[13px] font-bold tracking-wide",
          isBull ? "text-[#ef4444]" : "text-[#10b981]"
        )}>
          {isBull ? "多頭觀點" : "空頭觀點"}
        </span>
      </div>

      {/* Question blocks */}
      <div className="flex flex-col gap-4 flex-1">
        {blocks.length === 0 && (
          <p className="text-[13px] text-muted-foreground/50 italic">無資料</p>
        )}
        {blocks.map((blk, i) => {
          const content = isBull ? blk.bulls : blk.bears;
          const sourceIds = isBull ? blk.bullSourceIds : blk.bearSourceIds;
          if (!content) return null;
          return (
            <div key={i} className="flex flex-col gap-1.5">
              {blk.title && (
                <div className="text-[14px] font-bold text-[#66c6df] leading-snug">
                  {blk.title}
                </div>
              )}
              <p className="text-[13px] text-foreground/85 leading-relaxed">
                {content}
                {sourceIds.length > 0 && (
                  <InlineSourcePopover
                    sourceIds={sourceIds}
                    allSources={allSources}
                  />
                )}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Single Digest Timeline Item ──────────────────────────────────────────────

function DigestTimelineItem({
  entry,
  isFirst,
}: {
  entry: DigestEntry;
  isFirst: boolean;
}) {
  const changePct = entry.priceChangePct;
  const isUp = changePct != null && changePct > 0;
  const isDown = changePct != null && changePct < 0;

  const blocks = parseSummaryText(entry.summaryText);

  // Load all sources for this digest once
  const { data: allSources = [] } = useQuery<DigestSource[]>({
    queryKey: ["/api/news-digest/sources", entry.id],
    queryFn: () =>
      apiRequest("GET", `/api/news-digest/${entry.id}/sources`).then((r) => r.json()),
    staleTime: 10 * 60 * 1000,
    enabled: entry.sourceCount > 0,
  });

  if (entry.status === "error") {
    return (
      <div className="relative pl-6">
        <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-[#162338] border-2 border-destructive/60" />
        <div className="text-[13px] text-destructive/80 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{formatDate(entry.digestDate)} — 更新失敗，請重試</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-6">
      <div
        className={cn(
          "absolute left-0 top-2 w-2.5 h-2.5 rounded-full border-2",
          isFirst
            ? "bg-[#66c6df] border-[#66c6df] shadow-[0_0_6px_rgba(102,198,223,0.6)]"
            : "bg-[#163042] border-[#66c6df]/50"
        )}
      />

      {/* Date + price row */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="text-[15px] font-bold text-foreground/90">{formatDate(entry.digestDate)}</span>
        {entry.generatedAt > 0 && (
          <span className="text-[11px] text-muted-foreground">{formatTime(entry.generatedAt)}</span>
        )}
        {entry.priceClose != null && (
          <>
            <span className="text-[14px] font-bold">${entry.priceClose.toFixed(2)}</span>
            {changePct != null && (
              <span className={cn("flex items-center gap-0.5 text-[13px] font-semibold",
                isUp ? "text-gain" : isDown ? "text-loss" : "text-muted-foreground"
              )}>
                {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : isDown ? <TrendingDown className="w-3.5 h-3.5" /> : <Minus className="w-3 h-3" />}
                {isUp ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            )}
          </>
        )}
        {entry.sourceCount > 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#66c6df]/10 text-[#b4eaf7] font-semibold border border-[#66c6df]/15">
            {entry.sourceCount} 個來源
          </span>
        )}
      </div>

      {/* Bulls / Bears split */}
      {blocks.length > 0 ? (
        <div className="flex gap-3">
          <BullBearColumn side="bull" blocks={blocks} allSources={allSources} />
          <BullBearColumn side="bear" blocks={blocks} allSources={allSources} />
        </div>
      ) : entry.summaryText ? (
        <p className="text-[13px] text-foreground/80 leading-relaxed">{entry.summaryText}</p>
      ) : null}
    </div>
  );
}

// ─── Full-Width Stock Card ─────────────────────────────────────────────────────

function StockDigestCard({ stock }: { stock: StockDigestData }) {
  return (
    <article className="flex flex-col rounded-[18px] border border-[#66c6df]/20 bg-gradient-to-b from-[rgba(17,29,48,0.97)] to-[rgba(12,22,36,0.98)] shadow-[0_12px_40px_rgba(0,0,0,0.32)]">
      {/* Card Header — compact strip */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/6">
        <div className={cn(
          "px-2.5 py-1 rounded-lg bg-[#66c6df]/12 text-[#9fe7f8] font-bold tracking-wide shrink-0",
          stock.symbol.length <= 4 ? "text-[13px]" : "text-[11px]"
        )}>
          {stock.symbol}
        </div>
        <h4 className="text-[22px] font-bold leading-tight flex-1 min-w-0 truncate">{stock.name}</h4>
        {stock.sectorTag && (
          <span className="text-[11px] text-muted-foreground shrink-0 hidden sm:block">{stock.sectorTag}</span>
        )}
        {stock.digests[0]?.priceClose != null && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[16px] font-bold">${stock.digests[0].priceClose.toFixed(2)}</span>
            {stock.digests[0].priceChangePct != null && (
              <span className={cn("text-[13px] font-semibold",
                stock.digests[0].priceChangePct > 0 ? "text-gain"
                  : stock.digests[0].priceChangePct < 0 ? "text-loss"
                  : "text-muted-foreground"
              )}>
                {stock.digests[0].priceChangePct > 0 ? "+" : ""}{stock.digests[0].priceChangePct.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="overflow-y-auto px-6 py-5" style={{ maxHeight: 700 }}>
        <div
          className="relative space-y-8"
          style={{
            backgroundImage: "linear-gradient(180deg, rgba(102,198,223,0.35) 0%, rgba(102,198,223,0.04) 100%)",
            backgroundSize: "2px 100%",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "8px 0",
          }}
        >
          {stock.digests.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
              <Newspaper className="w-8 h-8 opacity-30" />
              <p className="text-[13px]">尚未建立今日新聞彙總</p>
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

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function StockNewsDigest() {
  const { activeSymbol } = useActiveSymbol();

  const { data, isLoading, isError } = useQuery<PageData>({
    queryKey: ["/api/news-digest/stocks"],
    queryFn: () => apiRequest("GET", "/api/news-digest/stocks").then((r) => r.json()),
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const stocks = data?.stocks ?? [];
  const stats = data?.stats;

  const activeStock =
    stocks.find((s) => s.symbol === activeSymbol) ??
    stocks[0] ??
    null;

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 max-w-[1300px] mx-auto">

          {/* Topbar */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-[32px] font-bold tracking-tight">美股每日新聞彙總</h2>
              <p className="text-[14px] text-muted-foreground mt-1.5 leading-relaxed">
                多空觀點左右對照，點擊來源標籤查看原始新聞。
              </p>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/8 bg-white/2 text-[12px] text-muted-foreground shrink-0">
              <Clock className="w-3.5 h-3.5" />
              {data?.lastUpdated ? `最後更新 ${formatLastUpdated(data.lastUpdated)}` : "尚未更新"} · 每日 Cron 自動更新
            </div>
          </div>





          {isLoading && (
            <div className="rounded-[18px] border border-white/8 bg-white/[0.02] animate-pulse" style={{ minHeight: 500 }} />
          )}

          {isError && (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <AlertCircle className="w-10 h-10 opacity-40" />
              <p className="text-[14px]">載入失敗，請重新整理</p>
            </div>
          )}

          {!isLoading && !isError && stocks.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <Newspaper className="w-12 h-12 opacity-20" />
              <p className="text-[15px] font-medium">尚未新增美股自選標的</p>
              <p className="text-[13px] opacity-60">請先到「市場總覽」的自選清單新增美股標的</p>
            </div>
          )}

          {!isLoading && stocks.length > 0 && activeStock && (
            <StockDigestCard stock={activeStock} />
          )}
        </div>
      </div>

      {/* Right sidebar — US stocks only */}
      <AnalysisSymbolSidebarDesktop symbolFilter={(item) => item.market === "US"} />
    </div>
  );
}
