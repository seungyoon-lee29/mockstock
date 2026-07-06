// mock 피드 — 유니버스를 1초마다 랜덤워크로 갱신. 키 없이 로컬 구동 & 데모 폴백.
import { UNIVERSE, keyOf, randomWalk, roundPrice, type Market, type Tick } from "@mockstock/shared";
import type { Feed } from "./types";

export class MockFeed implements Feed {
  private timer: ReturnType<typeof setInterval> | undefined;
  private prices = new Map<string, number>();
  private readonly entries;

  constructor(readonly market: Market) {
    this.entries = UNIVERSE.filter((e) => e.market === market);
    for (const e of this.entries) {
      // 시작가: 전일종가 근사 ±1.5%
      const start = e.seedPrice * (1 + (Math.random() - 0.5) * 0.03);
      this.prices.set(keyOf(e.market, e.symbol), roundPrice(start, market));
    }
  }

  start(onTick: (tick: Tick) => void): void {
    const step = () => {
      for (const e of this.entries) {
        const k = keyOf(e.market, e.symbol);
        const next = roundPrice(randomWalk(this.prices.get(k)!, e.seedPrice), this.market);
        this.prices.set(k, next);
        onTick({ market: e.market, symbol: e.symbol, price: next, ts: Date.now(), source: "mock" });
      }
    };
    step();
    this.timer = setInterval(step, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
