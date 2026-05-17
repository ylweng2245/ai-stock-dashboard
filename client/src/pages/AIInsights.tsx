import { useState, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles, Copy, Check, Loader2,
  TrendingUp, TrendingDown, Newspaper, BarChart3,
  ShieldAlert, RefreshCw, DollarSign, AlertTriangle,
  Globe, Activity, ExternalLink,
} from "lucide-react";
import { STOCK_META, type StockQuote } from "@/lib/stockData";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useActiveSymbol } from "@/context/ActiveSymbolContext";
import { AnalysisSymbolSidebarMobile } from "@/components/AnalysisSymbolSidebar";

interface WatchlistItem {
  id: number;
  symbol: string;
  name: string;
  market: "TW" | "US";
  sortOrder: number;
}

interface QuotesResponse {
  quotes: StockQuote[];
}

interface QuickPrompt {
  label: string;
  icon: React.ElementType;
  questionType: string;
  color: string;
}

// ─── 一鍵提問定義 ──────────────────────────────────────────────────────────────

const TRADE_PROMPTS: QuickPrompt[] = [
  { label: "該進場嗎？",   icon: TrendingUp,    questionType: "trade_enter",    color: "text-gain" },
  { label: "該獲利了結？", icon: DollarSign,    questionType: "trade_profit",   color: "text-gain" },
  { label: "該低接嗎？",   icon: TrendingDown,  questionType: "trade_dip",      color: "text-loss" },
  { label: "該攤平嗎？",   icon: RefreshCw,     questionType: "trade_average",  color: "text-loss" },
  { label: "該停損嗎？",   icon: ShieldAlert,   questionType: "trade_stoploss", color: "text-loss" },
  { label: "估值溢價？",   icon: AlertTriangle, questionType: "trade_valuation",color: "text-muted-foreground" },
];

const NEWS_PROMPTS: QuickPrompt[] = [
  { label: "消息多空判斷", icon: Newspaper,     questionType: "news",             color: "text-[#1cb8be]" },
  { label: "基本面影響？", icon: BarChart3,     questionType: "news_fundamental", color: "text-[#1cb8be]" },
  { label: "財報前後策略", icon: Activity,      questionType: "news_earnings",    color: "text-[#1cb8be]" },
  { label: "個股風險預警", icon: AlertTriangle, questionType: "news_risk",        color: "text-[#1cb8be]" },
];

const MACRO_PROMPTS: QuickPrompt[] = [
  { label: "大盤趨勢分析", icon: Globe,       questionType: "macro",          color: "text-purple-400" },
  { label: "崩盤預警",     icon: ShieldAlert, questionType: "macro_crash",    color: "text-purple-400" },
  { label: "板塊輪動分析", icon: RefreshCw,   questionType: "macro_rotation", color: "text-purple-400" },
];

// ─── Component ──────────────────────────────────────────────────────────────

