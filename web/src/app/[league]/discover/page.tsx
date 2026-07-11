import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Discover } from "@/components/discover/discover";

export const metadata: Metadata = {
  title: "탐색 — 모의주식",
  description: "인기 종목을 둘러보고 종목명·티커로 검색해 바로 매매하세요.",
};

export default async function LeagueDiscoverPage({ params }: { params: Promise<{ league: string }> }) {
  const { league } = await params;
  const market = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) notFound();
  return (
    <main className="flex-1">
      <Discover market={market} />
    </main>
  );
}
