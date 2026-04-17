import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/themeProvider";
import AppLayout from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import TechnicalAnalysis from "@/pages/TechnicalAnalysis";
import MLPrediction from "@/pages/MLPrediction";
import AIInsights from "@/pages/AIInsights";
import Portfolio from "@/pages/Portfolio";
import Alerts from "@/pages/Alerts";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/analysis" component={TechnicalAnalysis} />
        <Route path="/prediction" component={MLPrediction} />
        <Route path="/insights" component={AIInsights} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/alerts" component={Alerts} />
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
            <AppRouter />
          </Router>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
