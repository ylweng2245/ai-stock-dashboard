import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Send, Loader2, MessageSquare, TrendingUp, Shield, Zap } from "lucide-react";
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
}

const quickPrompts = [
  { label: "投資摘要", icon: TrendingUp, prompt: "請提供這檔股票的完整投資摘要，包含基本面分析、技術面觀察、產業前景與風險因子。" },
  { label: "風險評估", icon: Shield, prompt: "分析這檔股票目前的主要風險因子，包含估值風險、產業風險、地緣政治風險與流動性風險。" },
  { label: "買進時機", icon: Zap, prompt: "根據目前的技術指標和市場環境，分析這檔股票的最佳買進區間和分批策略建議。" },
];

export default function AIInsights() {
  // ─── Global symbol state (v3) ──────────────────────────────────────────────
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

  // Fetch live watchlist for meta
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

  const handleSend = async (prompt?: string) => {
    const text = prompt || inputValue;
    if (!text.trim() || isLoading) return;

    const userMsg = `[${activeSymbol} ${meta.name}] ${text}`;
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
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
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
    } catch {
      const fallback = `抱歉，AI 服務暫時無法連接。請稍後再試，或確認網路連線。\n\n股票：${activeSymbol} ${meta.name}\n目前價格：${currentPrice ? (meta.market === "TW" ? "NT" : "$") + currentPrice.toLocaleString() : "載入中..."}`;
      setMessages((prev) => [...prev, { role: "assistant", content: fallback }]);
    }

    setIsLoading(false);
  };

  return (
    <div className="p-6 space-y-4" data-testid="insights-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI 智慧洞察</h1>
          <p className="text-sm text-muted-foreground mt-0.5">LLM 驅動的股票分析助手</p>
        </div>
        {/* Mobile: symbol picker trigger */}
        <AnalysisSymbolSidebarMobile />
      </div>

      {/* Quick Actions */}
      <div className="flex gap-2">
        {quickPrompts.map((qp) => (
          <Button
            key={qp.label}
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => handleSend(qp.prompt)}
            disabled={isLoading}
            data-testid={`quick-${qp.label}`}
          >
            <qp.icon className="w-3.5 h-3.5" />
            {qp.label}
          </Button>
        ))}
      </div>

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
            <Badge variant="outline" className="text-[10px] ml-auto">Claude</Badge>
          </div>
        </CardHeader>

        <CardContent className="flex-1 p-4 overflow-y-auto space-y-4" data-testid="chat-messages">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <MessageSquare className="w-6 h-6 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">選擇上方的快速分析，或輸入您的問題</p>
              <p className="text-xs text-muted-foreground mt-1">AI 將針對 {meta.name} 進行分析</p>
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
                  "max-w-[85%] rounded-lg px-4 py-3 text-sm",
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
                <span className="text-muted-foreground">AI 分析中...</span>
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
                  handleSend();
                }
              }}
              data-testid="chat-input"
            />
            <Button
              onClick={() => handleSend()}
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
