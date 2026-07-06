// 서버 전용 시세 소스.
// mock 모드: 유니버스 전체를 1초마다 랜덤워크로 갱신하는 모듈 싱글톤.
// 실 모드(추후): 워커의 스냅샷 REST를 조회하도록 이 파일만 교체.

import {
  UNIVERSE,
  keyOf,
  randomWalk,
  roundPrice,
  type Market,
  type Tick,
} from "@mockstock/shared";

type Book = Map<string, number>;
type G = typeof globalThis & {
  __mockBook?: Book;
  __mockTimer?: ReturnType<typeof setInterval>;
};
const g = globalThis as G;

function ensureBook(): Book {
  if (!g.__mockBook) {
    const book: Book = new Map();
    for (const e of UNIVERSE) {
      // 시작가: 전일종가 ±1.5% 랜덤
      const start = e.seedPrice * (1 + (Math.random() - 0.5) * 0.03);
      book.set(keyOf(e.market, e.symbol), roundPrice(start, e.market));
    }
    g.__mockBook = book;
    g.__mockTimer = setInterval(() => {
      for (const e of UNIVERSE) {
        const k = keyOf(e.market, e.symbol);
        const cur = book.get(k)!;
        book.set(k, roundPrice(randomWalk(cur, e.seedPrice), e.market));
      }
    }, 1000);
    g.__mockTimer.unref?.();
  }
  return g.__mockBook;
}

export function getPrice(market: Market, symbol: string): number | undefined {
  return ensureBook().get(keyOf(market, symbol));
}

export function snapshot(keys: { market: Market; symbol: string }[]): Tick[] {
  const book = ensureBook();
  const ts = Date.now();
  const out: Tick[] = [];
  for (const k of keys) {
    const price = book.get(keyOf(k.market, k.symbol));
    if (price != null) out.push({ market: k.market, symbol: k.symbol, price, ts });
  }
  return out;
}
