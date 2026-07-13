// mock 피드 — 유니버스를 1초마다 랜덤워크로 갱신. 키 없이 로컬 구동 & 데모 폴백.
import { UNIVERSE, keyOf, randomWalk, roundPrice, type Market, type Tick } from "@mockstock/shared";
import type { Feed } from "./types";

/**
 * 시세 앵커 맵(key=keyOf) — 실 종가(daily_candles→instruments 브리지)로 워크를 고정한다.
 * 부팅 백필은 피드 시작 이후 비동기로 도착하므로, 생성 시점 정적 맵이 아니라 **공유 가변 Map 참조**를
 * 넘겨 매 스텝 lazy 조회한다. 미설정 심볼은 seedPrice 폴백(키리스·데이터 없음 로컬 불변식).
 */
export type AnchorMap = Map<string, number>;

export class MockFeed implements Feed {
  private timer: ReturnType<typeof setInterval> | undefined;
  private prices = new Map<string, number>();
  private readonly entries;
  private seeded = false;

  constructor(
    readonly market: Market,
    private readonly anchors?: AnchorMap,
  ) {
    this.entries = UNIVERSE.filter((e) => e.market === market);
  }

  /** 심볼 앵커: 실 종가(브리지) 우선, 없으면 seedPrice. */
  private anchor(key: string, seedPrice: number): number {
    return this.anchors?.get(key) ?? seedPrice;
  }

  /**
   * 시작가 시딩 — 앵커(실 종가)는 부팅 백필 후 늦게 도착하므로 매 스텝 재확인한다.
   * 앵커 맵이 주입됐는데 아직 비어 있으면 seedPrice로 임시 시딩하되 seeded 를 세우지 않아,
   * 앵커가 채워지는 첫 스텝에 실 종가 근방으로 1회 재시딩(헤더가 즉시 실가로 점프).
   */
  private ensureSeed(): void {
    if (this.seeded) return;
    const anchorsReady = !this.anchors || this.anchors.size > 0;
    for (const e of this.entries) {
      const k = keyOf(e.market, e.symbol);
      const start = this.anchor(k, e.seedPrice) * (1 + (Math.random() - 0.5) * 0.03); // 전일종가 근사 ±1.5%
      this.prices.set(k, roundPrice(start, this.market));
    }
    if (anchorsReady) this.seeded = true; // 앵커 확정 후에만 재시딩 종료
  }

  start(onTick: (tick: Tick) => void): void {
    const step = () => {
      this.ensureSeed();
      for (const e of this.entries) {
        const k = keyOf(e.market, e.symbol);
        const next = roundPrice(randomWalk(this.prices.get(k)!, this.anchor(k, e.seedPrice)), this.market);
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
