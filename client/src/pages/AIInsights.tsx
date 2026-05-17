import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles, Send, Loader2, MessageSquare,
  TrendingUp, TrendingDown, Newspaper, BarChart3,
  ShieldAlert, RefreshCw, DollarSign, AlertTriangle,
  Globe, Activity,
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

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  questionType?: string;
}

// ─── 一鍵提問定義 ──────────────────────────────────────────────────────────────

interface QuickPrompt {
  label: string;
  icon: React.ElementType;
  prompt: string;
  questionType: "trade" | "news" | "macro" | "default";
  color: string; // tailwind text color class
}

const TRADE_PROMPTS: QuickPrompt[] = [
  {
    label: "該進場嗎？",
    icon: TrendingUp,
    prompt: "根據目前技術面位置、ML預測方向、分析師共識與估值水平，現在適合建立/加碼持股嗎？給出具體建議與進場區間。",
    questionType: "trade",
    color: "text-gain",
  },
  {
    label: "該獲利了結？",
    icon: DollarSign,
    prompt: "我目前持有此股，根據未實現損益、估值溢價程度、ML預測與技術面，是否應該獲利了結或部分減碼？",
    questionType: "trade",
    color: "text-gain",
  },
  {
    label: "該低接嗎？",
    icon: TrendingDown,
    prompt: "這檔股票近期下跌，根據技術面支撐、基本面健康度與ML預測，現在是低接時機還是持續觀望？",
    questionType: "trade",
    color: "text-loss",
  },
  {
    label: "該攤平嗎？",
    icon: RefreshCw,
    prompt: "我持有此股目前虧損，根據基本面趨勢、ML預測與技術支撐，是否值得攤平降低成本？風險評估為何？",
    questionType: "trade",
    color: "text-loss",
  },
  {
    label: "該停損嗎？",
    icon: ShieldAlert,
    prompt: "根據目前技術面、基本面變化與新聞情緒，是否出現停損訊號？建議停損點位在哪？",
    questionType: "trade",
    color: "text-loss",
  },
  {
    label: "估值溢價？",
    icon: AlertTriangle,
    prompt: "這檔股票目前估值是否過高？根據本益比、分析師目標價與歷史估值區間，有無泡沫化風險？",
    questionType: "trade",
    color: "text-muted-foreground",
  },
];

const NEWS_PROMPTS: QuickPrompt[] = [
  {
    label: "消息多空判斷",
    icon: Newspaper,
    prompt: "根據最新新聞標題與情緒分數，判斷目前消息面多空方向、強度，以及對短期與長期股價的影響。",
    questionType: "news",
    color: "text-[#1cb8be]",
  },
  {
    label: "基本面影響？",
    icon: BarChart3,
    prompt: "近期新聞是否有改變公司的營運基本面或技術競爭力？若有，正面還是負面影響？影響程度？",
    questionType: "news",
    color: "text-[#1cb8be]",
  },
  {
    label: "財報前後策略",
    icon: Activity,
    prompt: "根據財報日距離、歷史財報表現與目前基本面趨勢，建議財報前後的操作策略（持有/減碼/加碼）？",
    questionType: "news",
    color: "text-[#1cb8be]",
  },
  {
    label: "個股風險預警",
    icon: AlertTriangle,
    prompt: "綜合新聞情緒、基本面數據與ML預測，目前有哪些值得警惕的個股風險訊號？",
    questionType: "news",
    color: "text-[#1cb8be]",
  },
];

const MACRO_PROMPTS: QuickPrompt[] = [
  {
    label: "大盤趨勢分析",
    icon: Globe,
    prompt: "根據Fear & Greed Index、Macro情緒分數與板塊相對強弱，目前大盤環境對這檔股票是順風還是逆風？",
    questionType: "macro",
    color: "text-purple-400",
  },
  {
    label: "崩盤預警",
    icon: ShieldAlert,
    prompt: "目前大盤情緒指標與板塊走勢是否出現崩盤或重大回調的預警訊號？這檔股票的防禦性如何？",
    questionType: "macro",
    color: "text-purple-400",
  },
  {
    label: "板塊輪動分析",
    icon: RefreshCw,
    prompt: "根據板塊相對強弱數據，目前板塊輪動趨勢對這檔股票有利還是不利？資金是流入還是流出這個板塊？",
    questionType: "macro",
    color: "text-purple-400",
  },
];

