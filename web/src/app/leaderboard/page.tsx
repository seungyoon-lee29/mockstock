import type { Metadata } from "next";
import { LeaderboardView } from "./leaderboard-view";

export const metadata: Metadata = {
  title: "리더보드 — 모의주식",
  description: "이번 주 시즌 실시간 수익률 순위. 봇 벤치마크 포함.",
};

export default function LeaderboardPage() {
  return (
    <main className="flex-1">
      <LeaderboardView />
    </main>
  );
}
