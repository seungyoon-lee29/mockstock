"use client";

// 종목 호가창 훅 — /api/orderbook를 2초 폴(react-query). 실패·미도착이면 undefined(fail-soft) →
// 호출 컴포넌트가 "호가 대기 중"으로 강등. 실 호가(KR·kis)든 synth든 워커가 판단, web은 표시만.
import { useQuery } from "@tanstack/react-query";
import type { Market, Orderbook } from "@mockstock/shared";

const POLL_MS = 2_000; // 준실시간 호가 갱신 주기.

export function useOrderbook(market: Market, symbol: string): Orderbook | undefined {
  const { data } = useQuery({
    queryKey: ["orderbook", market, symbol],
    queryFn: async ({ signal }): Promise<Orderbook> => {
      const res = await fetch(`/api/orderbook?market=${market}&symbol=${encodeURIComponent(symbol)}`, { signal });
      if (!res.ok) throw new Error("호가를 불러오지 못했습니다");
      return res.json();
    },
    refetchInterval: POLL_MS,
    staleTime: POLL_MS, // 폴 주기 내 재마운트는 캐시 재사용(불필요 재요청 억제)
  });
  return data;
}
