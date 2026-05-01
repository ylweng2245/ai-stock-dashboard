import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/themeProvider";
import AppLayout from "@/components/AppLayout";
import StockAnalysisLayout from "@/components/StockAnalysisLayout";
import { ActiveSymbolProvider } from "@/context/ActiveSymbolContext";
import Dashboard from "@/pages/Dashboard";
import FundamentalAnalysis, { EXCLUDED_FUNDAMENTAL_SYMBOLS } from "@/pages/FundamentalAnalysis";
import TechnicalAnalysis from "@/pages/TechnicalAnalysis";
import MLPrediction from "@/pages/MLPrediction";
import AIInsights from "@/pages/AIInsights";
import Portfolio from "@/pages/Portfolio";
import Alerts from "@/pages/Alerts";
import StockNewsDigest from "@/pages/StockNewsDigest";
import NotFound from "@/pages/not-found";
import type { WatchlistItem } from "@/components/AnalysisSymbolSidebar";

// Filter out ETF/bond symbols from the fundamental analysis sidebar
const fundamentalSymbolFilter = (item: WatchlistItem) =>
  !EXCLUDED_FUNDAMENTAL_SYMBOLS.has(item.symbol);

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/fundamentals">
          <StockAnalysisLayout symbolFilter={fundamentalSymbolFilter}>
            <FundamentalAnalysis />
          </StockAnalysisLayout>
        </Route>
        <Route path="/analysis">
          <StockAnalysisLayout>
            <TechnicalAnalysis />
          </StockAnalysisLayout>
        </Route>
        <Route path="/prediction">
          <StockAnalysisLayout>
            <MLPrediction />
          </StockAnalysisLayout>
        </Route>
        <Route path="/insights">
          <StockAnalysisLayout>
            <AIInsights />
          </StockAnalysisLayout>
        </Route>
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/news-digest" component={StockNewsDigest} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <ActiveSymbolProvider>
              <AppRouter />
            </ActiveSymbolProvider>
          </Router>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
