import { Link, useLocation } from "wouter";
import { useTheme } from "@/lib/themeProvider";
import {
  LayoutDashboard,
  TrendingUp,
  Brain,
  Sparkles,
  Briefcase,
  Bell,
  Sun,
  Moon,
  Activity,
  Newspaper,
  BarChart2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "市場總覽", icon: LayoutDashboard },
  { path: "/news-digest", label: "個股每日新聞", icon: Newspaper },
  { path: "/fundamentals", label: "基本面分析", icon: BarChart2 },
  { path: "/analysis", label: "技術分析", icon: TrendingUp },
  { path: "/prediction", label: "ML 預測", icon: Brain },
  { path: "/insights", label: "AI 洞察", icon: Sparkles },
  { path: "/portfolio", label: "投資組合", icon: Briefcase },
  { path: "/alerts", label: "價格警報", icon: Bell },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-screen overflow-hidden bg-background" data-testid="app-layout">
      {/* Sidebar */}
      <aside className="w-[220px] shrink-0 border-r border-border bg-sidebar flex flex-col" data-testid="sidebar">
        {/* Logo */}
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-border">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Activity className="w-4.5 h-4.5 text-primary-foreground" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold tracking-tight text-foreground leading-none">AI 智投</span>
            <span className="text-[10px] text-muted-foreground leading-tight mt-0.5">Stock Dashboard</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = item.path === "/"
              ? location === "/"
              : location === item.path || location.startsWith(item.path + "/");
            return (
              <Link key={item.path} href={item.path}>
                <div
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                  data-testid={`nav-${item.path.replace("/", "") || "dashboard"}`}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Theme Toggle */}
        <div className="p-3 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
            data-testid="theme-toggle"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span className="text-xs">{theme === "dark" ? "淺色模式" : "深色模式"}</span>
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto" data-testid="main-content">
        {children}
      </main>
    </div>
  );
}
