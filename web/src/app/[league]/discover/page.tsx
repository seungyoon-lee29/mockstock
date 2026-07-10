import { notFound } from "next/navigation";
import { Discover } from "@/components/discover/discover";

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
