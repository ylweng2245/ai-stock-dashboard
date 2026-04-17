import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { navigate as wouter_navigate } from "wouter/use-hash-location";

// ─── Types ────────────────────────────────────────────────────────────────────
export type Market = "TW" | "US";

interface ActiveSymbolState {
  activeMarket: Market;
  activeSymbol: string;
  setActive: (symbol: string, market: Market) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────
const ActiveSymbolContext = createContext<ActiveSymbolState | null>(null);

// ─── Helper: read query params from URL search (works with wouter hash routing)
// wouter puts query params in window.location.search (before #), NOT inside the hash
function readSearchQuery(): { market: Market | null; symbol: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const market = params.get("market") as Market | null;
    const symbol = params.get("symbol");
    return { market: market === "TW" || market === "US" ? market : null, symbol };
  } catch {
    return { market: null, symbol: null };
  }
}

// Get current hash path without query (e.g. "/analysis")
function getCurrentHashPath(): string {
  const hash = window.location.hash;
  // strip leading # and optional /
  const withoutHash = hash.replace(/^#?\/?/, "");
  // strip query portion if any (shouldn't be there with wouter, but just in case)
  const path = withoutHash.split("?")[0];
  return "/" + path;
}

function writeQuery(symbol: string, market: Market) {
  try {
    // Use wouter's navigate to properly set ?search on the URL
    // This puts params in window.location.search (before #), not inside hash
    const currentPath = getCurrentHashPath();
    wouter_navigate(`${currentPath}?market=${market}&symbol=${encodeURIComponent(symbol)}`, { replace: true });
  } catch {
    // Ignore errors in sandboxed environments
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────
interface Props {
  children: ReactNode;
  defaultSymbol?: string;
  defaultMarket?: Market;
}

export function ActiveSymbolProvider({
  children,
  defaultSymbol = "2330",
  defaultMarket = "TW",
}: Props) {
  // Read URL params on first mount
  const initialFromURL = readSearchQuery();

  const [activeSymbol, setActiveSymbol] = useState<string>(
    initialFromURL.symbol ?? defaultSymbol
  );
  const [activeMarket, setActiveMarket] = useState<Market>(
    initialFromURL.market ?? defaultMarket
  );

  // Keep URL in sync whenever active symbol/market changes
  useEffect(() => {
    writeQuery(activeSymbol, activeMarket);
  }, [activeSymbol, activeMarket]);

  // Listen for browser back/forward navigation to update context
  useEffect(() => {
    const onNavChange = () => {
      const { symbol, market } = readSearchQuery();
      if (symbol) setActiveSymbol(symbol);
      if (market) setActiveMarket(market);
    };
    window.addEventListener("popstate", onNavChange);
    window.addEventListener("hashchange", onNavChange);
    return () => {
      window.removeEventListener("popstate", onNavChange);
      window.removeEventListener("hashchange", onNavChange);
    };
  }, []);

  const setActive = useCallback((symbol: string, market: Market) => {
    setActiveSymbol(symbol);
    setActiveMarket(market);
  }, []);

  return (
    <ActiveSymbolContext.Provider value={{ activeSymbol, activeMarket, setActive }}>
      {children}
    </ActiveSymbolContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useActiveSymbol(): ActiveSymbolState {
  const ctx = useContext(ActiveSymbolContext);
  if (!ctx) {
    throw new Error("useActiveSymbol must be used inside <ActiveSymbolProvider>");
  }
  return ctx;
}
