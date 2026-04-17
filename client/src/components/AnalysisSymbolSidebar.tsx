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
  price: number;
  change: number;
  changePercent: number;
  quoteStatus?: "fresh" | "stale" | "error";
}

interface QuotesResponse {
  quotes: StockQuote[];
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
  // stale
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
  isActive: boolean;
  onClick: () => void;
}

function SymbolRow({ item, quote, isActive, onClick }: SymbolRowProps) {
  // Label: TW → show name, US → show symbol
  const label = item.market === "TW" ? item.name : item.symbol;
  const subLabel = item.market === "TW" ? item.symbol : item.name;
  const pctChange = quote?.changePercent ?? null;
  const isUp = pctChange !== null && pctChange >= 0;

  return (
    <button
      onClick={onClick}
      data-testid={`sidebar-symbol-${item.symbol}`}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-md transition-colors group",
        "flex items-center justify-between gap-2",
        "hover:bg-accent hover:text-accent-foreground",
        isActive && "bg-primary/10 text-primary font-medium"
      )}
    >
      <div className="flex flex-col min-w-0">
        <span className="text-sm truncate leading-snug">{label}</span>
        <span className="text-[11px] text-muted-foreground leading-snug">{subLabel}</span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {pctChange !== null && (
          <span
            className={cn(
              "text-[11px] tabular-nums",
              isUp ? "text-gain" : "text-loss"
            )}
          >
            {pctChange.toFixed(2)}%
          </span>
        )}
        <QuoteStatusDot status={quote?.quoteStatus} />
      </div>
    </button>
  );
}

// ─── Market group ─────────────────────────────────────────────────────────────
interface MarketGroupProps {
  label: string;
  items: WatchlistItem[];
  quotes: StockQuote[];
  activeSymbol: string;
  onSelect: (symbol: string, market: Market) => void;
}

function MarketGroup({ label, items, quotes, activeSymbol, onSelect }: MarketGroupProps) {
  if (items.length === 0) return null;
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  return (
    <div>
      <div className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <SymbolRow
            key={item.symbol}
            item={item}
            quote={quoteMap.get(item.symbol)}
            isActive={item.symbol === activeSymbol}
            onClick={() => onSelect(item.symbol, item.market)}
          />
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
    staleTime: 30_000,
  });

  const { data: quotesData } = useQuery<QuotesResponse>({
    queryKey: ["/api/quotes"],
    queryFn: () => apiRequest("GET", "/api/quotes").then((r) => r.json()),
    staleTime: 55_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const quotes = quotesData?.quotes ?? [];
  const twList = (watchlist ?? []).filter((w) => w.market === "TW");
  const usList = (watchlist ?? []).filter((w) => w.market === "US");

  return (
    <ScrollArea className="h-full">
      <div className="py-2 space-y-2">
        <MarketGroup
          label="台股"
          items={twList}
          quotes={quotes}
          activeSymbol={activeSymbol}
          onSelect={setActive}
        />
        <MarketGroup
          label="美股"
          items={usList}
          quotes={quotes}
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
      className="hidden lg:flex flex-col w-[200px] flex-shrink-0 border-l border-border bg-card sticky top-0 h-screen overflow-hidden"
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
  const { activeSymbol, activeMarket } = useActiveSymbol();

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
