import type { ReactNode } from "react";
import { AnalysisSymbolSidebarDesktop } from "./AnalysisSymbolSidebar";

interface StockAnalysisLayoutProps {
  children: ReactNode;
}

/**
 * Two-column layout used by the three analysis pages:
 * - Left: main content (flex-1, scrollable)
 * - Right: 280px fixed symbol sidebar (desktop only; mobile uses Sheet drawer inside header)
 */
export default function StockAnalysisLayout({ children }: StockAnalysisLayoutProps) {
  return (
    <div className="flex h-full w-full overflow-hidden" data-testid="stock-analysis-layout">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto min-w-0">
        {children}
      </div>

      {/* Desktop right sidebar */}
      <AnalysisSymbolSidebarDesktop />
    </div>
  );
}
