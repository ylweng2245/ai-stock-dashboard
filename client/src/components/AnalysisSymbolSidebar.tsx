import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol, type Market } from "@/context/ActiveSymbolContext";

// ─── Types ────────────────────────────────────────────────────────────────────
interface WatchlistItem {
  id: number;
  symbol: string;
  name: string;
  market: Market;
  sortOrder: number;
}

interface StockQuote {
  symbol: string;
  market?: string;
  price: number;
  change: number;
  changePercent: number;
  quoteStatus?: "fresh" | "stale" | "error";
}

interface QuotesResponse {
  quotes: StockQuote[];
}

interface ComputedHolding {
  symbol: string;
  market: string;
  shares: number;
  avgCost: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtMarketValue(value: number, market: Market): string {
  if (market === "TW") {
    return `NT ${Math.round(value).toLocaleString("zh-TW")}`;
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Status indicator ─────────────────────────────────────────────────────────
function QuoteStatusDot({ status }: { status?: "fresh" | "stale" | "error" }) {
  if (!status || status === "fresh") return null;
  if (status === "error") {
    return (
      <span
        className="text-amber-400 text-[11px] font-bold leading-none select-none"
        title="報價異常"
        aria-label="報價異常"
      >
        !
      </span>
    );
  }
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0"
      title="報價稍舊"
      aria-label="報價稍舊"
    />
  );
}

// ─── Single stock row ─────────────────────────────────────────────────────────
interface SymbolRowProps {
  item: WatchlistItem;
  quote?: StockQuote;
  holding?: ComputedHolding;
  isActive: boolean;
  onClick: () => void;
}

function SymbolRow({ item, quote, holding, isActive, onClick }: SymbolRowProps) {
  const label    = item.market === "TW" ? item.name   : item.symbol;
  const subLabel = item.market === "TW" ? item.symbol : item.name;
  const price       = quote?.price ?? null;
  const pctChange   = quote?.changePercent ?? null;
  const isUp        = pctChange !== null && pctChange >= 0;

  // Holding info
  const shares = holding?.shares ?? 0;
  const marketValue = price != null && shares > 0 ? price * shares : null;

  return (
    <button
      onClick={onClick}
      data-testid={`sidebar-symbol-${item.symbol}`}
      className={cn(
        "w-full text-left px-3 py-1.5 transition-colors group",
        "flex flex-col gap-0",
        "hover:bg-accent hover:text-accent-foreground",
        isActive && "bg-primary/10 text-primary"
      )}
      style={{ minHeight: 64 }}  // fixed row height regardless of holding presence
    >
      {/* Top row: name + price */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col min-w-0 flex-1">
          <span className={cn("text-[13px] leading-snug truncate", isActive && "font-semibold")}>
            {label}
          </span>
          <span className="text-[11px] text-muted-foreground leading-none">{subLabel}</span>
        </div>
        <div className="flex flex-col items-end flex-shrink-0 gap-0">
          {price != null && (
            <span className="text-[13px] tabular-nums font-medium leading-snug">
              {item.market === "TW"
                ? price.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : `$${price.toFixed(2)}`}
            </span>
          )}
          <div className="flex items-center gap-1">
            {pctChange !== null && (
              <span className={cn("text-[11px] tabular-nums font-semibold", isUp ? "text-gain" : "text-loss")}>
                {pctChange.toFixed(2)}%
              </span>
            )}
            <QuoteStatusDot status={quote?.quoteStatus} />
          </div>
        </div>
      </div>

      {/* Holding info — always reserves space to keep row height consistent */}
      <div className="w-full text-center text-[11px] tabular-nums mt-0.5"
           style={{ minHeight: 16 }}>
        {shares > 0 ? (
          <span className="text-muted-foreground/70">
            {shares.toLocaleString()} 股{marketValue != null && <> · {fmtMarketValue(marketValue, item.market)}</>}
          </span>
        ) : (
          <span className="text-transparent select-none">·</span>  // invisible placeholder
        )}
      </div>
    </button>
  );
}

// ─── Market group ─────────────────────────────────────────────────────────────
interface MarketGroupProps {
  label: string;
  items: WatchlistItem[];
  quoteMap: Map<string, StockQuote>;
  holdingMap: Map<string, ComputedHolding>;
  activeSymbol: string;
  onSelect: (symbol: string, market: Market) => void;
}

function MarketGroup({ label, items, quoteMap, holdingMap, activeSymbol, onSelect }: MarketGroupProps) {
  if (items.length === 0) return null;

  return (
    <div>
      <div className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div>
        {items.map((item, idx) => (
          <div key={item.symbol}>
            <SymbolRow
              item={item}
              quote={quoteMap.get(item.symbol)}
              holding={holdingMap.get(item.symbol)}
              isActive={item.symbol === activeSymbol}
              onClick={() => onSelect(item.symbol, item.market)}
            />
            {/* Divider between items (not after last) */}
            {idx < items.length - 1 && (
              <div className="mx-3 border-b border-primary/30" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Inner list (shared between desktop + mobile) ────────────────────────────
function SidebarContent() {
  const { activeSymbol, setActive } = useActiveSymbol();

  const { data: watchlist } = useQuery<WatchlistItem[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  const { data: quotesData } = useQuery<QuotesResponse>({
    queryKey: ["/api/quotes"],
    queryFn: () => apiRequest("GET", "/api/quotes").then((r) => r.json()),
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  const { data: computedHoldings } = useQuery<ComputedHolding[]>({
    queryKey: ["/api/portfolio/computed"],
    queryFn: () => apiRequest("GET", "/api/portfolio/computed").then((r) => r.json()),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  const quoteMap   = new Map((quotesData?.quotes ?? []).map((q) => [q.symbol, q]));
  const holdingMap = new Map((computedHoldings ?? [])
    .filter((h) => h.shares > 0)
    .map((h) => [h.symbol, h])
  );

  const twList = (watchlist ?? []).filter((w) => w.market === "TW");
  const usList = (watchlist ?? []).filter((w) => w.market === "US");

  return (
    <ScrollArea className="h-full">
      <div className="py-2 space-y-2">
        <MarketGroup
          label="台股"
          items={twList}
          quoteMap={quoteMap}
          holdingMap={holdingMap}
          activeSymbol={activeSymbol}
          onSelect={setActive}
        />
        <MarketGroup
          label="美股"
          items={usList}
          quoteMap={quoteMap}
          holdingMap={holdingMap}
          activeSymbol={activeSymbol}
          onSelect={setActive}
        />
      </div>
    </ScrollArea>
  );
}

// ─── Desktop sidebar ─────────────────────────────────────────────────────────
export function AnalysisSymbolSidebarDesktop() {
  return (
    <aside
      className="hidden lg:flex flex-col w-[210px] flex-shrink-0 border-l border-border bg-card sticky top-0 h-screen overflow-hidden"
      data-testid="analysis-sidebar-desktop"
      aria-label="分析標的側欄"
    >
      <div className="px-3 pt-4 pb-2 border-b border-border">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          分析標的
        </h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <SidebarContent />
      </div>
    </aside>
  );
}

// ─── Mobile trigger + drawer ──────────────────────────────────────────────────
export function AnalysisSymbolSidebarMobile() {
  const { activeSymbol } = useActiveSymbol();

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="lg:hidden gap-1.5"
          data-testid="analysis-sidebar-mobile-trigger"
          aria-label="開啟標的選擇"
        >
          <Menu className="w-4 h-4" />
          <span className="text-xs">{activeSymbol}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[220px] p-0 flex flex-col" data-testid="analysis-sidebar-mobile">
        <SheetHeader className="px-3 pt-4 pb-2 border-b border-border">
          <SheetTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-left">
            分析標的
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-hidden">
          <SidebarContent />
        </div>
      </SheetContent>
    </Sheet>
  );
}