export default function AIInsights() {
  const { activeSymbol, activeMarket } = useActiveSymbol();

  const [generatedPrompt, setGeneratedPrompt] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [customQuestion, setCustomQuestion] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Reset when symbol changes
  const [lastSymbol, setLastSymbol] = useState(activeSymbol);
  if (activeSymbol !== lastSymbol) {
    setLastSymbol(activeSymbol);
    setGeneratedPrompt("");
    setCustomQuestion("");
  }

  const { data: watchlist } = useQuery<WatchlistItem[]>({
    queryKey: ["/api/watchlist"],
    queryFn: () => apiRequest("GET", "/api/watchlist").then((r) => r.json()),
    staleTime: 30_000,
  });

  const meta = useMemo(() => {
    const wItem = watchlist?.find((w) => w.symbol === activeSymbol);
    if (wItem) return { name: wItem.name, market: wItem.market };
    return STOCK_META[activeSymbol] ?? { name: activeSymbol, market: activeMarket };
  }, [watchlist, activeSymbol, activeMarket]);

  const { data: quotesData } = useQuery<QuotesResponse>({
    queryKey: ["/api/quotes"],
    queryFn: () => apiRequest("GET", "/api/quotes").then((r) => r.json()),
    staleTime: 55_000,
  });
  const liveQuote = quotesData?.quotes.find((q) => q.symbol === activeSymbol);
  const currentPrice = liveQuote?.price ?? 0;
  const currentChange = liveQuote?.changePercent ?? 0;

  const handleBuildPrompt = async (questionType: string, customQ?: string) => {
    if (isLoading) return;
    setIsLoading(true);
    setCopied(false);
    try {
      const res = await apiRequest("POST", "/api/ai/build-prompt", {
        symbol: activeSymbol,
        name: meta.name,
        price: currentPrice,
        change: currentChange,
        market: meta.market,
        questionType,
        customQuestion: customQ || undefined,
      });
      const data = await res.json();
      setGeneratedPrompt(data.prompt ?? "");
      // Scroll to prompt area
      setTimeout(() => promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    } catch {
      setGeneratedPrompt("無法產生提問詞，請稍後再試。");
    }
    setIsLoading(false);
  };

  const handleCopy = async () => {
    if (!generatedPrompt) return;
    await navigator.clipboard.writeText(generatedPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Prompt Group ──────────────────────────────────────────────────────────

  function PromptGroup({
    title, prompts, badge, badgeClass,
  }: {
    title: string; prompts: QuickPrompt[]; badge: string; badgeClass: string;
  }) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">{title}</span>
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border font-medium", badgeClass)}>
            {badge}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {prompts.map((qp) => (
            <Button
              key={qp.label}
              variant="outline"
              size="sm"
              className={cn("gap-1.5 text-xs h-7 px-2.5", qp.color)}
              onClick={() => handleBuildPrompt(qp.questionType)}
              disabled={isLoading}
            >
              <qp.icon className="w-3 h-3" />
              {qp.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4" data-testid="insights-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI 智慧提問</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            產生整合 Dashboard 數據的完整提問詞，貼到 Perplexity 免費取得即時分析
          </p>
        </div>
        <AnalysisSymbolSidebarMobile />
      </div>

      {/* Stock badge */}
      {liveQuote && (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="outline" className="text-xs font-mono">{activeSymbol}</Badge>
          <span className="text-muted-foreground">{meta.name}</span>
          <span className={cn("font-medium", liveQuote.changePercent >= 0 ? "text-gain" : "text-loss")}>
            {meta.market === "TW" ? "NT" : "$"}{liveQuote.price.toLocaleString()}
            {" "}{liveQuote.changePercent.toFixed(2)}%
          </span>
        </div>
      )}

      {/* Quick Actions — 三分類 */}
      <Card className="border-border p-3 space-y-3">
        <PromptGroup
          title="買賣決策"
          prompts={TRADE_PROMPTS}
          badge="操作建議"
          badgeClass="border-border text-muted-foreground"
        />
        <div className="border-t border-border" />
        <PromptGroup
          title="消息面判斷"
          prompts={NEWS_PROMPTS}
          badge="新聞分析"
          badgeClass="border-[#1cb8be]/40 text-[#1cb8be]"
        />
        <div className="border-t border-border" />
        <PromptGroup
          title="大盤趨勢"
          prompts={MACRO_PROMPTS}
          badge="總體分析"
          badgeClass="border-purple-400/40 text-purple-400"
        />
      </Card>

      {/* Custom Question */}
      <Card className="border-border p-3">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium">自訂提問</p>
          <div className="flex gap-2">
            <Textarea
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              placeholder={`輸入關於 ${meta.name} 的問題...`}
              className="min-h-[40px] max-h-[80px] resize-none text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (customQuestion.trim()) handleBuildPrompt("default", customQuestion.trim());
                }
              }}
            />
            <Button
              onClick={() => { if (customQuestion.trim()) handleBuildPrompt("default", customQuestion.trim()); }}
              disabled={!customQuestion.trim() || isLoading}
              size="sm"
              className="shrink-0 self-start"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </Card>

      {/* Generated Prompt Output */}
      {(generatedPrompt || isLoading) && (
        <Card className="border-border" ref={promptRef as any}>
          <CardHeader className="pb-2 pt-3 px-4 border-b border-border">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                產生的提問詞
              </CardTitle>
              <div className="flex items-center gap-2">
                <a
                  href="https://www.perplexity.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                >
                  前往 Perplexity <ExternalLink className="w-3 h-3" />
                </a>
                <Button
                  size="sm"
                  variant={copied ? "default" : "outline"}
                  className="h-7 gap-1.5 text-xs"
                  onClick={handleCopy}
                  disabled={!generatedPrompt}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "已複製" : "複製"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-3">
            {isLoading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                整合 Dashboard 數據中...
              </div>
            ) : (
              <Textarea
                ref={promptRef}
                value={generatedPrompt}
                onChange={(e) => setGeneratedPrompt(e.target.value)}
                className="text-xs font-mono leading-relaxed resize-none border-0 bg-transparent focus-visible:ring-0 p-0"
                style={{ minHeight: "280px" }}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Usage hint */}
      {!generatedPrompt && !isLoading && (
        <div className="text-center py-8 text-muted-foreground">
          <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">點擊上方按鈕產生提問詞</p>
          <p className="text-xs mt-1">提問詞包含持倉、基本面、ML 預測、新聞情緒等完整數據</p>
          <p className="text-xs mt-0.5">複製後貼到 Perplexity，即可取得即時搜尋 + 整合分析</p>
        </div>
      )}
    </div>
  );
}
