import type { Market } from "./types";

/** 시장별 호가 반올림: US 소수 2자리, KR 정수(원). 실 체결가에도 쓰는 도메인 규칙. */
export function roundPrice(price: number, market: Market): number {
  if (market === "US") return Math.round(price * 100) / 100;
  return Math.round(price);
}

/**
 * 평균회귀가 있는 랜덤워크 한 스텝. mock 피드·로컬 폴백·리플레이 노이즈에 공용.
 * shock: 매 틱 ±volatility, reversion: seed(전일종가)로 약하게 당김 → 폭주 방지.
 */
export function randomWalk(price: number, seed: number, volatility = 0.0015): number {
  const shock = (Math.random() - 0.5) * 2 * volatility;
  const reversion = seed ? ((seed - price) / seed) * 0.02 : 0;
  return price * (1 + shock + reversion);
}
