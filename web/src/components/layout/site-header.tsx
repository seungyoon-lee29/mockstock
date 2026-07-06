"use client";

// 앱 전역 상단 네비게이션. 루트 layout.tsx에서 렌더 → 모든 페이지 공용 셸.
// 링크 라벨은 한국어, 포인트색은 --color-brand(시안) 토큰 경유.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { SessionWidget } from "./session-widget";

const NAV = [
  { href: "/", label: "홈" },
  { href: "/leaderboard", label: "리더보드" },
  { href: "/portfolio", label: "포트폴리오" },
  { href: "/replay", label: "리플레이" },
  { href: "/search", label: "검색" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          모의<span className="text-brand">주식</span>
        </Link>
        <nav className="ml-3 hidden items-center gap-1 text-sm sm:flex">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 transition-colors",
                  active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <SessionWidget />
        </div>
      </div>
    </header>
  );
}
