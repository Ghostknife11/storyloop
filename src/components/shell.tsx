"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "@/components/theme-provider";
import { fetchProjectVersion } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FlaskConical,
  Info,
  PenLine,
  Settings,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Menu,
  Moon,
  Sun,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Generate", description: "故事生成", icon: PenLine },
  // v1.7.0：受控实验入口。只暴露「建 / 跑 / 看分组均值」三件事，
  // 不做排名、不做自动调参，所以导航里也没有「跑分」这类字眼
  { href: "/experiments", label: "Experiments", description: "受控实验", icon: FlaskConical },
  { href: "/settings", label: "Settings", description: "模型与参数", icon: Settings },
  { href: "/about", label: "About", description: "版本与许可", icon: Info },
];

/**
 * v0.0.1 应用外壳 —— 复用当前最新版 UI 设计语言（TASK §3/§5）。
 * 导航只暴露本版本真实具备的能力（§33 方案 A：其余入口直接不出现）。
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // §43：初值不写死版本号，取到 /api/version 再显示
  const [version, setVersion] = useState("");
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    fetchProjectVersion().then((v) => setVersion(`v${v}`)).catch(() => setVersion(""));
  }, []);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        className={cn(
          "flex flex-col transition-all duration-300 ease-out",
          "fixed md:relative z-50 h-full md:h-[calc(100dvh-16px)]",
          "max-md:w-64 max-md:left-0",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          collapsed ? "md:w-[72px]" : "md:w-60",
          "md:rounded-r-3xl md:my-2 md:ml-2",
          "bg-card/80 glass-strong border border-border shadow-medium overflow-hidden",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:pt-0 md:pb-0",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-[2px] w-full bg-gradient-neon shrink-0" />

        <div className="flex items-center justify-between h-[64px] px-3 shrink-0">
          {!collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-card border border-violet-500/20 shadow-soft flex items-center justify-center shrink-0">
                <Sparkles className="h-5 w-5 text-violet-600" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-[13px] tracking-tight leading-none">Storyloop</div>
                <div className="text-[10px] tracking-[0.14em] uppercase text-muted-foreground font-medium">AI STORY GENERATOR</div>
              </div>
            </div>
          ) : (
            <div className="h-9 w-9 rounded-xl bg-card border border-violet-500/20 shadow-soft flex items-center justify-center mx-auto">
              <Sparkles className="h-5 w-5 text-violet-600" />
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-full hover:bg-accent hidden md:flex"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        <ScrollArea className="flex-1 py-2">
          <nav className="space-y-1 px-2.5">
            {NAV.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;
              return collapsed ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center justify-center h-10 w-10 mx-auto rounded-xl transition-all duration-200",
                    isActive
                      ? "bg-violet-600 text-white shadow-glow border border-violet-600"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground hover:-translate-y-0.5",
                  )}
                  title={item.label}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </Link>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] transition-all duration-200",
                    isActive
                      ? "bg-violet-600 text-white shadow-glow font-medium border border-violet-600"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground hover:translate-x-0.5",
                  )}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  <div className="flex flex-col min-w-0">
                    <span className="leading-none">{item.label}</span>
                    <span className="text-[11px] opacity-70 leading-none mt-0.5">{item.description}</span>
                  </div>
                </Link>
              );
            })}
          </nav>
        </ScrollArea>

        <div className="p-3 space-y-2 shrink-0">
          <button
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className="w-full flex items-center justify-center gap-2 h-9 rounded-full border border-border bg-card/50 backdrop-blur text-xs font-medium hover:bg-accent transition-colors"
            aria-label="切换主题"
          >
            {!mounted ? <Sun className="h-4 w-4" /> : resolvedTheme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            {!collapsed && <span>{!mounted ? "浅色" : resolvedTheme === "dark" ? "深色模式" : "浅色模式"}</span>}
          </button>
          {!collapsed && (
            <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="kbd">{version}</span>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col min-w-0 bg-transparent">
        <div className="md:hidden flex items-center gap-2 h-12 px-3 border-b border-border bg-card/60 glass shrink-0 pt-[env(safe-area-inset-top)]">
          <button onClick={() => setMobileOpen(true)} className="h-8 w-8 grid place-items-center rounded-full bg-card border shadow-sm shrink-0" aria-label="打开菜单">
            <Menu className="h-4 w-4" />
          </button>
          <span className="text-xs sm:text-sm font-bold tracking-tight flex items-center gap-2 min-w-0">
            <span className="h-6 w-6 rounded-lg bg-gradient-neon grid place-items-center shrink-0"><Sparkles className="h-3.5 w-3.5 text-white" /></span>
            <span className="truncate">Storyloop</span>
          </span>
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-600 hidden sm:inline-flex">{version}</span>
        </div>
        <div className="flex-1 overflow-hidden p-2 sm:p-3 md:p-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pb-4">
          <div className="h-full overflow-hidden rounded-2xl sm:rounded-3xl border border-border bg-card/40 glass shadow-soft flex flex-col min-w-0">
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}
