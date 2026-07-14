import type { Market } from "./types";

/**
 * KRX 호가 단위(2023-01-25 개정) — 가격대별 최소 가격 변동폭.
 * 실측 확인: 삼성전자 ~260,000원 호가가 500원 간격(260000/260500/261000)으로 이 표와 일치.
 */
export function krTickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

/**
 * 시장별 호가 반올림: US 소수 2자리, KR은 KRX 호가 단위(가격대별 스텝)로 스냅.
 * mock 가격 생성·실 체결가 표기에 공용(도메인 규칙). KR 정수 1원 반올림이던 것을 실제 호가 단위로 수정.
 * ponytail: 밴드 경계 근방(예: 199,900→200,000)은 tick 조회 후 반올림이라 인접 밴드로 넘어갈 수 있으나
 * 넘어간 값도 유효 호가라 무해 — 밴드별 정밀 클램프는 불필요.
 */
export function roundPrice(price: number, market: Market): number {
  if (market === "US") return Math.round(price * 100) / 100;
  const tick = krTickSize(price);
  return Math.round(price / tick) * tick;
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
