import { keyOf, type Market, type Quote } from "@mockstock/shared";

// 재정렬 주기 — popular 데이터가 서버 30초 캐시라 그보다 빠른 재정렬은 무의미한 지터일 뿐.
export const RERANK_INTERVAL_MS = 30_000;

// 인기 순위: 당일 체결 건수 순(rankOf) → 집계에 없는 종목은 등락률 내림차순으로 뒤에.
// popular가 비었으면(rankOf 비어있음) 전체가 등락률 폴백. 순수 함수 — 같은 입력에 결정론적.
// 반환: 정렬된 심볼 키 배열(고정 순서). 렌더는 이 순서로 하되 가격은 quotes에서 라이브 조회.
export function rankOrder(
  entries: { market: Market; symbol: string }[],
  rankOf: Map<string, number>,
  quotes: Record<string, Quote>,
): string[] {
  const pctOf = (e: { market: Market; symbol: string }) =>
    quotes[keyOf(e.market, e.symbol)]?.changePct ?? 0;
  return [...entries]
    .sort((a, b) => {
      const ra = rankOf.get(keyOf(a.market, a.symbol)) ?? Infinity;
      const rb = rankOf.get(keyOf(b.market, b.symbol)) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return pctOf(b) - pctOf(a);
    })
    .map((e) => keyOf(e.market, e.symbol));
}
