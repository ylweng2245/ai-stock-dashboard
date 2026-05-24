import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Bell, Plus, Trash2, ArrowUp, ArrowDown, CheckCircle2, Clock, AlertCircle, X, RefreshCw } from "lucide-react";
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
  targetPrice: number | null;
  direction: "above" | "below";
  triggered: boolean;
  market: "TW" | "US";
  alertType: "price" | "rsi_overbought" | "rsi_oversold" | "macd_cross_up" | "macd_cross_down" | "pct_change";
  indicatorThreshold: number | null;
  createdAt: number;
}

type AlertType = PriceAlert["alertType"];

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  price: "價格突破",
  rsi_overbought: "RSI 超買",
  rsi_oversold: "RSI 超賣",
  macd_cross_up: "MACD 金叉",
  macd_cross_down: "MACD 死叉",
  pct_change: "單日漲跌幅",
};

function alertLabel(alert: PriceAlert): string {
  switch (alert.alertType) {
    case "price":
      return `${alert.direction === "above" ? "突破" : "跌破"} ${alert.market === "TW" ? "NT" : "$"}${alert.targetPrice?.toLocaleString() ?? ""}`;
    case "rsi_overbought":
      return `RSI 超買 (>${alert.indicatorThreshold ?? 70})`;
    case "rsi_oversold":
      return `RSI 超賣 (<${alert.indicatorThreshold ?? 30})`;
    case "macd_cross_up":
      return "MACD 金叉";
    case "macd_cross_down":
      return "MACD 死叉";
    case "pct_change":
      return `漲跌幅 >${alert.indicatorThreshold ?? 3}%`;
    default:
      return "";
  }
}

function AlertTypeIcon({ alert }: { alert: PriceAlert }) {
  if (alert.alertType === "price") {
    return alert.direction === "above"
      ? <ArrowUp className="w-4 h-4 text-[#ef4444]" />
      : <ArrowDown className="w-4 h-4 text-[#10b981]" />;
  }
  return <Bell className="w-4 h-4 text-[#1cb8be]" />;
}

function alertIconBg(alert: PriceAlert): string {
  if (alert.alertType === "price") {
    return alert.direction === "above" ? "bg-red-500/10" : "bg-emerald-500/10";
  }
  return "bg-[#1cb8be]/10";
}

