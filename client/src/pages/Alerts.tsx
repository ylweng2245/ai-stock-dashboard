import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Bell, Plus, Trash2, ArrowUp, ArrowDown, CheckCircle2, Clock, AlertCircle, X } from "lucide-react";
import { STOCK_META, StockQuote } from "@/lib/stockData";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface WatchlistItem {
  id: number;
  symbol: string;
  name: string;
  market: "TW" | "US";
  sortOrder: number;
}

interface PriceAlert {
  id: number;
  symbol: string;
  name: string;
  targetPrice: number;
  direction: "above" | "below";
  triggered: boolean;
  market: "TW" | "US";
}

export default function Alerts() {
  // Fetch live quotes — use a unique key so cache doesn't conflict with Dashboard's raw object cache
  const { data: quotesRaw } = useQuery({
    queryKey: ["/api/quotes", "alerts"],
    queryFn: () =>
      apiRequest("GET", "/api/quotes")
        .then((r) => r.json())
        .then((d) => (Array.isArray(d) ? d : (d.quotes ?? [])) as StockQuote[]),
    refetchInterval: 60_000,
  });
  const quotes = Array.isArray(quotesRaw) ? quotesRaw : [];

  // Fetch live watchlist from DB for stock selector
  const { data: watchlist } = useQuery<WatchlistItem[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 30_000,
  });

  const getPrice = (symbol: string): number | null => {
    const q = quotes.find((q) => q.symbol === symbol);
    return q ? q.price : null;
  };

  const [alerts, setAlerts] = useState<PriceAlert[]>([
    { id: 1, symbol: "2330", name: "台積電", targetPrice: 2200, direction: "above", triggered: false, market: "TW" },
    { id: 2, symbol: "2330", name: "台積電", targetPrice: 1900, direction: "below", triggered: false, market: "TW" },
    { id: 3, symbol: "PANW", name: "Palo Alto Networks", targetPrice: 170, direction: "below", triggered: false, market: "US" },
    { id: 4, symbol: "0050", name: "元大台灣50", targetPrice: 90, direction: "above", triggered: false, market: "TW" },
    { id: 5, symbol: "LLY", name: "Eli Lilly", targetPrice: 750, direction: "below", triggered: false, market: "US" },
  ]);

  const [showAdd, setShowAdd] = useState(false);
  const [newSymbol, setNewSymbol] = useState("2330");
  const [newPrice, setNewPrice] = useState("");
  const [newDirection, setNewDirection] = useState<"above" | "below">("above");

  const handleAdd = () => {
    if (!newPrice) return;
    // Try watchlist first, then static STOCK_META
    const wItem = watchlist?.find((w) => w.symbol === newSymbol);
    const metaStatic = STOCK_META[newSymbol];
    const name = wItem?.name ?? metaStatic?.name ?? newSymbol;
    const market = wItem?.market ?? metaStatic?.market ?? "TW";

    setAlerts((prev) => [
      ...prev,
      {
        id: Date.now(),
        symbol: newSymbol,
        name,
        targetPrice: parseFloat(newPrice),
        direction: newDirection,
        triggered: false,
        market,
      },
    ]);
    setNewPrice("");
    setShowAdd(false);
  };

  const handleDelete = (id: number) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  // Check if alert is triggered against live price
  const isTriggered = (alert: PriceAlert): boolean => {
    const currentPrice = getPrice(alert.symbol);
    if (currentPrice === null) return alert.triggered;
    if (alert.direction === "above") return currentPrice >= alert.targetPrice;
    return currentPrice <= alert.targetPrice;
  };

  const alertsWithStatus = alerts.map((a) => ({
    ...a,
    currentPrice: getPrice(a.symbol),
    triggered: isTriggered(a),
  }));

  const activeAlerts = alertsWithStatus.filter((a) => !a.triggered);
  const triggeredAlerts = alertsWithStatus.filter((a) => a.triggered);

  return (
    <div className="p-6 space-y-4" data-testid="alerts-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">價格警報</h1>
          <p className="text-sm text-muted-foreground mt-0.5">設定目標價位，即時追蹤觸發狀態</p>
        </div>
          <Button size="sm" className="gap-1.5" data-testid="add-alert-btn" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4" />
            新增警報
          </Button>

          {/* Custom modal — no Radix Portal, iframe-safe */}
          {showAdd && (
            <div
              className="fixed inset-0 z-[300] flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.75)" }}
              onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}
            >
              <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md p-6 relative">
                <button
                  onClick={() => setShowAdd(false)}
                  className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
                <h2 className="text-base font-semibold mb-4">新增價格警報</h2>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">選擇股票</Label>
                    <select
                      data-testid="alert-stock-select"
                      value={newSymbol}
                      onChange={(e) => setNewSymbol(e.target.value)}
                      className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 text-foreground"
                    >
                      {(watchlist ?? []).length > 0 ? (() => {
                        const tw = (watchlist ?? []).filter((w) => w.market === "TW");
                        const us = (watchlist ?? []).filter((w) => w.market === "US");
                        return (
                          <>
                            {tw.length > 0 && (
                              <optgroup label="台股">
                                {tw.map((w) => (
                                  <option key={w.symbol} value={w.symbol}>{w.symbol} — {w.name}</option>
                                ))}
                              </optgroup>
                            )}
                            {us.length > 0 && (
                              <optgroup label="美股">
                                {us.map((w) => (
                                  <option key={w.symbol} value={w.symbol}>{w.symbol} — {w.name}</option>
                                ))}
                              </optgroup>
                            )}
                          </>
                        );
                      })() : (
                        <option value={newSymbol}>{newSymbol}</option>
                      )}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">目標價格</Label>
                      <Input type="number" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="1000" data-testid="alert-price-input" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">方向</Label>
                      <select
                        value={newDirection}
                        onChange={(e) => setNewDirection(e.target.value as "above" | "below")}
                        className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-foreground"
                      >
                        <option value="above">突破 (高於)</option>
                        <option value="below">跌破 (低於)</option>
                      </select>
                    </div>
                  </div>
                  {newSymbol && getPrice(newSymbol) !== null && (
                    <p className="text-xs text-muted-foreground">
                      現價: {(watchlist?.find((w) => w.symbol === newSymbol)?.market ?? STOCK_META[newSymbol]?.market) === "TW" ? "NT" : "$"}{getPrice(newSymbol)?.toLocaleString()}
                    </p>
                  )}
                  <Button onClick={handleAdd} className="w-full" data-testid="confirm-alert">確認新增</Button>
                </div>
              </div>
            </div>
          )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Bell className="w-4 h-4 text-primary" />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">總警報數</div>
              <div className="text-lg font-semibold tabular-nums">{alerts.length}</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Clock className="w-4 h-4 text-amber-500" />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">監控中</div>
              <div className="text-lg font-semibold tabular-nums">{activeAlerts.length}</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">已觸發</div>
              <div className="text-lg font-semibold tabular-nums">{triggeredAlerts.length}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Active Alerts */}
      <Card className="border-border">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-semibold">監控中的警報</CardTitle>
            <Badge variant="outline" className="text-[10px]">{activeAlerts.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          {activeAlerts.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">尚無監控中的警報</div>
          ) : (
            <div className="space-y-2">
              {activeAlerts.map((alert) => {
                const currentPrice = alert.currentPrice;
                const distance = currentPrice !== null
                  ? ((alert.targetPrice - currentPrice) / currentPrice * 100)
                  : null;
                const isClose = distance !== null && Math.abs(distance) < 3;
                return (
                  <div
                    key={alert.id}
                    className={cn(
                      "flex items-center justify-between p-3 rounded-lg border",
                      isClose ? "border-amber-500/30 bg-amber-500/5" : "border-border"
                    )}
                    data-testid={`alert-${alert.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-8 h-8 rounded-md flex items-center justify-center",
                        alert.direction === "above" ? "bg-red-500/10" : "bg-emerald-500/10"
                      )}>
                        {alert.direction === "above" ? (
                          <ArrowUp className="w-4 h-4 text-red-500" />
                        ) : (
                          <ArrowDown className="w-4 h-4 text-emerald-500" />
                        )}
                      </div>
                      <div>
                        <div className="text-sm font-medium">{alert.symbol} {alert.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {alert.direction === "above" ? "突破" : "跌破"}{" "}
                          {alert.market === "TW" ? "NT" : "$"}{alert.targetPrice.toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        {currentPrice !== null ? (
                          <>
                            <div className="text-sm tabular-nums">
                              現價: {alert.market === "TW" ? "NT" : "$"}{currentPrice.toLocaleString()}
                            </div>
                            {distance !== null && (
                              <div className={cn("text-xs tabular-nums", isClose ? "text-amber-500 font-medium" : "text-muted-foreground")}>
                                距離 {distance.toFixed(1)}%
                                {isClose && " ⚡ 接近目標"}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" />載入中
                          </div>
                        )}
                      </div>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(alert.id)} data-testid={`delete-alert-${alert.id}`}>
                        <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Triggered Alerts */}
      {triggeredAlerts.length > 0 && (
        <Card className="border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-semibold">已觸發</CardTitle>
              <Badge variant="secondary" className="text-[10px]">{triggeredAlerts.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <div className="space-y-2">
              {triggeredAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5"
                  data-testid={`triggered-${alert.id}`}
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    <div>
                      <div className="text-sm font-medium">{alert.symbol} {alert.name}</div>
                      <div className="text-xs text-muted-foreground">
                        已{alert.direction === "above" ? "突破" : "跌破"}{" "}
                        {alert.market === "TW" ? "NT" : "$"}{alert.targetPrice.toLocaleString()}
                        {alert.currentPrice !== null && (
                          <> — 現價 {alert.market === "TW" ? "NT" : "$"}{alert.currentPrice.toLocaleString()}</>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(alert.id)}>
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Data source attribution */}
      <p className="text-[11px] text-muted-foreground/50 text-center pt-2">
        即時報價來源：台股 —{" "}
        <a href="https://mis.twse.com.tw" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">
          TWSE 臺灣證券交易所
        </a>
        {" "}｜ 美股 —{" "}
        <a href="https://finance.yahoo.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">
          Yahoo Finance
        </a>
      </p>
    </div>
  );
}
