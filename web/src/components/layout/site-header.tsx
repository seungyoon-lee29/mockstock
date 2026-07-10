"use client";

// 앱 전역 상단 네비게이션. 루트 layout.tsx에서 렌더 → 모든 페이지 공용 셸.
// 링크 라벨은 한국어, 포인트색은 --color-brand(시안) 토큰 경유.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { SessionWidget } from "./session-widget";

// 리그 스코프 링크는 현재 리그(쿠키/경로) prefix. 리플레이·검색은 리그 무관 전역.
const LEAGUE_NAV = [
  { seg: "leaderboard", label: "리더보드" },
  { seg: "portfolio", label: "포트폴리오" },
  { seg: "discover", label: "발견" },
] as const;
const GLOBAL_NAV = [
  { href: "/replay", label: "리플레이" },
  { href: "/search", label: "검색" },
] as const;
const LEAGUES = [
  { id: "kr", label: "국내" },
  { id: "us", label: "해외" },
] as const;
const LEAGUE_COOKIE = "league"; // 기본 KR

/** 경로에서 현재 리그 파싱. /kr/… 또는 /us/… 이면 그 리그, 아니면 쿠키(기본 kr). */
function leagueFromPath(pathname: string): string {
  const seg = pathname.split("/")[1];
  if (seg === "kr" || seg === "us") return seg;
  // 클라이언트에서 쿠키 읽기
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LEAGUE_COOKIE}=([^;]+)`));
  return match?.[1] ?? "kr";
}

/** 경로에서 리그 이후 세그먼트 추출. /kr/discover → "discover". 없으면 null. */
function scopeSegFromPath(pathname: string): string | null {
  const parts = pathname.split("/");
  if ((parts[1] === "kr" || parts[1] === "us") && parts[2]) return parts[2];
  return null;
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function SiteHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const league = leagueFromPath(pathname);
  const scopeSeg = scopeSegFromPath(pathname);

  function switchLeague(id: string) {
    document.cookie = `${LEAGUE_COOKIE}=${id}; path=/`;
    // 리그 스코프 세그먼트 유지. 밖에서 클릭하면 discover로.
    const seg = scopeSeg ?? "discover";
    router.push(`/${id}/${seg}`);
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          모의<span className="text-brand">주식</span>
        </Link>

        {/* 리그 스위처 */}
        <div className="ml-3 inline-flex rounded-full bg-muted p-0.5 text-sm">
          {LEAGUES.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => switchLeague(id)}
              aria-pressed={league === id}
              className={cn(
                "rounded-full px-3 py-1 transition-colors",
                league === id
                  ? "bg-background font-semibold shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <nav className="ml-1 hidden items-center gap-1 text-sm sm:flex">
          {LEAGUE_NAV.map(({ seg, label }) => {
            const href = `/${league}/${seg}`;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={seg}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 transition-colors",
                  active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {label}
              </Link>
            );
          })}
          {GLOBAL_NAV.map(({ href, label }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 transition-colors",
                  active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {label}
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
