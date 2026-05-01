import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Briefcase, Upload, AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
import { type StockQuote, formatDataAge } from "@/lib/stockData";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ComputedHolding {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  shares: number;
  avgCost: number;
  totalCost: number;
  realizedGain: number;
  totalBuyCost: number;
  totalBuyShares: number;
}

interface PortfolioQuotesResponse {
  quotes: StockQuote[];
  fetchedAt: number;
  dataSource: string;
}

const COLORS = ["#06b6d4","#8b5cf6","#f59e0b","#22c55e","#ef4444","#ec4899","#3b82f6","#f97316","#14b8a6","#a855f7","#84cc16","#fb7185"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format number with full digits, no M/K abbreviation */
function fmtNum(val: number, currency: "TWD" | "USD" | string): string {
  const decimals = currency === "USD" ? 2 : 0;
  return val.toLocaleString("zh-TW", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 均成本、現價用：一律 2 位小數（台股也顯示小數，市傀型 ETF 小數點正確） */
function fmtPrice(val: number): string {
  return val.toLocaleString("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Colored P&L span — no arrow icon, color only */
function PnLCell({ value, currency }: { value: number; currency: string }) {
  const isPos = value >= 0;
  const sign = "";
  return (
    <span className={cn("tabular-nums font-medium", isPos ? "text-gain" : "text-loss")}>
      {sign}{fmtNum(value, currency)}
    </span>
  );
}

/** Colored percentage span */
function PctCell({ value }: { value: number }) {
  const isPos = value >= 0;
  return (
    <span className={cn("tabular-nums font-medium", isPos ? "text-gain" : "text-loss")}>
      {value.toFixed(2)}%
    </span>
  );
}

// ─── Market sub-section header ────────────────────────────────────────────────

function MarketHeader({ label, marketValue, pct }: { label: string; marketValue: number; pct: number }) {
  return (
    <tr className="bg-muted/30">
      <td colSpan={8} className="px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-foreground uppercase tracking-wide">{label}</span>
          <span className="text-sm text-foreground font-semibold tabular-nums">
            總市值 NT {fmtNum(marketValue, "TWD")}
          </span>
          <Badge variant="secondary" className="text-xs px-2 py-0.5 font-semibold">{pct.toFixed(1)}%</Badge>
        </div>
      </td>
    </tr>
  );
}

// 視為現金部位、排除在台股市值統計與占比排行外的 symbol
const EXCLUDE_FROM_TW_STATS = new Set(["00719B"]);

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Portfolio() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  // Fetch computed portfolio from DB transactions
  const { data: computedHoldingsRaw, isLoading: holdingsLoading, refetch: refetchHoldings } = useQuery<ComputedHolding[]>({
    queryKey: ["/api/portfolio/computed"],
    queryFn: () => apiRequest("GET", "/api/portfolio/computed").then(r => r.json()),
    staleTime: 5 * 60_000,          // 5 min — pure DB calc, changes only on import
    placeholderData: (prev: ComputedHolding[] | undefined) => prev,  // show stale data while refreshing
  });

  // Fetch live prices
  const { data: priceData, isLoading: pricesLoading, isFetching, dataUpdatedAt, isError: pricesError } = useQuery<PortfolioQuotesResponse>({
    queryKey: ["/api/portfolio-quotes"],
    queryFn: () => apiRequest("GET", "/api/portfolio-quotes").then(r => r.json()),
    refetchInterval: 30_000,          // auto-refresh every 30s — keeps P&L current during market hours
    staleTime: 5 * 60_000,           // 5 min — prevents blank flash on re-enter; refetchInterval still runs
    placeholderData: (prev: PortfolioQuotesResponse | undefined) => prev,  // show previous data while background update runs
  });

  // isPending = true only when there is truly no cached data yet (first load ever)
  const computedHoldings: ComputedHolding[] = computedHoldingsRaw ?? [];

  // Build price map
  const priceMap = useMemo(() => {
    const map = new Map<string, StockQuote>();
    priceData?.quotes.forEach(q => map.set(q.symbol, q));
    return map;
  }, [priceData]);

  const TWD_USD = priceMap.get("USDTWD")?.price ?? 31.0;

  // Import Excel mutation
  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/transactions/import", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || err.error || "匯入失敗");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "交易明細匯入成功", description: `共匯入 ${data.imported} 筆（台股 ${data.tw}、美股 ${data.us}）` });
      qc.invalidateQueries({ queryKey: ["/api/portfolio/computed"] });
      qc.invalidateQueries({ queryKey: ["/api/portfolio-quotes"] });
      refetchHoldings();
    },
    onError: (err: Error) => {
      toast({ title: "匯入失敗", description: err.message, variant: "destructive" });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importMutation.mutate(file);
    e.target.value = "";
  };

  // Enrich holdings with live prices
  const enriched = useMemo(() => {
    return computedHoldings
      .filter(h => h.shares > 0)
      .map(h => {
        const quote = priceMap.get(h.symbol);
        // Use live price if available and non-zero; fallback to avgCost only when truly no data
        const currentPrice = (quote?.price && quote.price > 0) ? quote.price : h.avgCost;
        const unrealizedGain = (currentPrice - h.avgCost) * h.shares;
        const unrealizedPct = h.avgCost > 0 ? ((currentPrice - h.avgCost) / h.avgCost) * 100 : 0;
        const marketValue = currentPrice * h.shares;
        return { ...h, currentPrice, quote, unrealizedGain, unrealizedPct, marketValue };
      });
  }, [computedHoldings, priceMap]);

  const twRows = useMemo(() => enriched.filter(r => r.market === "TW").sort((a, b) => b.marketValue - a.marketValue), [enriched]);
  const twRowsForStats = useMemo(() => twRows.filter(r => !EXCLUDE_FROM_TW_STATS.has(r.symbol)), [twRows]);
  const usRows = useMemo(() => enriched.filter(r => r.market === "US").sort((a, b) => b.marketValue - a.marketValue), [enriched]);

  // Realized (fully closed)
  const realizedRows = useMemo(() => {
    return computedHoldings
      .filter(h => h.shares <= 0.0001 && h.realizedGain !== 0)
      .sort((a, b) => Math.abs(b.realizedGain) - Math.abs(a.realizedGain));
  }, [computedHoldings]);

  const twRealized = useMemo(() => realizedRows.filter(r => r.market === "TW"), [realizedRows]);
  const usRealized = useMemo(() => realizedRows.filter(r => r.market === "US"), [realizedRows]);

  // Summary stats
  // 台股市值統計排除現金部位 00719B
  const twMarketValue = twRowsForStats.reduce((s, r) => s + r.marketValue, 0);
  const usMarketValue = usRows.reduce((s, r) => s + r.marketValue, 0);
  const twMarketValueTWD = twMarketValue;
  const usMarketValueTWD = usMarketValue * TWD_USD;
  const totalMarketTWD = twMarketValueTWD + usMarketValueTWD;
  const twPct = totalMarketTWD > 0 ? (twMarketValueTWD / totalMarketTWD) * 100 : 0;
  const usPct = totalMarketTWD > 0 ? (usMarketValueTWD / totalMarketTWD) * 100 : 0;

  const twUnrealized = twRows.reduce((s, r) => s + r.unrealizedGain, 0);
  const usUnrealizedTWD = usRows.reduce((s, r) => s + r.unrealizedGain * TWD_USD, 0);
  const totalUnrealizedTWD = twUnrealized + usUnrealizedTWD;

  const twRealizedTWD = computedHoldings
    .filter(h => h.market === "TW")
    .reduce((s, h) => s + h.realizedGain, 0);
  const usRealizedTWD = computedHoldings
    .filter(h => h.market === "US")
    .reduce((s, h) => s + h.realizedGain * TWD_USD, 0);
  const totalRealizedTWD = twRealizedTWD + usRealizedTWD;

  // Bar chart data（持倉占比排行）：排除現金部位 00719B
  const barData = enriched
    .filter(r => !EXCLUDE_FROM_TW_STATS.has(r.symbol))
    .map((r, i) => ({
      symbol: r.symbol,
      name: r.name,
      value: r.market === "US" ? r.marketValue * TWD_USD : r.marketValue,
      origValue: r.marketValue,
      color: COLORS[i % COLORS.length],
      market: r.market,
      currency: r.currency,
    })).sort((a, b) => b.value - a.value);

  // isPending: true only when holdings (the primary data) has never loaded.
  // priceData is allowed to still be loading — we'll show avgCost as fallback.
  const isPending = computedHoldingsRaw === undefined;
  // pricesPending: true when priceData has no cached/placeholder data yet
  const pricesPending = priceData === undefined;
  const hasData = !isPending && (enriched.length > 0 || realizedRows.length > 0);

  // ─── Table columns ──────────────────────────────────────────────────────────
  const thClass = "px-4 py-3 text-right font-medium";
  const tdClass = "px-4 py-3 text-right tabular-nums";

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Briefcase className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-semibold">投資組合</h1>
          {isFetching && <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              {isFetching ? "更新中…" : `報價更新：${formatDataAge(dataUpdatedAt / 1000)}`}
              <span className="ml-1 opacity-50">· 每30秒自動更新</span>
            </span>
          )}
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />
          <Button onClick={() => fileRef.current?.click()} disabled={importMutation.isPending} className="gap-2">
            {importMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            更新交易明細
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {!isPending && !hasData && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
            <Briefcase className="w-12 h-12 text-muted-foreground/40" />
            <div>
              <p className="text-muted-foreground font-medium">尚無交易資料</p>
              <p className="text-sm text-muted-foreground/60 mt-1">點擊「更新交易明細」選擇 Excel 檔案以匯入交易記錄</p>
            </div>
            <Button variant="outline" onClick={() => fileRef.current?.click()} className="gap-2">
              <Upload className="w-4 h-4" /> 選擇 Excel 檔案
            </Button>
          </CardContent>
        </Card>
      )}

      {isPending && <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>}

      {hasData && (
        <>
          {/* Summary Cards — 4 cards: TW market value, US market value (TWD), unrealized P&L, realized P&L */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 台股市值 */}
            <SummaryCard label="台股市值" value={`NT ${fmtNum(twMarketValueTWD, "TWD")}`} sub={`佔總資產 ${twPct.toFixed(1)}%`} loading={pricesPending} />
            {/* 美股市值 (換算台幣) */}
            <SummaryCard label="美股市值（換算台幣）" value={`NT ${fmtNum(usMarketValueTWD, "TWD")}`} sub={`佔總資產 ${usPct.toFixed(1)}%`} loading={pricesPending} />
            {/* 未實現損益 — 大字總計 + 右側台/美分列 */}
            <PnLSplitCard
              label="未實現損益"
              total={totalUnrealizedTWD}
              tw={twUnrealized}
              us={usUnrealizedTWD}
              loading={pricesPending}
            />
            {/* 已實現損益 — 大字總計 + 右側台/美分列 */}
            <PnLSplitCard
              label="已實現損益"
              total={totalRealizedTWD}
              tw={twRealizedTWD}
              us={usRealizedTWD}
            />
          </div>

          {/* Holdings Table */}
          {enriched.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">現有持股</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground text-xs">
                        <th className="px-4 py-3 text-left font-medium">標的</th>
                        <th className={thClass}>持股數</th>
                        <th className={thClass}>均成本</th>
                        <th className={thClass}>現價</th>
                        <th className={thClass}>市值</th>
                        <th className={thClass}>未實現損益</th>
                        <th className={thClass}>已實現損益</th>
                        <th className={thClass}>報酬率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* TW section */}
                      {twRows.length > 0 && (
                        <>
                          <MarketHeader label="台股" marketValue={twMarketValue} pct={twPct} />
                          {twRows.map(row => (
                            <HoldingRow key={`${row.symbol}_TW`} row={row} />
                          ))}
                        </>
                      )}
                      {/* US section */}
                      {usRows.length > 0 && (
                        <>
                          <MarketHeader label="美股" marketValue={usMarketValueTWD} pct={usPct} />
                          {usRows.map(row => (
                            <HoldingRow key={`${row.symbol}_US`} row={row} />
                          ))}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Realized Gains */}
          {realizedRows.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>已平倉標的（已實現損益）</span>
                  <Badge variant="secondary">{realizedRows.length} 筆</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground text-xs">
                        <th className="px-4 py-3 text-left font-medium">標的</th>
                        <th className={thClass}>總買入成本</th>
                        <th className={thClass}>已實現損益</th>
                        <th className={thClass}>報酬率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {twRealized.length > 0 && (
                        <>
                          <tr className="bg-muted/30">
                            <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">台股（TWD）</td>
                          </tr>
                          {twRealized.map(row => <RealizedRow key={`${row.symbol}_TW_r`} row={row} />)}
                        </>
                      )}
                      {usRealized.length > 0 && (
                        <>
                          <tr className="bg-muted/30">
                            <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">美股（USD）</td>
                          </tr>
                          {usRealized.map(row => <RealizedRow key={`${row.symbol}_US_r`} row={row} />)}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Allocation Bar Chart */}
          {barData.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">持倉占比（以台幣市值排序）</CardTitle>
              </CardHeader>
              <CardContent>
                <PortfolioBarChart data={barData} />
              </CardContent>
            </Card>
          )}

          {priceData?.dataSource && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              即時報價來源：
              <a href="https://perplexity.ai/finance" target="_blank" rel="noopener" className="text-primary hover:underline inline-flex items-center gap-0.5">
                {priceData.dataSource} <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ─── PortfolioBarChart ────────────────────────────────────────────────────────

interface BarItem {
  symbol: string;
  name: string;
  value: number;      // TWD-converted market value
  color: string;
  market: string;
  currency: string;   // original currency
  origValue: number;  // original currency value
}

function PortfolioBarChart({ data }: { data: BarItem[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = data.reduce((s, d) => s + d.value, 0);
  const maxVal = data[0]?.value ?? 1;

  return (
    <div className="w-full space-y-2">
      {data.map((item) => {
        const pct = total > 0 ? (item.value / total) * 100 : 0;
        const barPct = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
        const isHov = hovered === item.symbol;
        // keep label on one line; truncate long names
        const rawName = item.name || "";
        const truncName = rawName.length > 16 ? rawName.slice(0, 15) + "…" : rawName;
        const label = truncName ? `${item.symbol}  ${truncName}` : item.symbol;
        // Show TWD value without currency prefix
        const valStr = fmtNum(item.value, "TWD");

        return (
          <div
            key={item.symbol}
            className="flex items-center gap-3 group"
            onMouseEnter={() => setHovered(item.symbol)}
            onMouseLeave={() => setHovered(null)}
          >
            {/* Label */}
            <div className="w-52 flex-shrink-0 text-right overflow-hidden">
              <span
                className={cn(
                  "text-sm transition-colors whitespace-nowrap block truncate",
                  isHov ? "text-foreground font-semibold" : "text-muted-foreground"
                )}
                title={item.name ? `${item.symbol} ${item.name}` : item.symbol}
              >
                {label}
              </span>
            </div>

            {/* Bar track */}
            <div className="flex-1 relative h-7 flex items-center">
              <div
                className="h-full rounded transition-all duration-300"
                style={{
                  width: `${barPct}%`,
                  minWidth: 4,
                  background: item.color,
                  opacity: isHov ? 1 : 0.78,
                }}
              />
              {/* Value label right of bar */}
              <span
                className={cn(
                  "ml-2 text-xs tabular-nums whitespace-nowrap transition-colors",
                  isHov ? "text-foreground font-semibold" : "text-muted-foreground"
                )}
              >
                {valStr}
              </span>
            </div>

            {/* Pct badge */}
            <div className="w-14 flex-shrink-0 text-right">
              <span className={cn(
                "text-sm tabular-nums font-semibold transition-colors",
                isHov ? "text-foreground" : "text-muted-foreground/80"
              )}>
                {pct.toFixed(1)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── HoldingRow ───────────────────────────────────────────────────────────────

function HoldingRow({ row }: { row: any }) {
  const cur = row.currency as string;
  const sharesStr = row.market === "TW"
    ? row.shares.toLocaleString("zh-TW", { maximumFractionDigits: 0 })
    : row.shares.toLocaleString("zh-TW", { maximumFractionDigits: 4 });

  return (
    <tr className="border-b border-border/30 hover:bg-muted/20 transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div>
            <span className="font-medium">{row.symbol}</span>
            <span className="text-muted-foreground ml-1.5 text-xs">{row.name}</span>
          </div>
          {row.quote?.quoteStatus === "error" && <AlertCircle className="w-3.5 h-3.5 text-amber-400" aria-label="資料獲取失敗（顯示緩存值）" />}
          {!row.quote?.quoteStatus && row.quote?.isStale && <AlertCircle className="w-3.5 h-3.5 text-muted-foreground/50" aria-label="數據稍舊" />}
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{sharesStr}</td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtPrice(row.avgCost)}</td>
      <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtPrice(row.currentPrice)}</td>
      <td className="px-4 py-3 text-right tabular-nums">{fmtNum(row.marketValue, cur)}</td>
      <td className="px-4 py-3 text-right"><PnLCell value={row.unrealizedGain} currency={cur} /></td>
      <td className="px-4 py-3 text-right">
        {row.realizedGain !== 0
          ? <PnLCell value={row.realizedGain} currency={cur} />
          : <span className="text-muted-foreground/50">—</span>}
      </td>
      <td className="px-4 py-3 text-right"><PctCell value={row.unrealizedPct} /></td>
    </tr>
  );
}

// ─── RealizedRow ──────────────────────────────────────────────────────────────

function RealizedRow({ row }: { row: any }) {
  const cur = row.currency as string;
  const returnRate = row.totalBuyCost > 0 ? (row.realizedGain / row.totalBuyCost) * 100 : 0;
  return (
    <tr className="border-b border-border/30 hover:bg-muted/20 transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.symbol}</span>
          <span className="text-muted-foreground text-xs">{row.name}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtNum(row.totalBuyCost, cur)}</td>
      <td className="px-4 py-3 text-right"><PnLCell value={row.realizedGain} currency={cur} /></td>
      <td className="px-4 py-3 text-right"><PctCell value={returnRate} /></td>
    </tr>
  );
}

// ─── SummaryCard ──────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, colorClass, loading }: {
  label: string;
  value?: string;
  sub?: string;
  colorClass?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        {loading
          ? <Skeleton className="h-7 w-32 mt-1" />
          : <p className={cn("text-lg font-semibold tabular-nums", colorClass ?? "text-foreground")}>{value}</p>
        }
        {sub && !loading && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        {loading && <Skeleton className="h-3 w-20 mt-1.5" />}
      </CardContent>
    </Card>
  );
}

// ─── PnLSplitCard ────────────────────────────────────────────────────────────────
/** 左側大字顯示總損益(TWD)，右側小字顯示台股 / 美股分列 */
function PnLSplitCard({ label, total, tw, us, loading }: {
  label: string;
  total: number;  // TWD total
  tw: number;     // TWD
  us: number;     // TWD-converted
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground mb-1.5">{label}</p>
        {loading ? (
          <div className="flex items-center gap-3">
            <Skeleton className="h-7 w-28 flex-1" />
            <div className="text-right space-y-1 flex-shrink-0 border-l border-border/40 pl-3">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {/* Left: large total */}
            <p className={cn("text-lg font-bold tabular-nums flex-1", total >= 0 ? "text-gain" : "text-loss")}>
              NT {fmtNum(total, "TWD")}
            </p>
            {/* Right: TW / US breakdown */}
            <div className="text-right space-y-0.5 flex-shrink-0 border-l border-border/40 pl-3">
              <p className={cn("text-sm tabular-nums", tw >= 0 ? "text-gain" : "text-loss")}>
                台 {fmtNum(tw, "TWD")}
              </p>
              <p className={cn("text-sm tabular-nums", us >= 0 ? "text-gain" : "text-loss")}>
                美 {fmtNum(us, "TWD")}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
