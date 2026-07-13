import { ReplayPlayer } from "./replay-player";
import { findScenario } from "@/lib/replay";

// 종목별 재생 화면. scenarioId는 쿼리 ?s= 에서(레지스트리 검증). symbol 유효성(데이터 존재)은
// 클라이언트 fetch에서 처리(404 → 안내).
export default async function ReplayPlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ s?: string }>;
}) {
  const { symbol } = await params;
  const { s } = await searchParams;
  const scenario = findScenario(s);
  return (
    <main className="flex-1">
      <ReplayPlayer symbol={symbol.toUpperCase()} scenarioId={scenario.id} />
    </main>
  );
}