export default function Alerts() {
  const queryClient = useQueryClient();

  // Fetch live quotes
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

  // Fetch alerts from DB
  const { data: alertsRaw, isLoading: alertsLoading } = useQuery<PriceAlert[]>({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then((r) => r.json()),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const dbAlerts: PriceAlert[] = Array.isArray(alertsRaw) ? alertsRaw : [];

  // Mutations
  const addMutation = useMutation({
    mutationFn: (body: Omit<PriceAlert, "id">) =>
      apiRequest("POST", "/api/alerts", body).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/alerts/${id}`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("PATCH", `/api/alerts/${id}/reset`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
    },
  });

  const getPrice = (symbol: string): number | null => {
    const q = quotes.find((q) => q.symbol === symbol);
    return q ? q.price : null;
  };

  // For price-type alerts, compute real-time triggered status from live quote
  const isPriceTriggered = (alert: PriceAlert): boolean => {
    if (alert.alertType !== "price") return alert.triggered;
    const currentPrice = getPrice(alert.symbol);
    if (currentPrice === null) return alert.triggered;
    if (alert.direction === "above") return currentPrice >= (alert.targetPrice ?? 0);
    return currentPrice <= (alert.targetPrice ?? 0);
  };

  const alertsWithStatus = useMemo(() =>
    dbAlerts.map((a) => ({
      ...a,
      currentPrice: getPrice(a.symbol),
      triggered: isPriceTriggered(a),
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dbAlerts, quotes]
  );

  const activeAlerts = alertsWithStatus.filter((a) => !a.triggered);
  const triggeredAlerts = alertsWithStatus.filter((a) => a.triggered);

  // Add alert form state
  const [showAdd, setShowAdd] = useState(false);
  const [newSymbol, setNewSymbol] = useState("2330");
  const [newAlertType, setNewAlertType] = useState<AlertType>("price");
  const [newPrice, setNewPrice] = useState("");
  const [newDirection, setNewDirection] = useState<"above" | "below">("above");
  const [newThreshold, setNewThreshold] = useState("");

  const handleAdd = () => {
    const wItem = watchlist?.find((w) => w.symbol === newSymbol);
    const metaStatic = STOCK_META[newSymbol];
    const name = wItem?.name ?? metaStatic?.name ?? newSymbol;
    const market = (wItem?.market ?? metaStatic?.market ?? "TW") as "TW" | "US";

    let targetPrice: number | null = null;
    let indicatorThreshold: number | null = null;

    if (newAlertType === "price") {
      if (!newPrice) return;
      targetPrice = parseFloat(newPrice);
    } else if (newAlertType === "rsi_overbought") {
      indicatorThreshold = newThreshold ? parseFloat(newThreshold) : 70;
    } else if (newAlertType === "rsi_oversold") {
      indicatorThreshold = newThreshold ? parseFloat(newThreshold) : 30;
    } else if (newAlertType === "pct_change") {
      indicatorThreshold = newThreshold ? parseFloat(newThreshold) : 3;
    }

    addMutation.mutate({
      symbol: newSymbol,
      name,
      targetPrice,
      direction: newAlertType === "price" ? newDirection : "above",
      triggered: false,
      market,
      alertType: newAlertType,
      indicatorThreshold,
      createdAt: Date.now(),
    });

    setNewPrice("");
    setNewThreshold("");
    setShowAdd(false);
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id);
  };

  const handleReset = (id: number) => {
    resetMutation.mutate(id);
  };

  return (
    <div className="p-6 space-y-4" data-testid="alerts-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">價格警報</h1>
          <p className="text-sm text-muted-foreground mt-0.5">設定目標價位或技術指標，即時追蹤觸發狀態</p>
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
              <h2 className="text-base font-semibold mb-4">新增警報</h2>
              <div className="space-y-3">
                {/* Stock selector */}
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

                {/* Alert type selector */}
                <div className="space-y-1.5">
                  <Label className="text-xs">警報類型</Label>
                  <select
                    value={newAlertType}
                    onChange={(e) => {
                      setNewAlertType(e.target.value as AlertType);
                      setNewPrice("");
                      setNewThreshold("");
                    }}
                    className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-foreground"
                  >
                    {(Object.entries(ALERT_TYPE_LABELS) as [AlertType, string][]).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>

                {/* Type-specific fields */}
                {newAlertType === "price" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">目標價格</Label>
                      <Input
                        type="number"
                        value={newPrice}
                        onChange={(e) => setNewPrice(e.target.value)}
                        placeholder="1000"
                        data-testid="alert-price-input"
                      />
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
                )}

                {newAlertType === "rsi_overbought" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">RSI 超買門檻（預設 70）</Label>
                    <Input
                      type="number"
                      value={newThreshold}
                      onChange={(e) => setNewThreshold(e.target.value)}
                      placeholder="70"
                    />
                  </div>
                )}

                {newAlertType === "rsi_oversold" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">RSI 超賣門檻（預設 30）</Label>
                    <Input
                      type="number"
                      value={newThreshold}
                      onChange={(e) => setNewThreshold(e.target.value)}
                      placeholder="30"
                    />
                  </div>
                )}

                {(newAlertType === "macd_cross_up" || newAlertType === "macd_cross_down") && (
                  <div className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {newAlertType === "macd_cross_up"
                      ? "當 MACD 線從下穿越訊號線（金叉）時觸發，無需額外設定。"
                      : "當 MACD 線從上穿越訊號線（死叉）時觸發，無需額外設定。"}
                  </div>
                )}

                {newAlertType === "pct_change" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">單日漲跌幅門檻 (%)（預設 3%）</Label>
                    <Input
                      type="number"
                      value={newThreshold}
                      onChange={(e) => setNewThreshold(e.target.value)}
                      placeholder="3"
                    />
                  </div>
                )}

                {/* Current price hint */}
                {newSymbol && getPrice(newSymbol) !== null && (
                  <p className="text-xs text-muted-foreground">
                    現價: {(watchlist?.find((w) => w.symbol === newSymbol)?.market ?? STOCK_META[newSymbol]?.market) === "TW" ? "NT" : "$"}{getPrice(newSymbol)?.toLocaleString()}
                  </p>
                )}

                <Button
                  onClick={handleAdd}
                  className="w-full"
                  data-testid="confirm-alert"
                  disabled={addMutation.isPending}
                >
                  {addMutation.isPending ? "新增中…" : "確認新增"}
                </Button>
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
              <div className="text-lg font-semibold tabular-nums">{dbAlerts.length}</div>
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

      {/* Loading state */}
      {alertsLoading && (
        <div className="text-center py-6 text-sm text-muted-foreground">載入警報中…</div>
      )}

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
            <div className="text-center py-8 text-sm text-muted-foreground">
              {alertsLoading ? "載入中…" : "尚無監控中的警報"}
            </div>
          ) : (
            <div className="space-y-2">
              {activeAlerts.map((alert) => {
                const currentPrice = alert.currentPrice;
                const isPrice = alert.alertType === "price";
                const distance = isPrice && currentPrice !== null && alert.targetPrice !== null
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
                      <div className={cn("w-8 h-8 rounded-md flex items-center justify-center", alertIconBg(alert))}>
                        <AlertTypeIcon alert={alert} />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{alert.symbol} {alert.name}</div>
                        <div className="text-xs text-muted-foreground">{alertLabel(alert)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        {isPrice && currentPrice !== null ? (
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
                        ) : !isPrice ? (
                          <div className="text-xs text-[#1cb8be]">監控中</div>
                        ) : (
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" />載入中
                          </div>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleDelete(alert.id)}
                        data-testid={`delete-alert-${alert.id}`}
                        disabled={deleteMutation.isPending}
                      >
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
                        {alertLabel(alert)}
                        {alert.alertType === "price" && alert.currentPrice !== null && (
                          <> — 現價 {alert.market === "TW" ? "NT" : "$"}{alert.currentPrice.toLocaleString()}</>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-[11px] text-[#1cb8be] hover:text-[#1cb8be]/80"
                      onClick={() => handleReset(alert.id)}
                      disabled={resetMutation.isPending}
                    >
                      <RefreshCw className="w-3 h-3" />
                      重置
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleDelete(alert.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                  </div>
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
