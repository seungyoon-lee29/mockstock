import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeaderboardView } from "./leaderboard-view";

export const metadata: Metadata = { title: "리더보드 — 모의주식", description: "이번 달 리그 실시간 수익률 순위. 봇 벤치마크 포함." };

export default async function LeagueLeaderboardPage({ params }: { params: Promise<{ league: string }> }) {
  const { league } = await params;
  const market = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) notFound();
  return <main className="flex-1"><LeaderboardView league={league} /></main>;
}
