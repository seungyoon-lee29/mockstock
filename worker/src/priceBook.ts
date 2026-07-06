// 인메모리 시세북 — 업스트림 피드가 갱신, /snapshot·SSE가 읽는 단일 소스.
import { keyOf, type Market, type Tick } from "@mockstock/shared";

export class PriceBook {
  private book = new Map<string, Tick>();

  set(tick: Tick): void {
    this.book.set(keyOf(tick.market, tick.symbol), tick);
  }

  get(market: Market, symbol: string): Tick | undefined {
    return this.book.get(keyOf(market, symbol));
  }

  /** 요청 심볼들의 현재 틱. 없는 심볼은 생략(체결 대기). */
  snapshot(keys: { market: Market; symbol: string }[]): Tick[] {
    const out: Tick[] = [];
    for (const k of keys) {
      const t = this.book.get(keyOf(k.market, k.symbol));
      if (t) out.push(t);
    }
    return out;
  }

  /** 전체 시세북 (SSE 최초 snapshot 이벤트용, B2). */
  all(): Tick[] {
    return [...this.book.values()];
  }
}
