import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Brain, TrendingUp, TrendingDown, RefreshCw, Target, History, ChevronRight } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PricePt {
  date: string;
  price: number;
}

interface PredictionResult {
  runAt: string;
  horizonDays: number;
  startDate: string;
  endDate: string;
  medianPath: PricePt[];
  upperPath: PricePt[];
  lowerPath: PricePt[];
  modelName?: string;
}

interface PersonalAdvice {
  primaryAction:
    | "hold"
    | "add_on_dip"
    | "take_profit_partial"
    | "cut_loss"
    | "avoid_new_entry";
  reasons: string[];
  confidence?: number;
}

interface PredictionHistoryItem {
  runAt: string;
  horizonDays: number;
  startDate: string;
  endDate: string;
  medianPath: PricePt[];
  upperPath: PricePt[];
  lowerPath: PricePt[];
  accuracy?: {
    mae: number;
    mape: number;
    directionCorrect: boolean;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HORIZONS = [
  { days: 5, label: "5日" },
  { days: 20, label: "20日" },
  { days: 60, label: "60日" },
] as const;

const ACTION_CONFIG: Record<
  NonNullable<PersonalAdvice["primaryAction"]>,
  { label: string; className: string }
> = {
  hold:                  { label: "持有觀望",       className: "text-muted-foreground border-muted" },
  add_on_dip:            { label: "逢低加碼",       className: "text-[#1cb8be] border-[#1cb8be]/40" },
  take_profit_partial:   { label: "部分獲利了結",   className: "text-[#ef4444] border-[#ef4444]/40" },
  cut_loss:              { label: "停損出場",       className: "text-[#10b981] border-[#10b981]/40" },
  avoid_new_entry:       { label: "避免新進場",     className: "text-amber-400 border-amber-400/40" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(val: number): string {
  const sign = val >= 0 ? "+" : "";
  return `${sign}${val.toFixed(2)}%`;
}

function computeReturn(path: PricePt[]): number {
  if (path.length < 2) return 0;
  const first = path[0].price;
  const last = path[path.length - 1].price;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function nDaysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Merge median/upper/lower paths into a single array for the chart
function buildChartData(
  median: PricePt[],
  upper: PricePt[],
  lower: PricePt[],
): Array<{ date: string; median: number; upper?: number; lower?: number }> {
  const upperMap = new Map(upper.map((p) => [p.date, p.price]));
  const lowerMap = new Map(lower.map((p) => [p.date, p.price]));
  return median.map((p) => ({
    date: p.date.slice(5), // MM-DD
    median: p.price,
    upper: upperMap.get(p.date),
    lower: lowerMap.get(p.date),
  }));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PredictionChart({ result }: { result: PredictionResult }) {
  const data = buildChartData(result.medianPath, result.upperPath, result.lowerPath);
  const expectedReturn = computeReturn(result.medianPath);
  const upside = computeReturn(result.upperPath);
  const downside = computeReturn(result.lowerPath);

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-[#1cb8be]" />
            預測走勢圖（{result.horizonDays}日）
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{result.startDate}</span>
            <ChevronRight className="w-3 h-3" />
            <span>{result.endDate}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-3">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              interval={Math.floor(data.length / 6)}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              width={65}
              tickFormatter={(v: number) => v.toLocaleString()}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(v: number, name: string) => [
                v?.toLocaleString() ?? "—",
                name,
              ]}
            />
            {/* Upper confidence band */}
            <Line
              type="monotone"
              dataKey="upper"
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="4 3"
              dot={false}
              name="上界"
              strokeOpacity={0.5}
              connectNulls
            />
            {/* Lower confidence band */}
            <Line
              type="monotone"
              dataKey="lower"
              stroke="#10b981"
              strokeWidth={1}
              strokeDasharray="4 3"
              dot={false}
              name="下界"
              strokeOpacity={0.5}
              connectNulls
            />
            {/* Median prediction path */}
            <Line
              type="monotone"
              dataKey="median"
              stroke="#1cb8be"
              strokeWidth={2}
              dot={false}
              name="預測中位"
              connectNulls
            />
            {/* Reference line at first price */}
            {data[0] && (
              <ReferenceLine
                y={data[0].median}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}
          </LineChart>
        </ResponsiveContainer>

        {/* Summary stats row */}
        <div className="grid grid-cols-3 gap-3 mt-3 px-2">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground mb-0.5">預期報酬</p>
            <p
              className={cn(
                "text-sm font-bold tabular-nums",
                expectedReturn >= 0 ? "text-[#ef4444]" : "text-[#10b981]",
              )}
            >
              {fmtPct(expectedReturn)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground mb-0.5">上行潛力</p>
            <p className="text-sm font-bold tabular-nums text-[#ef4444]">
              {fmtPct(upside)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground mb-0.5">下行風險</p>
            <p className="text-sm font-bold tabular-nums text-[#10b981]">
              {fmtPct(downside)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PersonalAdviceCard({ symbol, market }: { symbol: string; market: string }) {
  const { data, isLoading, isError } = useQuery<PersonalAdvice>({
    queryKey: ["/api/personal-advice", symbol, market],
    queryFn: () =>
      apiRequest("GET", `/api/personal-advice?symbol=${symbol}&market=${market}`).then(
        (r) => r.json(),
      ),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const cfg = data ? ACTION_CONFIG[data.primaryAction] : null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Target className="w-4 h-4 text-[#1cb8be]" />
          個人操作建議
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isLoading && (
          <div className="space-y-2">
            <div className="h-8 bg-muted/30 rounded-md animate-pulse" />
            <div className="h-4 bg-muted/20 rounded animate-pulse w-3/4" />
            <div className="h-4 bg-muted/20 rounded animate-pulse w-1/2" />
          </div>
        )}

        {isError && (
          <p className="text-xs text-muted-foreground">無法載入建議，請重試。</p>
        )}

        {data && cfg && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn("text-sm font-semibold px-3 py-1", cfg.className)}
              >
                {cfg.label}
              </Badge>
              {data.confidence !== undefined && (
                <span className="text-xs text-muted-foreground">
                  信心度 {(data.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
            {data.reasons.length > 0 && (
              <ul className="space-y-1">
                {data.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 text-[#66c6df]" />
                    {r}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PredictionHistorySection({
  symbol,
  market,
  horizonDays,
}: {
  symbol: string;
  market: string;
  horizonDays: number;
}) {
  const [open, setOpen] = useState(false);
  const from = nDaysAgoStr(180);
  const to = todayStr();

  const { data, isLoading, isError } = useQuery<PredictionHistoryItem[]>({
    queryKey: ["/api/prediction-history", symbol, market, horizonDays, from, to],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/prediction-history?symbol=${symbol}&market=${market}&horizon=${horizonDays}&from=${from}&to=${to}`,
      ).then((r) => r.json()),
    enabled: open,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <History className="w-4 h-4 text-[#1cb8be]" />
            預測歷史
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "隱藏" : "顯示預測歷史"}
            <ChevronRight
              className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-90")}
            />
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="px-4 pb-4">
          {isLoading && (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 bg-muted/20 rounded-md animate-pulse" />
              ))}
            </div>
          )}

          {isError && (
            <p className="text-xs text-muted-foreground">無法載入歷史記錄。</p>
          )}

          {data && data.length === 0 && (
            <p className="text-xs text-muted-foreground">尚無預測歷史紀錄。</p>
          )}

          {data && data.length > 0 && (
            <div className="space-y-2">
              {data.map((item, idx) => {
                const ret = computeReturn(item.medianPath);
                return (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 bg-muted/10"
                  >
                    <div>
                      <p className="text-xs font-medium">{item.runAt}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {item.startDate} → {item.endDate}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={cn(
                          "text-xs font-bold tabular-nums",
                          ret >= 0 ? "text-[#ef4444]" : "text-[#10b981]",
                        )}
                      >
                        {fmtPct(ret)}
                      </p>
                      {item.accuracy && (
                        <p className="text-[10px] text-muted-foreground">
                          MAE {item.accuracy.mae.toFixed(2)} ·{" "}
                          {item.accuracy.directionCorrect ? "方向正確 ✓" : "方向錯誤 ✗"}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MLPrediction() {
  const { activeSymbol, activeMarket } = useActiveSymbol();

  const [horizonDays, setHorizonDays] = useState<5 | 20 | 60>(20);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [hasRun, setHasRun] = useState(false);

  // Reset prediction when symbol or market changes
  const symbolKey = `${activeSymbol}:${activeMarket}`;
  const [lastSymbolKey, setLastSymbolKey] = useState(symbolKey);
  if (symbolKey !== lastSymbolKey) {
    setLastSymbolKey(symbolKey);
    setPrediction(null);
    setHasRun(false);
    setRunError(null);
  }

  const handleRunPrediction = async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      const res = await apiRequest("POST", "/api/prediction/run", {
        symbol: activeSymbol,
        market: activeMarket,
        horizonDays,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json();
      // Python subprocess may return { ok: false, error: '...' } with HTTP 200
      if (result.ok === false) {
        throw new Error(result.error ?? "預測執行失敗");
      }
      // Validate required fields before setting state
      if (!result.medianPath || !Array.isArray(result.medianPath)) {
        throw new Error(`回傳資料格式錯誤：${JSON.stringify(result).slice(0, 100)}`);
      }
      setPrediction(result as PredictionResult);
      setHasRun(true);
    } catch (e: any) {
      setRunError(e.message ?? "預測執行失敗");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="px-6 py-6 max-w-[1100px] mx-auto space-y-4">

          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div>
              <h1 className="text-[28px] font-bold tracking-tight">股價走勢預測</h1>
              <p className="text-[13px] text-muted-foreground mt-1">
                Random Forest 模型 | 歷史資料訓練 | 多時間維度
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant="outline"
                className="text-[11px] text-[#66c6df] border-[#66c6df]/30 bg-[#66c6df]/5"
              >
                <Brain className="w-3 h-3 mr-1" />
                {activeSymbol} · {activeMarket}
              </Badge>
            </div>
          </div>

          {/* Controls: Horizon selector + Run button */}
          <Card className="border-border">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">預測時間維度</p>
                  <div className="flex gap-1.5">
                    {HORIZONS.map(({ days, label }) => (
                      <Button
                        key={days}
                        variant={horizonDays === days ? "default" : "outline"}
                        size="sm"
                        className={cn(
                          "h-8 px-3 text-xs",
                          horizonDays === days &&
                            "bg-[#1cb8be] hover:bg-[#1cb8be]/90 text-white border-transparent",
                        )}
                        onClick={() => setHorizonDays(days as 5 | 20 | 60)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="ml-auto">
                  <Button
                    onClick={handleRunPrediction}
                    disabled={isRunning}
                    className="gap-2 bg-[#1cb8be] hover:bg-[#1cb8be]/90 text-white"
                    data-testid="run-prediction"
                  >
                    {isRunning ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Brain className="w-4 h-4" />
                    )}
                    {isRunning ? "運算中…" : "執行預測"}
                  </Button>
                </div>
              </div>

              {runError && (
                <p className="mt-2 text-xs text-destructive">{runError}</p>
              )}
            </CardContent>
          </Card>

          {/* Empty state before first run */}
          {!hasRun && !isRunning && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <Brain className="w-12 h-12 opacity-20" />
              <p className="text-sm">選擇時間維度後，點擊「執行預測」開始分析</p>
            </div>
          )}

          {/* Loading skeleton */}
          {isRunning && (
            <Card className="border-border">
              <CardContent className="p-4 space-y-3">
                <div className="h-5 bg-muted/30 rounded animate-pulse w-1/3" />
                <div className="h-[240px] bg-muted/20 rounded-md animate-pulse" />
                <div className="grid grid-cols-3 gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-12 bg-muted/20 rounded animate-pulse" />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Prediction result */}
          {prediction && !isRunning && (
            <>
              <PredictionChart result={prediction} />
              <PersonalAdviceCard symbol={activeSymbol} market={activeMarket} />
            </>
          )}

          {/* Prediction history (always shown after first interaction, lazy loaded) */}
          {hasRun && (
            <PredictionHistorySection
              symbol={activeSymbol}
              market={activeMarket}
              horizonDays={horizonDays}
            />
          )}

          {/* Disclaimer */}
          <Card className="border-border bg-muted/5">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                ⚠️ 免責聲明：此 ML 預測模型以歷史收盤資料訓練，採 Random Forest 動量模型模擬。
                預測結果僅供參考，不構成投資建議。機器學習模型容易過擬合，
                實際投資決策請綜合基本面、市場環境與個人風險承受度。
              </p>
            </CardContent>
          </Card>

    </div>
  );
}
