import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Check, RefreshCw } from "lucide-react";

export function OptimizeButton() {
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [lastOptDate, setLastOptDate] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/predictions/optimize-status")
      .then(r => r.json())
      .then(d => { if (d.lastOptimizedAt) setLastOptDate(d.lastOptimizedAt); })
      .catch(() => {});
  }, []);

  const handleOptimize = async () => {
    if (status === "running") return;
    setStatus("running");
    setProgress({ current: 0, total: 0, label: "初始化..." });

    try {
      const response = await fetch("/api/predictions/optimize", { method: "POST" });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === "start") {
              setProgress({ current: 0, total: evt.total, label: "開始優化..." });
            } else if (evt.type === "progress") {
              setProgress({ current: evt.index, total: evt.total, label: `${evt.symbol} (${evt.index}/${evt.total})` });
            } else if (evt.type === "done") {
              setLastOptDate(evt.optimizedAt);
              setStatus("done");
              setProgress(null);
              setTimeout(() => setStatus("idle"), 3000);
            }
          } catch { /* ignore */ }
        }
      }
    } catch {
      setStatus("idle");
      setProgress(null);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 text-xs h-8"
      onClick={handleOptimize}
      disabled={status === "running"}
    >
      {status === "running" ? (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {progress ? `${progress.label}` : "優化中..."}
        </>
      ) : status === "done" ? (
        <>
          <Check className="w-3.5 h-3.5 text-gain" />
          優化完成
        </>
      ) : (
        <>
          <RefreshCw className="w-3.5 h-3.5" />
          模型參數優化 {lastOptDate ? `(${lastOptDate})` : ""}
        </>
      )}
    </Button>
  );
}
