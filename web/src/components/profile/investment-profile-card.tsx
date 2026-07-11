"use client";

// "AI 투자 성향" 카드(§D8) — traits 칩 + 요약 문단 + 생성 방식 라벨.
// pending이면 생성 완료까지 폴링, insufficient면 데이터 부족 안내, 오류·404는 카드 숨김.
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { ProfileResponse } from "@/lib/profile/generate";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** pending(생성 중) 상태 폴링 간격 — lease 생성이 보통 수 초 내 끝난다. */
const PROFILE_PENDING_POLL_MS = 4_000;

async function fetchProfile(league: string, userId: string): Promise<ProfileResponse | null> {
  const res = await fetch(
    `/api/users/${encodeURIComponent(userId)}/profile?league=${league}`,
    { cache: "no-store" },
  );
  if (res.status === 404) return null; // 유저 부재·시즌 준비 중 → 카드 숨김
  if (!res.ok) throw new Error("투자 성향을 불러오지 못했습니다.");
  return res.json();
}

export function InvestmentProfileCard({ league, userId }: { league: string; userId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["investment-profile", league, userId],
    queryFn: () => fetchProfile(league, userId),
    // 생성 중(pending)일 때만 폴링 — 완료·실패·부족 상태는 정적.
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? PROFILE_PENDING_POLL_MS : false,
    retry: 1,
  });

  if (isError || data === null) return null; // 조용히 숨김 — 성향 카드는 보조 정보

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="size-4 text-primary" aria-hidden />
          AI 투자 성향
        </CardTitle>
        <CardDescription>이번 시즌 매매 기록으로 분석한 투자 스타일</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data || data.status === "pending" ? (
          <ProfileSkeleton />
        ) : data.status === "insufficient" ? (
          <p className="text-sm text-muted-foreground">
            거래 데이터가 더 쌓이면 분석해드려요. 몇 번 더 매매해 보세요!
          </p>
        ) : data.status === "failed" || !data.summary ? (
          <p className="text-sm text-muted-foreground">
            분석을 완료하지 못했어요. 잠시 후 다시 확인해 주세요.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.traits && data.traits.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {data.traits.map((trait) => (
                  <Badge key={trait} variant="secondary">
                    {trait}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-sm leading-relaxed">{data.summary}</p>
            <p className="text-xs text-muted-foreground">
              {data.aiGenerated ? "Claude AI 분석" : "간이 분석 (규칙 기반)"}
              {data.updatedAt &&
                ` · ${new Date(data.updatedAt).toLocaleDateString("ko-KR", {
                  month: "long",
                  day: "numeric",
                })} 기준`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
