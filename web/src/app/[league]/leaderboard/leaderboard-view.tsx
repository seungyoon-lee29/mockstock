"use client";

// 시즌 리더보드 — 서버는 원시 {현금·예약·보유}만 주고, 클라가 구독 중인 SSE 현재가로
// 전원 평가액을 로컬 재계산해 순위를 매긴다(§9). 순위/닉네임/수익률(등락색)/수익금 + BOT 배지,
// 내 순위 하이라이트, 시즌 카운트다운, 주기 폴링(react-query refetchInterval) + 수동 새로고침.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { keyOf, type Market } from "@mockstock/shared";
// ponytail: Market import kept for usePrices(symbols) position.market lookup, not for parameter.
import { usePrices } from "@/lib/market/usePrices";
import { formatPct, formatSignedPrice } from "@/lib/market/format";
import {
  LEADERBOARD_POLL_MS,
  rankParticipants,
  type LeaderboardResponse,
} from "@/lib/leaderboard";
import { PriceText } from "@/components/PriceText";
import { authClient } from "@/lib/auth-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const LEADERBOARD_ENDPOINT = "/api/leaderboard";
const COUNTDOWN_TICK_MS = 1_000;
/** 시즌 경계는 전부 KST(rules.ts). 브라우저 TZ와 무관하게 KST로 날짜를 찍는다. */
const KST_TZ = "Asia/Seoul";
const kstDayFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: KST_TZ, month: "long", day: "numeric" });
const fmtDay = (iso: string) => kstDayFmt.format(new Date(iso));

function formatCountdown(ms: number): string {
  if (ms <= 0) return "시즌 종료 · 정산 중";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d > 0 ? `${d}일 ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function LeaderboardView({ league }: { league: string }) {
  const session = authClient.useSession();
  const myId = session.data?.user?.id;

  const { data, status, isFetching, refetch } = useQuery({
    queryKey: ["leaderboard", league],
    refetchInterval: LEADERBOARD_POLL_MS,
    queryFn: async ({ signal }): Promise<LeaderboardResponse | null> => {
      const res = await fetch(`${LEADERBOARD_ENDPOINT}?league=${league}`, { signal });
      if (res.status === 404) return null; // 시즌 준비 중(active 시즌 없음 / DB 미설정)
      if (!res.ok) throw new Error("리더보드를 불러오지 못했습니다");
      return res.json();
    },
  });

  // 보유 종목 시세를 SSE 구독 → 로컬 평가에 사용. 종목 집합이 바뀌면 usePrices가 재연결.
  const symbols = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const out: { market: Market; symbol: string }[] = [];
    for (const p of data.participants) {
      for (const pos of p.positions) {
        const k = keyOf(pos.market, pos.symbol);
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ market: pos.market, symbol: pos.symbol });
        }
      }
    }
    return out;
  }, [data]);
  const quotes = usePrices(symbols);

  const ranked = useMemo(() => {
    if (!data) return [];
    return rankParticipants(
      data.participants,
      Number(data.season.seedMoney),
      (m, s) => quotes[keyOf(m, s)]?.price,
    );
  }, [data, quotes]);

  // 카운트다운 초 단위 갱신(폴링과 무관, 네트워크 없음).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">리더보드</h1>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="새로고침"
        >
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {status === "pending" ? (
        <LoadingRows />
      ) : status === "error" ? (
        <EmptyState
          title="리더보드를 불러오지 못했어요"
          hint="잠시 후 새로고침을 눌러 다시 시도해주세요."
        />
      ) : !data ? (
        <EmptyState
          title="시즌 준비 중이에요"
          hint="새 시즌이 곧 시작돼요. 잠시 후 다시 확인해주세요."
        />
      ) : (
        <>
          <SeasonBanner season={data.season} nowMs={nowMs} />
          {ranked.length === 0 ? (
            <EmptyState
              title="아직 참가자가 없어요"
              hint="가장 먼저 거래를 시작해 순위표를 열어보세요."
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              {ranked.map((row) => {
                const isMe = row.userId === myId;
                return (
                  <li key={row.userId} className={cn(isMe && "bg-brand/10")}>
                    {/* 행 전체 클릭 → 참가자 공개 포트폴리오 */}
                    <Link
                      href={`/${league}/u/${row.userId}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                    >
                      <span
                        className={cn(
                          "w-7 shrink-0 text-center text-sm font-bold tabular-nums",
                          row.rank <= 3 ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {row.rank}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">
                            {row.name?.trim() || "게스트"}
                          </span>
                          {row.isBot && <Badge variant="secondary">BOT</Badge>}
                          {isMe && (
                            <Badge className="bg-brand text-brand-foreground">나</Badge>
                          )}
                        </div>
                        <PriceText change={row.returnAbs} className="text-xs">
                          {formatSignedPrice(row.returnAbs, league === "us" ? "USD" : "KRW")}
                        </PriceText>
                      </div>
                      <PriceText
                        change={row.returnPct}
                        className="shrink-0 text-right text-base font-semibold"
                      >
                        {formatPct(row.returnPct)}
                      </PriceText>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function SeasonBanner({
  season,
  nowMs,
}: {
  season: LeaderboardResponse["season"];
  nowMs: number;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 rounded-xl bg-card px-4 py-4 ring-1 ring-foreground/10">
      <div>
        <p className="text-xs text-muted-foreground">진행 중인 시즌</p>
        <p className="text-lg font-bold tracking-tight">이번 달 시즌</p>
        <p className="text-xs text-muted-foreground">
          {fmtDay(season.startsAt)} – {fmtDay(season.endsAt)}
        </p>
      </div>
      <div className="text-right">
        <p className="text-xs text-muted-foreground">종료까지</p>
        <p className="font-mono text-2xl font-bold tabular-nums">
          {formatCountdown(new Date(season.endsAt).getTime() - nowMs)}
        </p>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-[74px] w-full rounded-xl" />
      <div className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-foreground/10">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}
