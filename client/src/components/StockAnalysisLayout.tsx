import type { ReactNode } from "react";
import { AnalysisSymbolSidebarDesktop } from "./AnalysisSymbolSidebar";
import type { WatchlistItem } from "./AnalysisSymbolSidebar";

interface StockAnalysisLayoutProps {
  children: ReactNode;
  symbolFilter?: (item: WatchlistItem) => boolean;
}

/**
 * Two-column layout used by the analysis pages:
 * - Left: main content (flex-1, scrollable)
 * - Right: 210px fixed symbol sidebar (desktop only; mobile uses Sheet drawer inside header)
 * symbolFilter: optional filter for the sidebar (e.g. exclude ETFs on fundamental analysis page)
 */
export default function StockAnalysisLayout({ children, symbolFilter }: StockAnalysisLayoutProps) {
  return (
    <div className="flex h-full w-full overflow-hidden" data-testid="stock-analysis-layout">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {children}
      </div>

      {/* Desktop right sidebar */}
      <AnalysisSymbolSidebarDesktop symbolFilter={symbolFilter} />
    </div>
  );
}
