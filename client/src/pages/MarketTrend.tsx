import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Globe, TrendingUp, TrendingDown, AlertTriangle, BarChart3, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart,
} from "recharts";
import { OptimizeButton } from "@/components/OptimizeButton";

// ── Constants ───────────────────────────────────────────────────────────────

const INDEX_LIST = [
  { symbol: "^DJI",  name: "道瓊工業指數", shortName: "DJIA" },
  { symbol: "^GSPC", name: "S&P 500",      shortName: "SPX" },
  { symbol: "^IXIC", name: "Nasdaq 綜合",  shortName: "NDX" },
  { symbol: "^SOX",  name: "費城半導體",   shortName: "SOX" },
];

const TREND_LABEL_CONFIG: Record<string, { bg: string; text: string }> = {
  "強多":     { bg: "bg-gain/20",       text: "text-gain" },
  "偏多趨強": { bg: "bg-gain/10",       text: "text-gain" },
  "偏多趨弱": { bg: "bg-yellow-500/10", text: "text-yellow-400" },
  "盤整":     { bg: "bg-muted",         text: "text-muted-foreground" },
  "偏空趨弱": { bg: "bg-loss/10",       text: "text-loss" },
  "強空":     { bg: "bg-loss/20",       text: "text-loss" },
};

const STOCK_SECTOR_MAP: Record<string, string> = {
  AMD: "SOXX", INTC: "SOXX", IONQ: "SOXX", QBTS: "SOXX", LITE: "SOXX",
  PANW: "CIBR", CRWD: "CIBR",
  RKLB: "ARKX", ASTS: "ARKX",
  OKLO: "URNM",
  LLY: "XBI", NTLA: "XBI", TEM: "XBI",
  VST: "URNM", CEG: "URNM",
  ETN: "XLI", BE: "XLI", VRT: "XLI",
};

// ── Index Chart Component ──────────────────────────────────────────────────

