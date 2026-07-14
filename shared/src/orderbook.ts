// 호가창(orderbook depth) 계약 + mock 합성기 — 표시 전용(read-only, 체결·정산 무관).
// 실 호가는 KR·kis 피드일 때만 워커가 KIS에서 받아오고(orderbookRoute), 그 외(mock KR·모든 US)는
// 현재가 주변으로 synthOrderbook이 합성한다("US 무료까지만" — 무료 US 호가 소스 없음).
import type { Market } from "./types";
import { krTickSize } from "./mock";

export interface OrderbookLevel {
  price: number;
  qty: number;
}

export interface Orderbook {
  market: Market;
  symbol: string;
  asks: OrderbookLevel[]; // index 0 = 최우선 매도호가(가장 낮은 매도가), 가격 오름차순
  bids: OrderbookLevel[]; // index 0 = 최우선 매수호가(가장 높은 매수가), 가격 내림차순
  ts: number;
  source: "kis" | "synth";
}

export const ORDERBOOK_LEVELS = 10;

/**
 * 레벨 수량 시드 해시 — (symbol, side, level, floor(price/tick))로 결정적 pseudo-random.
 * 가격이 그대로면 수량도 그대로(정지 시 flicker 없음), 가격이 걸어가면 floor(price/tick)가 바뀌며
 * 수량도 갱신(움직임엔 살아있어 보임). FNV-1a 32bit — 프레임워크 없이 작은 정수 해시로 충분.
 */
function seededQty(seedStr: string, market: Market): number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = ((h >>> 0) % 1000) / 1000; // 0..1
  // KR: 종목당 수십~수천 주, US: 수~수백 주
  return market === "KR" ? Math.round(10 + r * 4990) : Math.round(1 + r * 499);
}

/** 시장별 호가 스냅 — US 소수 2자리, KR은 KRX 호가 단위. */
function snapToTick(price: number, market: Market, tick: number): number {
  if (market === "US") return Math.round(price * 100) / 100;
  return Math.round(price / tick) * tick;
}

/**
 * 현재가 주변 mock 호가창 — 최우선 매도 = price+tick, 최우선 매수 = price(bids[0]).
 * 균일 간격(중심가 기준 단일 tick) 10+10 레벨. price가 비정상(비유한·≤0)이면 빈 호가.
 * ponytail: 밴드 경계 근방(예: 199,900↔200,000)에선 단일 tick 근사라 일부 레벨이 실제 호가 단위와
 * 어긋날 수 있으나, snapToTick 후 값은 여전히 그럴듯한 유효 호가 — mock book이라 무해.
 */
export function synthOrderbook(market: Market, symbol: string, price: number, ts: number): Orderbook {
  if (!Number.isFinite(price) || price <= 0) {
    return { market, symbol, asks: [], bids: [], ts, source: "synth" };
  }
  const tick = market === "KR" ? krTickSize(price) : 0.01;
  const asks: OrderbookLevel[] = [];
  const bids: OrderbookLevel[] = [];
  for (let i = 0; i < ORDERBOOK_LEVELS; i++) {
    const ap = snapToTick(price + (i + 1) * tick, market, tick); // asks[0] = price+tick
    const bp = snapToTick(price - i * tick, market, tick); // bids[0] = price
    asks.push({ price: ap, qty: seededQty(`${symbol}|ask|${i}|${Math.floor(ap / tick)}`, market) });
    bids.push({ price: bp, qty: seededQty(`${symbol}|bid|${i}|${Math.floor(bp / tick)}`, market) });
  }
  return { market, symbol, asks, bids, ts, source: "synth" };
}
