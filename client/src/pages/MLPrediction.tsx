import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, TrendingUp, TrendingDown, RefreshCw, Target, BarChart, ExternalLink } from "lucide-react";
import {
  type CandleData,
  simulateRFPrediction,
  STOCK_META,
} from "@/lib/stockData";
import { cn } from "@/lib/utils";
import {
  BarChart as RechartsBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LineChart, Line,
} from "recharts";
import { apiRequest } from "@/lib/queryClient";

interface WatchlistItem {
  id: number;
  symbol: string;
  name: string;
  market: "TW" | "US";
  sortOrder: number;
}

interface HistoryResponse {
  bars: CandleData[];
  fetchedAt: number;
  source: string;
  dataFrom: string;
  dataTo: string;
}

export default function MLPrediction() {
  const [selectedSymbol, setSelectedSymbol] = useState("2330");
  const [isRunning, setIsRunning] = useState(false);
  const [runKey, setRunKey] = useState(0);

  // Fetch live watchlist from DB (same as TechnicalAnalysis)
  const { data: watchlist } = useQuery<WatchlistItem[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 30_000,
  });

  // When watchlist loads, if current symbol not in list, switch to first item
  useEffect(() => {
    if (!watchlist || watchlist.length === 0) return;
    const inList = watchlist.some((w) => w.symbol === selectedSymbol);
    if (!inList) setSelectedSymbol(watchlist[0].symbol);
  }, [watchlist]);

  // Build meta from watchlist (live), fallback to static STOCK_META
  const meta = useMemo(() => {
    const wItem = watchlist?.find((w) => w.symbol === selectedSymbol);
    if (wItem) return { name: wItem.name, market: wItem.market };
    return STOCK_META[selectedSymbol] ?? { name: selectedSymbol, market: "TW" as const };
  }, [watchlist, selectedSymbol]);

  const { data: histData, isLoading } = useQuery<HistoryResponse>({
    queryKey: ["/api/history", selectedSymbol, meta.market, "3mo"],
    queryFn: () =>
      apiRequest("GET", `/api/history/${selectedSymbol}?market=${meta.market}&range=3mo`)
        .then((r) => r.json()),
    staleTime: 25 * 60_000,
  });

  const candleData: CandleData[] = histData?.bars ?? [];
  const prediction = useMemo(
    () => (candleData.length >= 30 ? simulateRFPrediction(candleData) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candleData, runKey]
  );

  const handleRunPrediction = () => {
    setIsRunning(true);
    setTimeout(() => {
      setRunKey((k) => k + 1);
      setIsRunning(false);
    }, 1200);
  };

  const forecastData = useMemo(() => {
    if (!candleData.length || !prediction) return [];
    const last30 = candleData.slice(-30);
    const data = last30.map((d) => ({
      date: d.time.slice(5),
      price: d.close,
      predicted: null as number | null,
      upperBound: null as number | null,
      lowerBound: null as number | null,
    }));

    const lastPrice = last30[last30.length - 1].close;
    const direction = prediction.prediction === "up" ? 1 : -1;
    const dailyMove = lastPrice * 0.008 * direction;

    for (let i = 1; i <= 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      const predicted = lastPrice + dailyMove * i + (Math.random() - 0.5) * lastPrice * 0.005;
      data.push({
        date: `${date.getMonth() + 1}/${date.getDate()}`,
        price: null as any,
        predicted: +predicted.toFixed(2),
        upperBound: +(predicted + lastPrice * 0.02).toFixed(2),
        lowerBound: +(predicted - lastPrice * 0.02).toFixed(2),
      });
    }
    return data;
  }, [candleData, prediction]);

  return (
    <div className="p-6 space-y-4" data-testid="prediction-page">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">ML 價格預測</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Random Forest 機器學習模型（基於真實歷史數據）</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedSymbol} onValueChange={setSelectedSymbol}>
            <SelectTrigger className="w-[200px]" data-testid="stock-selector-ml">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(watchlist ?? []).length > 0 ? (() => {
                const tw = (watchlist ?? []).filter((w) => w.market === "TW");
                const us = (watchlist ?? []).filter((w) => w.market === "US");
                return (
                  <>
                    {tw.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">台股</div>
                        {tw.map((w) => (
                          <SelectItem key={w.symbol} value={w.symbol}>{w.symbol} — {w.name}</SelectItem>
                        ))}
                      </>
                    )}
                    {us.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">美股</div>
                        {us.map((w) => (
                          <SelectItem key={w.symbol} value={w.symbol}>{w.symbol} — {w.name}</SelectItem>
                        ))}
                      </>
                    )}
                  </>
                );
              })() : (
                <SelectItem value={selectedSymbol}>{selectedSymbol}</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Button
            onClick={handleRunPrediction}
            disabled={isRunning || isLoading || !prediction}
            className="gap-2"
            data-testid="run-prediction"
          >
            <RefreshCw className={cn("w-4 h-4", isRunning && "animate-spin")} />
            {isRunning ? "運算中..." : "執行預測"}
          </Button>
        </div>
      </div>

      {/* Data source notice */}
      {histData && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-muted/20 rounded px-3 py-1.5">
          <ExternalLink className="w-3 h-3" />
          訓練數據：{histData.dataFrom} 至 {histData.dataTo}（{candleData.length} 交易日），
          來源：Yahoo Finance · 技術指標由本地計算
        </div>
      )}

      {/* Prediction Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">預測方向</span>
            </div>
            {isLoading || !prediction ? (
              <Skeleton className="h-7 w-full" />
            ) : (
              <div className="flex items-center gap-2">
                {prediction.prediction === "up" ? (
                  <TrendingUp className="w-5 h-5 text-gain" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-loss" />
                )}
                <span className={cn("text-lg font-bold", prediction.prediction === "up" ? "text-gain" : "text-loss")}>
                  {prediction.prediction === "up" ? "看漲 ↑" : "看跌 ↓"}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">信心度</span>
            </div>
            {isLoading || !prediction ? (
              <Skeleton className="h-7 w-full" />
            ) : (
              <div className="space-y-1.5">
                <span className="text-lg font-bold tabular-nums">{(prediction.confidence * 100).toFixed(1)}%</span>
                <Progress value={prediction.confidence * 100} className="h-1.5" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <BarChart className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">預測區間 (7日)</span>
            </div>
            {isLoading || !prediction ? (
              <Skeleton className="h-7 w-full" />
            ) : (
              <div className="text-sm tabular-nums">
                <span className="text-gain font-medium">{meta.market === "TW" ? "NT" : "$"}{prediction.predictedRange.high.toLocaleString()}</span>
                <span className="text-muted-foreground mx-1.5">—</span>
                <span className="text-loss font-medium">{meta.market === "TW" ? "NT" : "$"}{prediction.predictedRange.low.toLocaleString()}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">模型資訊</span>
            </div>
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <div>演算法: Random Forest</div>
              <div>特徵數: 8</div>
              <div>訓練期: {candleData.length || "..."} 交易日</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Feature Importance Chart */}
      <Card className="border-border">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">特徵重要性 (Feature Importance)</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          {isLoading || !prediction ? (
            <Skeleton className="w-full h-[280px] rounded-md" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <RechartsBarChart
                data={prediction.featureImportance}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} horizontal={false} />
                <XAxis type="number" domain={[0, 0.25]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                <YAxis type="category" dataKey="feature" tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }} width={100} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                  formatter={(value: number) => [`${(value * 100).toFixed(1)}%`, "重要性"]}
                />
                <Bar dataKey="importance" radius={[0, 4, 4, 0]}>
                  {prediction.featureImportance.map((_, index) => (
                    <Cell key={index} fill={`hsl(${185 + index * 15}, 75%, ${50 - index * 3}%)`} />
                  ))}
                </Bar>
              </RechartsBarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Forecast Chart */}
      <Card className="border-border">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">價格預測走勢 (7日)</CardTitle>
            <Badge variant="outline" className="text-[10px]">虛線為預測區間</Badge>
          </div>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          {isLoading || !prediction ? (
            <Skeleton className="w-full h-[280px] rounded-md" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={forecastData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval={3} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={65} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                  formatter={(v: any, name: string) => [typeof v === "number" ? v.toLocaleString() : v, name]}
                />
                <Line type="monotone" dataKey="price" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="實際價格" connectNulls={false} />
                <Line type="monotone" dataKey="predicted" stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 3" dot={false} name="預測價格" connectNulls={false} />
                <Line type="monotone" dataKey="upperBound" stroke="#f59e0b" strokeWidth={1} strokeDasharray="2 2" dot={false} name="上界" opacity={0.4} connectNulls={false} />
                <Line type="monotone" dataKey="lowerBound" stroke="#f59e0b" strokeWidth={1} strokeDasharray="2 2" dot={false} name="下界" opacity={0.4} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-primary/5">
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            ⚠️ 免責聲明：此 ML 預測模型以真實歷史收盤數據（Yahoo Finance）計算技術指標，
            採 Random Forest 動量模型模擬。預測僅供參考，不構成投資建議。
            機器學習策略容易過擬合，實際投資決策請綜合基本面、市場環境與個人風險承受度。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
