import type { Metadata } from "next";
import { ParticipantView } from "./participant-view";

export const metadata: Metadata = {
  title: "참가자 포트폴리오 — 모의주식",
  description: "리그 참가자의 보유 종목과 실시간 평가액·수익률.",
};

// 리그 검증은 상위 [league]/layout.tsx가 수행(us|kr 외 notFound).
export default async function ParticipantPage({
  params,
}: {
  params: Promise<{ league: string; userId: string }>;
}) {
  const { league, userId } = await params;
  return (
    <main className="flex-1">
      <ParticipantView league={league} userId={userId} />
    </main>
  );
}