// ─── Component ──────────────────────────────────────────────────────────────

export default function AIInsights() {
  const { activeSymbol, activeMarket } = useActiveSymbol();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Clear messages when symbol changes
  const [lastSymbol, setLastSymbol] = useState(activeSymbol);
  if (activeSymbol !== lastSymbol) {
    setLastSymbol(activeSymbol);
    setMessages([]);
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

  const handleSend = async (prompt?: string, questionType: string = "default") => {
    const text = prompt || inputValue;
    if (!text.trim() || isLoading) return;

    const userMsg = `[${activeSymbol} ${meta.name}] ${text}`;
    setMessages((prev) => [...prev, { role: "user", content: userMsg, questionType }]);
    setInputValue("");
    setIsLoading(true);

    try {
      const res = await apiRequest("POST", "/api/ai/chat", {
        symbol: activeSymbol,
        name: meta.name,
        price: currentPrice,
        change: currentChange,
        market: meta.market,
        question: text,
        questionType,
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.response, questionType }]);
    } catch {
      const fallback = `抱歉，AI 服務暫時無法連接。請稍後再試。\n\n股票：${activeSymbol} ${meta.name}\n目前價格：${currentPrice ? (meta.market === "TW" ? "NT" : "$") + currentPrice.toLocaleString() : "載入中..."}`;
      setMessages((prev) => [...prev, { role: "assistant", content: fallback }]);
    }

    setIsLoading(false);
  };

  // ─── Prompt Group ──────────────────────────────────────────────────────────

  function PromptGroup({
    title,
    prompts,
    badge,
    badgeClass,
  }: {
    title: string;
    prompts: QuickPrompt[];
    badge: string;
    badgeClass: string;
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
              onClick={() => handleSend(qp.prompt, qp.questionType)}
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI 智慧洞察</h1>
          <p className="text-sm text-muted-foreground mt-0.5">整合持倉、基本面、技術面、預測與新聞的 LLM 分析</p>
        </div>
        <AnalysisSymbolSidebarMobile />
      </div>

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

      {/* Chat Area */}
      <Card className="border-border flex flex-col" style={{ minHeight: "460px" }}>
        <CardHeader className="pb-2 pt-3 px-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <CardTitle className="text-sm font-semibold">
              AI 分析 — {activeSymbol} {meta.name}
              {liveQuote && (
                <span className={cn("ml-2 text-xs font-normal", liveQuote.changePercent >= 0 ? "text-gain" : "text-loss")}>
                  {meta.market === "TW" ? "NT" : "$"}{liveQuote.price.toLocaleString()}
                  {" "}{liveQuote.changePercent.toFixed(2)}%
                </span>
              )}
            </CardTitle>
            <Badge variant="outline" className="text-[10px] ml-auto">Claude · Rich Context</Badge>
          </div>
        </CardHeader>

        <CardContent className="flex-1 p-4 overflow-y-auto space-y-4" data-testid="chat-messages">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <MessageSquare className="w-6 h-6 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">選擇上方的一鍵提問，或輸入您的問題</p>
              <p className="text-xs text-muted-foreground mt-1">
                AI 會自動整合 {meta.name} 的持倉、基本面、技術面、預測與新聞數據
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-3",
                msg.role === "user" ? "justify-end" : "justify-start"
              )}
            >
              <div
                className={cn(
                  "max-w-[88%] rounded-lg px-4 py-3 text-sm",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                )}
              >
                <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-3">
              <div className="bg-muted rounded-lg px-4 py-3 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-muted-foreground">AI 整合數據分析中...</span>
              </div>
            </div>
          )}
        </CardContent>

        {/* Input */}
        <div className="p-3 border-t border-border">
          <div className="flex gap-2">
            <Textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={`詢問關於 ${meta.name} 的任何問題...`}
              className="min-h-[40px] max-h-[100px] resize-none text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(undefined, "default");
                }
              }}
              data-testid="chat-input"
            />
            <Button
              onClick={() => handleSend(undefined, "default")}
              disabled={!inputValue.trim() || isLoading}
              size="icon"
              className="shrink-0"
              data-testid="send-btn"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
