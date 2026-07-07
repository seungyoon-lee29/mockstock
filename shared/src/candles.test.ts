// candles 순수 집계 자체검증 — node:test + tsx, DB 없이 실행.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tick } from "@mockstock/shared";
import { aggregateDailyToWeekly, MinuteAggregator, type DailyCandle } from "./candles";

function daily(date: string, o: number, h: number, l: number, c: number, v: number): DailyCandle {
  return { date, o, h, l, c, v };
}
/** ms=epoch 밀리초. source 기본 mock. */
function tick(price: number, ms: number): Tick {
  return { market: "KR", symbol: "005930", price, ts: ms, source: "mock" };
}

test("주봉: ISO주 경계로 그룹·OHLC·거래량 합", () => {
  // 2026-07-06(월)~07-08(수) = 한 주, 07-13(월) = 다음 주.
  const weekly = aggregateDailyToWeekly([
    daily("2026-07-06", 100, 110, 95, 105, 1000),
    daily("2026-07-07", 105, 120, 100, 115, 2000),
    daily("2026-07-08", 115, 118, 90, 92, 1500),
    daily("2026-07-13", 92, 130, 92, 125, 3000),
  ]);
  assert.equal(weekly.length, 2);
  // 1주차: date=첫 거래일, o=첫날 시가, h=max, l=min, c=마지막날 종가, v=Σ.
  assert.deepEqual(weekly[0], { date: "2026-07-06", o: 100, h: 120, l: 90, c: 92, v: 4500 });
  // 2주차: 단일 거래일.
  assert.deepEqual(weekly[1], { date: "2026-07-13", o: 92, h: 130, l: 92, c: 125, v: 3000 });
});

test("주봉: 빈 배열 안전", () => {
  assert.deepEqual(aggregateDailyToWeekly([]), []);
});

test("주봉: 일요일은 직전 주(월~일)에 귀속", () => {
  // 2026-07-12(일)은 07-06 시작 주에 포함, 07-13(월)은 새 주.
  const weekly = aggregateDailyToWeekly([
    daily("2026-07-10", 10, 10, 10, 10, 1),
    daily("2026-07-12", 20, 20, 20, 20, 1),
    daily("2026-07-13", 30, 30, 30, 30, 1),
  ]);
  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].date, "2026-07-10");
  assert.equal(weekly[0].c, 20); // 일요일 종가가 주 종가
  assert.equal(weekly[1].date, "2026-07-13");
});

test("MinuteAggregator: 같은 분 누적은 null, 다음 분 진입 시 완성 캔들 반환", () => {
  const agg = new MinuteAggregator();
  // 버킷 6000초(=6_000_000ms) 구간.
  assert.equal(agg.add(tick(10, 6_000_000)), null); // 첫 틱 → open
  assert.equal(agg.add(tick(12, 6_010_000)), null); // h 갱신
  assert.equal(agg.add(tick(8, 6_020_000)), null); // l 갱신
  // 다음 분(6060초) 진입 → 직전 완성 캔들 반환.
  assert.deepEqual(agg.add(tick(9, 6_060_000)), { time: 6000, o: 10, h: 12, l: 8, c: 8, v: 3 });
  // 역행 틱(이전 버킷)은 무시 → null, 현재 버킷 불변.
  assert.equal(agg.add(tick(99, 6_055_000)), null);
  // flush로 미완성 버킷 방출.
  assert.deepEqual(agg.flush(), { time: 6060, o: 9, h: 9, l: 9, c: 9, v: 1 });
  assert.equal(agg.flush(), null); // 비었으면 null
});
