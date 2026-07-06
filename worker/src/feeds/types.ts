import type { Market, Tick } from "@mockstock/shared";

/** 시세 피드 공통 인터페이스 — mock/finnhub/kis가 동일 시그니처 구현(B4). */
export interface Feed {
  readonly market: Market;
  start(onTick: (tick: Tick) => void): void;
  stop(): void;
}
