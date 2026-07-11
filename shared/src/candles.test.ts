// candles 순수 집계 자체검증 — node:test + tsx, DB 없이 실행.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tick } from "@mockstock/shared";
import {
  aggregateDailyToMonthly,
  aggregateDailyToWeekly,
  aggregateIntraday,
  MinuteAggregator,
  TF_MINUTES,
  type DailyCandle,
  type IntradayCandle,
} from "./candles";

function daily(date: string, o: number, h: number, l: number, c: number, v: number): DailyCandle {
  return { date, o, h, l, c, v };
}
/** ms=epoch 밀리초. source 기본 mock. */
function tick(price: number, ms: number): Tick {
  return { market: "KR", symbol: "005930", price, ts: ms, source: "mock" };
}
/** time=epoch 초(분 버킷 시작). */
function m1(time: number, o: number, h: number, l: number, c: number, v: number): IntradayCandle {
  return { time, o, h, l, c, v };
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

test("N분 롤업: 버킷 첫/마지막 분봉 경계 — o=첫 시가, c=마지막 종가, h/l/v 집계", () => {
  const out = aggregateIntraday(
    [
      m1(300, 10, 12, 9, 11, 1), // 버킷 300의 첫 분(=버킷 시작 정확히)
      m1(540, 11, 15, 8, 14, 2), // 같은 버킷 마지막 분(300+4×60)
      m1(600, 14, 16, 14, 15, 3), // 다음 버킷 시작
    ],
    5,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { time: 300, o: 10, h: 15, l: 8, c: 14, v: 3 });
  assert.deepEqual(out[1], { time: 600, o: 14, h: 16, l: 14, c: 15, v: 3 });
});

test("N분 롤업: minutes=1은 입력 그대로, 빈 입력 안전", () => {
  const src = [m1(60, 1, 2, 1, 2, 1)];
  assert.deepEqual(aggregateIntraday(src, 1), src);
  assert.deepEqual(aggregateIntraday([], 60), []);
});

test("60분 롤업: KR 09:00 KST 개장 — 버킷이 정확히 09:00 KST에서 시작", () => {
  // 09:00 KST = 00:00 UTC → epoch가 3600의 배수(정시 관례와 자연 정렬).
  const kr0900 = Date.UTC(2026, 6, 10, 0, 0) / 1000;
  assert.equal(kr0900 % 3600, 0);
  // 09:00~10:29 KST 1분봉 90개 → 60분봉 2개(09:00 완전, 10:00 부분).
  const src: IntradayCandle[] = [];
  for (let i = 0; i < 90; i++) src.push(m1(kr0900 + i * 60, 100 + i, 100 + i, 100 + i, 100 + i, 1));
  const out = aggregateIntraday(src, TF_MINUTES["60m"]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { time: kr0900, o: 100, h: 159, l: 100, c: 159, v: 60 });
  assert.equal(out[1].time, kr0900 + 3600);
  assert.equal(out[1].v, 30);
});

test("60분 롤업: US 09:30 개장 → 09:00 앵커 스텁 버킷(정시 관례)", () => {
  // 09:30 ET(EDT) = 13:30 UTC — 첫 60분 버킷은 13:00 UTC(=09:00 ET) 앵커, 실데이터는 30분치.
  const us0930 = Date.UTC(2026, 6, 10, 13, 30) / 1000;
  const out = aggregateIntraday(
    [
      m1(us0930, 50, 51, 49, 50, 1),
      m1(us0930 + 29 * 60, 50, 55, 48, 54, 2), // 09:59 — 스텁 버킷 마지막 분
      m1(us0930 + 30 * 60, 54, 56, 53, 55, 3), // 10:00 — 새 버킷
    ],
    60,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].time % 3600, 0); // 버킷 시작은 반드시 정시(top-of-hour)
  assert.deepEqual(out[0], { time: us0930 - 30 * 60, o: 50, h: 55, l: 48, c: 54, v: 3 });
  assert.equal(out[1].time, us0930 + 30 * 60);
});

test("월봉: YYYY-MM 그룹·연말 경계(12월→1월), date=월 첫 거래일", () => {
  const monthly = aggregateDailyToMonthly([
    daily("2026-12-30", 100, 110, 95, 105, 1000),
    daily("2026-12-31", 105, 120, 100, 115, 2000),
    daily("2027-01-02", 115, 118, 90, 92, 1500), // 1/1 휴장 — 월 첫 거래일이 date
  ]);
  assert.equal(monthly.length, 2);
  assert.deepEqual(monthly[0], { date: "2026-12-30", o: 100, h: 120, l: 95, c: 115, v: 3000 });
  assert.deepEqual(monthly[1], { date: "2027-01-02", o: 115, h: 118, l: 90, c: 92, v: 1500 });
});

test("월봉: 빈 배열 안전", () => {
  assert.deepEqual(aggregateDailyToMonthly([]), []);
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
