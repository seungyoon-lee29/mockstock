// 종목 상세 + 주문 패널 (T04/T08 데모 핵심 화면). 라우트는 QuoteCard가 링크하는
// /stock/[market]/[symbol] 형태 — market이 있어야 유니버스·시세·주문(6필드)이 성립한다.
import { notFound } from "next/navigation";
import { getEntry, keyOf } from "@mockstock/shared";
import { StockDetail } from "./stock-detail";

export default async function StockPage({
  params,
}: {
  params: Promise<{ market: string; symbol: string }>;
}) {
  const { market, symbol } = await params;
  if (market !== "US" && market !== "KR") notFound();
  const entry = getEntry(market, symbol);
  if (!entry) notFound();
  // key로 심볼 변경 시 StockDetail을 remount → useCandles accumulator·backfill 상태 리셋(교차오염 방지).
  return <StockDetail key={keyOf(market, symbol)} entry={entry} />;
}