function IndexChart({ symbol, name, shortName }: { symbol: string; name: string; shortName: string }) {
  const encoded = encodeURIComponent(symbol);
  const [showHistory, setShowHistory] = useState(false);

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ["/api/market-trend/index-history", symbol],
    queryFn: () => fetch(`/api/market-trend/index-history/${encoded}`).then(r => r.json()),
    staleTime: 300_000,
  });

  const { data: predData } = useQuery({
    queryKey: ["/api/market-trend/index-prediction", symbol],
    queryFn: () => fetch(`/api/market-trend/index-prediction/${encoded}`).then(r => r.json()),
    staleTime: 300_000,
  });

  // Main chart: last 60 bars + 20-day prediction with p25/p75 band
  const chartData = useMemo(() => {
    const bars = histData?.bars ?? [];
    const last60 = bars.slice(-60);
    const data: any[] = last60.map((b: any) => ({
      date: b.date.slice(5),
      fullDate: b.date,
      close: b.close,
      pred: null as number | null,
      band: null as [number, number] | null,
    }));

    if (predData?.found && predData.horizons) {
      const hKeys = Object.keys(predData.horizons).map(Number).sort((a, b) => a - b);
      if (data.length > 0 && hKeys.length > 0) {
        const lastHist = data[data.length - 1];
        data.push({ date: lastHist.date, fullDate: lastHist.fullDate, close: null, pred: lastHist.close, band: null });
      }
      for (const h of hKeys.slice(0, 20)) {
        const hp = predData.horizons[String(h)];
        if (hp) {
          data.push({
            date: hp.targetDate.slice(5),
            fullDate: hp.targetDate,
            close: null,
            pred: hp.medianPrice,
            band: (hp.lowerPrice != null && hp.upperPrice != null)
              ? [hp.lowerPrice, hp.upperPrice]
              : null,
          });
        }
      }
    }
    return data;
  }, [histData, predData]);

  // History comparison: past predictions vs actual close
  const histCompareData = useMemo(() => {
    if (!predData?.pastPredictions || !histData?.bars) return [];
    const barMap = new Map<string, number>();
    for (const b of histData.bars) barMap.set(b.date, b.close);

    const rows: any[] = [];
    for (const pp of [...predData.pastPredictions].reverse()) {
      const d1 = pp.day1;
      if (!d1) continue;
      const actual = barMap.get(d1.targetDate) ?? null;
      if (actual === null) continue; // only show if we have actual data
      rows.push({
        date: pp.baseDate?.slice(5) ?? "",
        predicted: Math.round(d1.medianPrice),
        actual: Math.round(actual),
        error: Math.round(actual - d1.medianPrice),
        errorPct: (((actual - d1.medianPrice) / d1.medianPrice) * 100).toFixed(2),
      });
    }
    return rows.slice(-15); // last 15 entries
  }, [predData, histData]);

  const bars = histData?.bars ?? [];
  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const change = lastBar && prevBar ? ((lastBar.close - prevBar.close) / prevBar.close * 100) : 0;
  const isUp = change >= 0;

  if (histLoading) {
    return (
      <Card className="border-border">
        <CardContent className="p-4">
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border">
      <CardHeader className="pb-1 pt-3 px-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs font-mono text-muted-foreground">{shortName}</span>
            <h3 className="text-sm font-medium">{name}</h3>
          </div>
          <div className="flex items-center gap-3">
            {histCompareData.length > 0 && (
              <button
                onClick={() => setShowHistory(v => !v)}
                className={cn("text-xs px-2 py-0.5 rounded border transition-colors",
                  showHistory
                    ? "border-[#1cb8be] text-[#1cb8be] bg-[#1cb8be]/10"
                    : "border-border text-muted-foreground hover:border-[#1cb8be]/50"
                )}
              >
                歷史比對
              </button>
            )}
            {lastBar && (
              <div className="text-right">
                <div className="text-sm font-semibold tabular-nums">
                  {lastBar.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
                <div className={cn("text-xs tabular-nums", isUp ? "text-gain" : "text-loss")}>
                  {change.toFixed(2)}%
                </div>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-3">
        {chartData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={170}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  interval={Math.floor(chartData.length / 4)} />
                <YAxis
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}
                  width={45}
                />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 11 }}
                  formatter={(value: any, name: string) => {
                    if (name === "band") return null;
                    const label = name === "close" ? "收盤" : name === "pred" ? "ML預測" : name;
                    return [value != null ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-", label];
                  }}
                />
                {/* p25~p75 confidence band */}
                <Area
                  dataKey="band"
                  stroke="none"
                  fill="#1cb8be"
                  fillOpacity={0.12}
                  connectNulls={false}
                  activeDot={false}
                  legendType="none"
                />
                <Line dataKey="close" stroke={isUp ? "#ef4444" : "#10b981"} dot={false} strokeWidth={1.5} connectNulls={false} />
                <Line dataKey="pred" stroke="#1cb8be" dot={false} strokeWidth={1.5} strokeDasharray="4 3" connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
            {predData?.found && (
              <div className="px-2 mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-5 border-t-2 border-dashed border-[#1cb8be]" />
                  ML預測
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-5 h-2 rounded-sm bg-[#1cb8be]/20 border border-[#1cb8be]/40" />
                  25%~75% 範圍
                </span>
                <span className="text-muted-foreground/60">基準 {predData.baseDate}</span>
              </div>
            )}

            {/* History comparison table */}
            {showHistory && histCompareData.length > 0 && (
              <div className="mt-3 border border-border rounded-md overflow-hidden">
                <div className="px-3 py-1.5 bg-muted/30 text-xs font-medium text-muted-foreground">
                  歷史預測 vs 實際（Day+1）
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="px-2 py-1 text-left text-muted-foreground font-normal">基準日</th>
                        <th className="px-2 py-1 text-right text-muted-foreground font-normal">預測</th>
                        <th className="px-2 py-1 text-right text-muted-foreground font-normal">實際</th>
                        <th className="px-2 py-1 text-right text-muted-foreground font-normal">誤差%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {histCompareData.map((r, i) => (
                        <tr key={i} className="border-b border-border/30 last:border-0">
                          <td className="px-2 py-1 tabular-nums">{r.date}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.predicted.toLocaleString()}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.actual.toLocaleString()}</td>
                          <td className={cn("px-2 py-1 text-right tabular-nums",
                            Math.abs(parseFloat(r.errorPct)) < 0.5 ? "text-muted-foreground" :
                            r.error > 0 ? "text-gain" : "text-loss"
                          )}>
                            {r.error > 0 ? "" : ""}{r.errorPct}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="h-[170px] flex items-center justify-center text-xs text-muted-foreground">
            資料不足
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Trend Analysis Module ──────────────────────────────────────────────────

function TrendAnalysisSection({ data }: { data: any }) {
  if (!data) {
    return (
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-[#1cb8be]" />
            趨勢多空判斷
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">SPY 資料不足（需 65 日以上歷史）</p>
        </CardContent>
      </Card>
    );
  }

  const periods = [
    { key: "short",  label: "短期 5日",  data: data.short },
    { key: "medium", label: "中期 20日", data: data.medium },
    { key: "long",   label: "長期 60日", data: data.long },
  ];

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[#1cb8be]" />
          趨勢多空判斷（SPY）
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {periods.map(p => {
            const cfg = TREND_LABEL_CONFIG[p.data.label] ?? TREND_LABEL_CONFIG["盤整"];
            return (
              <div key={p.key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{p.label}</span>
                  <Badge className={cn("text-xs", cfg.bg, cfg.text)}>
                    {p.data.label}（{p.data.score}分）
                  </Badge>
                </div>
                <div className="text-xs space-y-1 text-muted-foreground">
                  <div>MA: {p.data.ma?.toFixed(2)} · 斜率: {p.data.maSlope?.toFixed(2)}%</div>
                  <div>支撐: {p.data.support?.toFixed(2)} · 壓力: {p.data.resistance?.toFixed(2)}</div>
                </div>
                <p className="text-xs leading-relaxed">{p.data.desc}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-xs text-muted-foreground">
          RSI: {data.rsi?.toFixed(0)} · 量比: {data.volRatio?.toFixed(2)} · MACD: {data.macdHist?.toFixed(2)}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Crash Risk Module ──────────────────────────────────────────────────────

function CrashRiskSection({ data }: { data: any }) {
  if (!data) {
    return (
      <Card className="border-border">
        <CardContent className="py-3 px-4">
          <p className="text-sm text-muted-foreground">崩盤風險資料不足</p>
        </CardContent>
      </Card>
    );
  }

  // Taiwan color convention: low score (safe) = red (gain), high score (danger) = green (loss)
  const scoreColor =
    data.score >= 80 ? "text-loss" :     // 極危
    data.score >= 60 ? "text-loss" :     // 高風險
    data.score >= 40 ? "text-yellow-400" : // 警戒
    data.score >= 20 ? "text-muted-foreground" : // 低風險
    "text-gain";                          // 安全

  const barColor =
    data.score >= 80 ? "bg-[#10b981]" :
    data.score >= 60 ? "bg-[#10b981]" :
    data.score >= 40 ? "bg-yellow-400" :
    data.score >= 20 ? "bg-muted-foreground" :
    "bg-[#ef4444]";

  const factors = data.factors ?? [];
  const half = Math.ceil(factors.length / 2);
  const col1 = factors.slice(0, half);
  const col2 = factors.slice(half);

  return (
    <Card className="border-border">
      <CardContent className="py-4 px-5">
        <div className="flex gap-6 items-stretch">
          {/* Left: score block */}
          <div className="flex flex-col items-center justify-center shrink-0 w-44 gap-1">
            <div className="flex items-center gap-1.5 self-stretch mb-1">
              <AlertTriangle className="w-3.5 h-3.5 text-[#1cb8be]" />
              <span className="text-xs font-medium text-muted-foreground">崩盤風險指數</span>
            </div>
            <div className={cn("text-6xl font-bold tabular-nums leading-none", scoreColor)}>
              {data.score}
            </div>
            <div className={cn("text-sm font-semibold mt-1", scoreColor)}>{data.level}</div>
            <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden mt-2">
              <div className={cn("h-full rounded-full", barColor)} style={{ width: `${data.score}%` }} />
            </div>
          </div>

          {/* Divider */}
          <div className="w-px bg-border/50 self-stretch" />

          {/* Right: factors in two columns */}
          <div className="flex-1 grid grid-cols-2 gap-x-8 gap-y-1.5 content-center pl-2">
            {[col1, col2].map((col, ci) => (
              <div key={ci} className="space-y-1.5">
                {col.map((f: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <div className="shrink-0 flex items-center gap-1.5 min-w-[120px]">
                      <span className="text-muted-foreground">{f.name}</span>
                      <span className={cn("font-mono tabular-nums",
                        f.score > f.maxScore * 0.6 ? "text-loss" :
                        f.score > f.maxScore * 0.3 ? "text-yellow-400" : "text-muted-foreground"
                      )}>{f.score}/{f.maxScore}</span>
                    </div>
                    <span className="text-muted-foreground leading-tight">{f.detail}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Sector Heatmap Module ──────────────────────────────────────────────────

function SectorHeatmapSection({ data }: { data: any[] | undefined }) {
  const { data: portfolio } = useQuery({
    queryKey: ["/api/portfolio/computed"],
    queryFn: () => fetch("/api/portfolio/computed").then(r => r.json()),
    staleTime: 120_000,
  });
  const { data: quotesRaw } = useQuery({
    queryKey: ["/api/quotes"],
    queryFn: () => fetch("/api/quotes").then(r => r.json()),
    staleTime: 120_000,
  });

  const quoteMap = useMemo(() => {
    const m = new Map<string, number>();
    const list: any[] = Array.isArray(quotesRaw) ? quotesRaw : (quotesRaw?.quotes ?? []);
    for (const q of list) {
      if (q.symbol && q.price != null) m.set(q.symbol.toUpperCase(), q.price);
    }
    return m;
  }, [quotesRaw]);

  // Build holdings map: symbol -> unrealizedGainPct
  const holdingsPnlMap = useMemo(() => {
    const holdings: any[] = Array.isArray(portfolio) ? portfolio : (portfolio?.holdings ?? []);
    const m = new Map<string, number | null>();
    for (const h of holdings) {
      if (h.market !== "US" || (h.shares ?? 0) <= 0.0001) continue;
      const sym = (h.symbol ?? "").toUpperCase();
      const cur = quoteMap.get(sym) ?? null;
      const avg = h.avgCost ?? 0;
      const pct = cur != null && avg > 0 ? ((cur - avg) / avg) * 100 : null;
      m.set(sym, pct);
    }
    return m;
  }, [portfolio, quoteMap]);

  if (!data || data.length === 0) {
    return (
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[#1cb8be]" />
            板塊輪動熱力表
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">板塊 ETF 資料尚未同步</p>
        </CardContent>
      </Card>
    );
  }

  const sorted1m = [...data].filter(d => d.ret1m !== null).sort((a, b) => (b.ret1m ?? 0) - (a.ret1m ?? 0));
  const flowMap = new Map<string, { label: string; cls: string }>();
  sorted1m.forEach((d, i) => {
    if (i < 3) flowMap.set(d.symbol, { label: "↑↑ 強流入", cls: "text-gain" });
    else if (i < 6) flowMap.set(d.symbol, { label: "↑ 流入", cls: "text-gain opacity-70" });
    else if (i < 9) flowMap.set(d.symbol, { label: "→ 持平", cls: "text-muted-foreground" });
    else flowMap.set(d.symbol, { label: "↓ 流出", cls: "text-loss" });
  });

  const retCell = (val: number | null) => {
    if (val === null) return <span className="text-muted-foreground">-</span>;
    const cls = val > 0 ? "text-gain" : val < 0 ? "text-loss" : "text-muted-foreground";
    return <span className={cn("tabular-nums", cls)}>{val.toFixed(2)}%</span>;
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-[#1cb8be]" />
          板塊輪動熱力表
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-1 font-medium text-muted-foreground">板塊</th>
                <th className="text-left py-2 px-2 font-medium text-muted-foreground">持倉</th>
                <th className="text-right py-2 px-2 font-medium text-muted-foreground">1週</th>
                <th className="text-right py-2 px-2 font-medium text-muted-foreground">1月</th>
                <th className="text-right py-2 px-2 font-medium text-muted-foreground">3月</th>
                <th className="text-right py-2 pl-2 font-medium text-muted-foreground">資金流向</th>
              </tr>
            </thead>
            <tbody>
              {data.map((etf: any) => {
                const flow = flowMap.get(etf.symbol);
                const etfHoldings: { sym: string; pct: number | null }[] = [];
                for (const [sym, pct] of holdingsPnlMap.entries()) {
                  if (STOCK_SECTOR_MAP[sym] === etf.symbol) {
                    etfHoldings.push({ sym, pct });
                  }
                }
                return (
                  <tr key={etf.symbol} className="border-b border-border/50 hover:bg-muted/30 align-top">
                    {/* 板塊欄 */}
                    <td className="py-2 pr-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium">{etf.symbol}</span>
                        <span className="text-muted-foreground">{etf.name}</span>
                        <Badge variant="outline" className="text-[10px] py-0 px-1 h-4">{etf.theme}</Badge>
                      </div>
                    </td>
                    {/* 持倉欄（縮排個股） */}
                    <td className="py-2 px-2">
                      {etfHoldings.length === 0 ? (
                        <span className="text-muted-foreground text-xs">-</span>
                      ) : (
                        <div className="space-y-0.5">
                          {etfHoldings.map(h => (
                            <div key={h.sym} className="flex items-center gap-2 pl-2">
                              <span className="text-xs text-muted-foreground w-10">{h.sym}</span>
                              {h.pct != null ? (
                                <span className={cn("text-xs tabular-nums font-medium", h.pct >= 0 ? "text-gain" : "text-loss")}>
                                  {h.pct.toFixed(1)}%
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">-</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="text-right py-2 px-2">{retCell(etf.ret1w)}</td>
                    <td className="text-right py-2 px-2">{retCell(etf.ret1m)}</td>
                    <td className="text-right py-2 px-2">{retCell(etf.ret3m)}</td>
                    <td className="text-right py-2 pl-2">
                      {flow ? <span className={flow.cls}>{flow.label}</span> : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Sentiment Module ───────────────────────────────────────────────────────

function SentimentSection({ data }: { data: any }) {
  if (!data) {
    return (
      <Card className="border-border h-full">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#1cb8be]" />
            市場情緒
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">情緒指標資料不足</p>
        </CardContent>
      </Card>
    );
  }

  const fgValue = data.fearGreed?.value ?? null;
  const fgLabel = data.fearGreed?.label ?? "";

  const fgColor = (() => {
    if (fgValue === null) return "text-muted-foreground";
    if (fgValue <= 25) return "text-red-600";
    if (fgValue <= 45) return "text-red-400";
    if (fgValue <= 55) return "text-muted-foreground";
    if (fgValue <= 75) return "text-green-400";
    return "text-green-600";
  })();

  const macroScore = data.macro?.score != null ? Math.round(data.macro.score * 100) : null;
  const vixHistory = data.vix?.history?.slice(-20) ?? [];
  const tenYHistory = data.tenYear?.history?.slice(-20) ?? [];

  const normalizedFG = fgValue != null ? fgValue : 50;
  const normalizedVix = data.vix?.current != null ? Math.max(0, 100 - data.vix.current * 2) : 50;
  const normalizedMacro = macroScore != null ? macroScore : 50;
  const tenYCurrent = data.tenYear?.current ?? null;
  const normalizedTenY = tenYCurrent != null ? Math.max(0, Math.min(100, 50 + (4.5 - tenYCurrent) * 15)) : null;
  const compositeInputs = [normalizedFG, normalizedVix, normalizedMacro, ...(normalizedTenY != null ? [normalizedTenY] : [])];
  const composite = Math.round(compositeInputs.reduce((a, b) => a + b, 0) / compositeInputs.length);
  const compositeLabel = composite >= 70 ? "偏樂觀" : composite >= 55 ? "中性偏多" : composite >= 45 ? "中性" : composite >= 30 ? "中性偏空" : "偏悲觀";
  const compositeColor = composite >= 70 ? "text-gain" : composite >= 55 ? "text-gain opacity-80" : composite >= 45 ? "text-muted-foreground" : composite >= 30 ? "text-loss opacity-80" : "text-loss";

  return (
    <Card className="border-border h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#1cb8be]" />
          市場情緒
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3 space-y-2">
        {/* 上方大卡：情緒總分 */}
        <div className="rounded-md border border-border px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground mb-0.5">情緒總分</div>
            <div className={cn("text-4xl font-bold tabular-nums leading-none", compositeColor)}>{composite}</div>
          </div>
          <Badge variant="outline" className={cn("text-sm px-3 py-1", compositeColor)}>{compositeLabel}</Badge>
        </div>

        {/* 下方 4 小卡 */}
        <div className="grid grid-cols-4 gap-2">
          {/* Fear & Greed */}
          <div className="rounded-md border border-border px-3 py-2 flex flex-col justify-center text-center">
            <div className="text-[11px] text-muted-foreground mb-1">Fear & Greed</div>
            <div className={cn("text-xl font-bold tabular-nums leading-none", fgColor)}>{fgValue ?? "-"}</div>
            <div className={cn("text-[10px] mt-1", fgColor)}>{fgLabel || "-"}</div>
          </div>

          {/* Macro */}
          <div className="rounded-md border border-border px-3 py-2 flex flex-col justify-center text-center">
            <div className="text-[11px] text-muted-foreground mb-1">Macro 情緒</div>
            <div className="text-xl font-bold tabular-nums leading-none">{macroScore ?? "-"}</div>
            <div className="text-[10px] mt-1 text-muted-foreground">{data.macro?.date?.slice(5) ?? ""}</div>
          </div>

          {/* VIX */}
          <div className="rounded-md border border-border px-2 py-2">
            <div className="text-[11px] text-muted-foreground mb-1">VIX&nbsp;{data.vix?.current?.toFixed(1) ?? "-"}</div>
            {vixHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height={44}>
                <LineChart data={vixHistory}>
                  <Line dataKey="value" stroke="#ef4444" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[44px] flex items-center justify-center text-[10px] text-muted-foreground">-</div>
            )}
          </div>

          {/* 10Y */}
          <div className="rounded-md border border-border px-2 py-2">
            <div className="text-[11px] text-muted-foreground mb-1">10Y&nbsp;{tenYCurrent != null ? `${tenYCurrent.toFixed(2)}%` : "-"}</div>
            {tenYHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height={44}>
                <LineChart data={tenYHistory}>
                  <Line dataKey="value" stroke="#66c6df" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[44px] flex items-center justify-center text-[10px] text-muted-foreground">尚未同步</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Exposure Analysis Module ───────────────────────────────────────────────

function ExposureSection({ sectors }: { sectors: any[] | undefined }) {
  const { data: portfolio } = useQuery({
    queryKey: ["/api/portfolio/computed"],
    queryFn: () => fetch("/api/portfolio/computed").then(r => r.json()),
    staleTime: 120_000,
  });

  const { data: quotesRaw } = useQuery({
    queryKey: ["/api/quotes"],
    queryFn: () => fetch("/api/quotes").then(r => r.json()),
    staleTime: 120_000,
  });

  // quotes can be { quotes: [...], indices: {...} } or a flat list
  const quoteMap = useMemo(() => {
    const m = new Map<string, number>();
    const list: any[] = Array.isArray(quotesRaw)
      ? quotesRaw
      : (quotesRaw?.quotes ?? []);
    for (const q of list) {
      if (q.symbol && q.price != null) m.set(q.symbol.toUpperCase(), q.price);
    }
    return m;
  }, [quotesRaw]);

  const sectorRetMap = useMemo(() => {
    const m = new Map<string, number>();
    if (sectors) {
      for (const s of sectors) {
        if (s.ret1m != null) m.set(s.symbol, s.ret1m);
      }
    }
    return m;
  }, [sectors]);

  // portfolio/computed returns array directly
  const holdings: any[] = useMemo(() => {
    if (!portfolio) return [];
    return Array.isArray(portfolio) ? portfolio : (portfolio.holdings ?? []);
  }, [portfolio]);

  // Filter to currently held US stocks (shares > 0)
  const activeHoldings = useMemo(() =>
    holdings.filter(h => h.market === "US" && (h.shares ?? 0) > 0.0001),
    [holdings]
  );

  // Calculate unrealizedGainPct from current price vs avgCost
  const holdingsWithPnl = useMemo(() => {
    return activeHoldings.map(h => {
      const sym = (h.symbol ?? "").toUpperCase();
      const currentPrice = quoteMap.get(sym) ?? null;
      const avgCost = h.avgCost ?? 0;
      const unrealizedGainPct = (currentPrice != null && avgCost > 0)
        ? ((currentPrice - avgCost) / avgCost) * 100
        : null;
      return { ...h, currentPrice, unrealizedGainPct };
    });
  }, [activeHoldings, quoteMap]);

  // Group by sector
  const grouped = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const h of holdingsWithPnl) {
      const sym = h.symbol?.toUpperCase?.() ?? "";
      const sector = STOCK_SECTOR_MAP[sym] ?? "其他";
      if (!groups.has(sector)) groups.set(sector, []);
      groups.get(sector)!.push(h);
    }
    return groups;
  }, [holdingsWithPnl]);

  // Simple portfolio beta: weight each stock by sector ETF beta vs SPY
  // SPY ret1m as base; use sector ETF 1m return vs SPY 1m return as proxy beta
  const spyRet1m = sectorRetMap.get("SPY") ?? null;
  const betaRows = useMemo(() => {
    if (!spyRet1m || spyRet1m === 0) return [];
    const rows: Array<{ sym: string; beta: number }> = [];
    for (const h of holdingsWithPnl) {
      const sym = h.symbol?.toUpperCase?.() ?? "";
      const etf = STOCK_SECTOR_MAP[sym];
      if (!etf) continue;
      const etfRet = sectorRetMap.get(etf);
      if (etfRet == null) continue;
      rows.push({ sym, beta: etfRet / spyRet1m });
    }
    return rows;
  }, [holdingsWithPnl, sectorRetMap, spyRet1m]);

  const totalBeta = betaRows.length > 0
    ? betaRows.reduce((s, r) => s + r.beta, 0) / betaRows.length
    : null;
  const betaCount = betaRows.length;

  if (activeHoldings.length === 0) {
    return (
      <Card className="border-border h-full">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-[#1cb8be]" />
            持倉曝險分析
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">尚無持倉資料</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-[#1cb8be]" />
          持倉曝險分析
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Beta */}
        {totalBeta != null && (
          <div className="mb-4 p-3 rounded-md border border-border flex items-center justify-between">
            <span className="text-xs text-muted-foreground">投組 Beta（n={betaCount}）</span>
            <span className={cn("text-lg font-bold tabular-nums",
              totalBeta > 1.3 ? "text-orange-400" : totalBeta < 0.7 ? "text-blue-400" : "text-muted-foreground"
            )}>
              {totalBeta.toFixed(2)}
            </span>
          </div>
        )}

        <div className="space-y-3">
          {Array.from(grouped.entries()).map(([sector, sectorHoldings]) => {
            const sectorRet = sectorRetMap.get(sector);
            return (
              <div key={sector} className="rounded-md border border-border/50 p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium">{sector}</span>
                  {sectorRet != null && (
                    <span className={cn("text-xs tabular-nums",
                      sectorRet > 0 ? "text-gain" : "text-loss"
                    )}>
                      ETF 1M: {sectorRet.toFixed(2)}%
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {sectorHoldings.map((h: any) => {
                    const unrealizedPct = h.unrealizedGainPct ?? 0;
                    const isHighRisk = sectorRet != null && sectorRet < -5 && unrealizedPct < 0;
                    return (
                      <div key={h.symbol} className="flex items-center justify-between text-xs">
                        <span>{h.symbol}</span>
                        <div className="flex items-center gap-2">
                          <span className={cn("tabular-nums",
                            unrealizedPct >= 0 ? "text-gain" : "text-loss"
                          )}>
                            {unrealizedPct.toFixed(2)}%
                          </span>
                          {isHighRisk && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1 h-4 text-gain border-gain/30">
                              高風險
                            </Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function MarketTrend() {
  const { data: marketData, isLoading } = useQuery({
    queryKey: ["/api/market-trend"],
    queryFn: () => fetch("/api/market-trend").then(r => r.json()),
    staleTime: 120_000,
  });

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Globe className="w-5 h-5 text-[#1cb8be]" />
            大盤趨勢分析
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            四大指數 · 趨勢判斷 · 崩盤風險 · 板塊輪動 · 持倉曝險
          </p>
        </div>
        <OptimizeButton />
      </div>

      {/* Crash Risk — full-width above index charts */}
      {isLoading ? (
        <Card className="border-border"><CardContent className="p-4"><Skeleton className="h-[100px] w-full" /></CardContent></Card>
      ) : (
        <CrashRiskSection data={marketData?.crashRisk} />
      )}

      {/* Module 1: Index Charts */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">四大指數 K 線 + ML 預測</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {INDEX_LIST.map(idx => (
            <IndexChart key={idx.symbol} {...idx} />
          ))}
        </div>
      </div>

      {/* Module 2: Trend Analysis */}
      {isLoading ? (
        <Card className="border-border">
          <CardContent className="p-4">
            <Skeleton className="h-[200px] w-full" />
          </CardContent>
        </Card>
      ) : (
        <TrendAnalysisSection data={marketData?.trendAnalysis} />
      )}



      {/* Module 4: Sector Heatmap with embedded holdings */}
      {isLoading ? (
        <Card className="border-border">
          <CardContent className="p-4">
            <Skeleton className="h-[300px] w-full" />
          </CardContent>
        </Card>
      ) : (
        <SectorHeatmapSection data={marketData?.sectors} />
      )}
    </div>
  );
}
