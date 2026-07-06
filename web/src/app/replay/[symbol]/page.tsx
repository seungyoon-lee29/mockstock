import { ReplayPlayer } from "./replay-player";

// 종목별 재생 화면. symbol 유효성(데이터 존재 여부)은 클라이언트 fetch에서 처리(404 → 안내).
export default async function ReplayPlayPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  return (
    <main className="flex-1">
      <ReplayPlayer symbol={symbol.toUpperCase()} />
    </main>
  );
}
