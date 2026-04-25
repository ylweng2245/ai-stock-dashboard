import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
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

// Custom dot renderer for buy/sell marks on the Bollinger chart
function TradeDotRenderer(props: any) {
  const { cx, cy, payload } = props;
  if (!payload?.tradeInfo) return null;
  const { side, price, shares, currency, fullDate } = payload.tradeInfo as TradeDot;
  const color = side === "buy" ? "#ef4444" : "#22c55e";
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={color} stroke="#fff" strokeWidth={1.5} opacity={0.92} style={{ cursor: "pointer" }} />
      <circle cx={cx} cy={cy} r={9} fill={color} opacity={0.15} />
    </g>
  );
}

// Custom tooltip that shows trade info when hovering on a data point with tradeInfo
function BollingerTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  const hasTrade = !!p?.tradeInfo;
  const curr = p?.tradeInfo?.currency ?? "TWD";
  const sym = curr === "USD" ? "$" : "NT";
  return (
    <div style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "8px 12px", fontSize: 12, minWidth: 160 }}>
      <p className="text-muted-foreground mb-1">{p?.fullDate ?? label}</p>
      {payload.map((item: any, i: number) => {
        if (!item.value && item.value !== 0) return null;
        if (["buyDot", "sellDot"].includes(item.dataKey)) return null;
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
            <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: p.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e" }} />
            <span className="font-semibold" style={{ color: p.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e" }}>
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
    </div>
  );
}

interface HistoryResponse {
  symbol: string;
  bars: CandleData[];
  fetchedAt: number;
  source: string;
  dataFrom: string;
  dataTo: string;
  dataSource: string;
  // v2 DB-sync metadata
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

export default function TechnicalAnalysis() {
  // ─── Global symbol state (v3) ──────────────────────────────────────────────
  const { activeSymbol, activeMarket } = useActiveSymbol();
  const [range, setRange] = useState("3mo");

  // Derive meta from watchlist (fallback to STOCK_META)
  const { data: watchlist } = useQuery<{ id: number; symbol: string; name: string; market: "TW" | "US"; sortOrder: number }[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 30_000,
  });

  const meta = useMemo(() => {
    const wItem = watchlist?.find((w) => w.symbol === activeSymbol);
    if (wItem) return { name: wItem.name, market: wItem.market };
    return STOCK_META[activeSymbol] ?? { name: activeSymbol, market: activeMarket };
  }, [watchlist, activeSymbol, activeMarket]);

  const { data, isLoading, isError, isFetching } = useQuery<HistoryResponse>({
    queryKey: ["/api/history", activeSymbol, meta.market, range],
    queryFn: () =>
      apiRequest("GET", `/api/history/${activeSymbol}?market=${meta.market}&range=${range}`)
        .then((r) => r.json()),
    staleTime: 55_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev: HistoryResponse | undefined) => prev,
  });

  // Fetch transactions for this symbol to overlay buy/sell dots
  const { data: symbolTxns } = useQuery<Transaction[]>({
    queryKey: ["/api/transactions", activeSymbol],
    queryFn: () =>
      apiRequest("GET", `/api/transactions/${activeSymbol}?market=${meta.market}`)
        .then(r => r.json()),
    staleTime: 30_000,
  });

  const candleData: CandleData[] = data?.bars ?? [];

  const rsi = useMemo(() => (candleData.length >= 15 ? calculateRSI(candleData) : []), [candleData]);
  const macdData = useMemo(() => (candleData.length >= 27 ? calculateMACD(candleData) : { macd: [], signal: [], histogram: [] }), [candleData]);
  const bollingerData = useMemo(() => (candleData.length >= 20 ? calculateBollinger(candleData) : { upper: [], middle: [], lower: [] }), [candleData]);

  // Build a date → trade info map for overlay dots
  const tradeDotMap = useMemo(() => {
    const map = new Map<string, TradeDot>();
    if (!symbolTxns?.length) return map;
    for (const tx of symbolTxns) {
      // Skip dividend entries (price=0, shares=0) — they have no chart position
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

  const chartData = useMemo(
    () =>
      candleData.map((d, i) => {
        const tradeInfo = tradeDotMap.get(d.time) ?? null;
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
        };
      }),
    [candleData, rsi, macdData, bollingerData, tradeDotMap]
  );

  const lastRSI = rsi[rsi.length - 1] ?? 50;
  const lastMACD = macdData.macd[macdData.macd.length - 1] ?? 0;
  const lastSignal = macdData.signal[macdData.signal.length - 1] ?? 0;
  const lastClose = candleData[candleData.length - 1]?.close ?? 0;
  const lastBBUpper = bollingerData.upper[bollingerData.upper.length - 1] ?? lastClose * 1.02;
  const lastBBLower = bollingerData.lower[bollingerData.lower.length - 1] ?? lastClose * 0.98;

  const rsiSignal = lastRSI > 70 ? "超買" : lastRSI < 30 ? "超賣" : "中性";
  const macdSignal = lastMACD > lastSignal ? "多頭" : "空頭";
  const bbPosition = lastClose > lastBBUpper ? "超漲" : lastClose < lastBBLower ? "超跌" : "區間內";

  const xInterval = Math.max(1, Math.floor(chartData.length / 12));

  return (
    <div className="p-6 space-y-4" data-testid="analysis-page">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">技術分析</h1>
          <p className="text-sm text-muted-foreground mt-0.5">RSI、MACD、布林通道指標（真實歷史數據）</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Mobile: symbol picker trigger */}
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
          {isFetching && <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />}
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
          已顯示稍早資料（最新資料暂時無法取得，將在下次自動重試）
        </div>
      )}

      {/* Signal Cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">RSI (14日)</div>
            {isLoading ? <Skeleton className="h-7 w-full" /> : (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tabular-nums">{lastRSI.toFixed(1)}</span>
                <Badge
                  variant={rsiSignal === "超買" ? "destructive" : rsiSignal === "超賣" ? "default" : "secondary"}
                  className="text-[10px]"
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
                  variant={macdSignal === "多頭" ? "default" : "destructive"}
                  className={cn("text-[10px]", macdSignal === "多頭" ? "bg-red-500/20 text-red-500 border-red-500/30" : "bg-emerald-500/20 text-emerald-500 border-emerald-500/30")}
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

      {/* Price + Bollinger Chart */}
      <Card className="border-border">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-semibold">
              {activeSymbol} {meta.name} — 價格走勢與布林通道
            </CardTitle>
            {data && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {data.dataFrom} → {data.dataTo}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          {isLoading ? (
            <Skeleton className="w-full h-[320px] rounded-md" />
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={xInterval} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={65} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip content={<BollingerTooltip />} />
                <Area type="monotone" dataKey="bbUpper" stroke="none" fill="hsl(var(--chart-1))" fillOpacity={0.06} />
                <Area type="monotone" dataKey="bbLower" stroke="none" fill="hsl(var(--background))" fillOpacity={1} />
                <Line type="monotone" dataKey="bbUpper" stroke="hsl(var(--chart-1))" strokeWidth={1} strokeDasharray="4 4" dot={false} name="布林上軌" />
                <Line type="monotone" dataKey="bbMiddle" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="2 2" dot={false} name="中軌" />
                <Line type="monotone" dataKey="bbLower" stroke="hsl(var(--chart-1))" strokeWidth={1} strokeDasharray="4 4" dot={false} name="布林下軌" />
                <Line type="monotone" dataKey="close" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="收盤價" />
                {/* Buy/sell trade dots overlay */}
                <Line
                  type="monotone"
                  dataKey="tradeDot"
                  stroke="none"
                  dot={(props: any) => {
                    const { payload } = props;
                    if (!payload?.tradeInfo) return <g key={props.key} />;
                    const color = payload.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e";
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
                    const color = payload.tradeInfo.side === "buy" ? "#ef4444" : "#22c55e";
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
                  <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
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
