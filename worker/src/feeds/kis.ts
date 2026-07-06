// KIS WS 피드 (KR) — 세션당 41건 한도 내 체결가(H0STCNT0)만 구독, source:"kis".
// ponytail: T05 구현. 토큰 24h 캐시·재발급 1분 스로틀·approval_key·PINGPONG·지수 백오프(B6).
import type { Market, Tick } from "@mockstock/shared";
import type { Feed } from "./types";

export class KisFeed implements Feed {
  readonly market: Market = "KR";
  start(_onTick: (tick: Tick) => void): void {
    throw new Error("KisFeed: not implemented — FEED_KR=mock 유지 (T05)");
  }
  stop(): void {}
}
