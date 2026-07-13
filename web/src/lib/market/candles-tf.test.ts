// 멀티 타임프레임 v2 서빙 순수 로직 테스트 — 당일 봉 tz 판정·합성, 분봉 로우 한도 수식,
// 병합 우선순위, 백필 구간 계산. 실행: npm run test -w web (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDLE_LIMITS, TF_MINUTES, type IntradayCandle } from "@mockstock/shared";
import {
  expectedMinuteBars,
  formatMarketDate,
  formatMarketTime,
  isChartLiveSource,
  isChartTimeframe,
  isCurrentDailyPeriod,
  isMinuteTf,
  lookbackStartDate,
  marketDayOf,
  mergeCandles,
  mergeLiveCandles,
  minuteLookbackFromSec,
  minuteRowLimit,
  missingOlderRange,
  synthesizeTodayBar,
} from "./candleServe";

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const bar = (time: number, o: number, h: number, l: number, c: number): IntradayCandle => ({
  time,
  o,
  h,
  l,
  c,
  v: 1,
});

test("tf 검증: 계약 tf만 통과, 분봉 계열 판별", () => {
  for (const tf of [...Object.keys(TF_MINUTES), "day", "week", "month"]) {
    assert.ok(isChartTimeframe(tf), tf);
  }
  assert.equal(isChartTimeframe("2h"), false);
  assert.equal(isChartTimeframe(""), false);
  assert.equal(isMinuteTf("60m"), true);
  assert.equal(isMinuteTf("day"), false);
});

test("분봉 로우 한도 = 캔들캡 × 분수 (60m 함정: 로우에 240을 적용하면 4캔들로 붕괴)", () => {
  assert.equal(minuteRowLimit("1m"), CANDLE_LIMITS.intradayCandleCap);
  assert.equal(minuteRowLimit("60m"), CANDLE_LIMITS.intradayCandleCap * 60); // 14,400 로우
  assert.equal(minuteRowLimit("5m"), CANDLE_LIMITS.intradayCandleCap * 5);
});

test("minuteLookbackFromSec: 일요일 KR 1m — 금요일 개장 이전까지 소급(주말 0봉 버그 회귀)", () => {
  const sun = new Date("2026-07-12T03:00:00+09:00"); // 일요일 새벽 KST — 벽시계 24h 창엔 금요일장 없음
  const from = minuteLookbackFromSec("KR", "1m", sun);
  assert.ok(from < sec("2026-07-10T09:00:00+09:00"), "금요일 세션 시작을 포함해야 한다");
  assert.ok(from > sec("2026-07-05T00:00:00+09:00"), "1m(1세션+여유)은 1주 안쪽이어야 한다");
});

test("minuteLookbackFromSec: 일요일 KR 5m(캡 2000분 ≈ 5세션, +여유 7세션 소급) — 수요일 개장까지 포함", () => {
  const sun = new Date("2026-07-12T03:00:00+09:00");
  const from = minuteLookbackFromSec("KR", "5m", sun);
  assert.ok(from < sec("2026-07-08T09:00:00+09:00"), "수~금 세션을 포함해야 한다");
  assert.ok(from > sec("2026-06-28T00:00:00+09:00"), "7세션+여유면 2주 안쪽이어야 한다");
});

test("minuteLookbackFromSec: 월요일 장중 KR 1m — 직전 거래일 포함하되 과도하게 깊지 않음", () => {
  const mon = new Date("2026-07-13T10:00:00+09:00");
  const from = minuteLookbackFromSec("KR", "1m", mon);
  assert.ok(from < sec("2026-07-10T09:00:00+09:00"), "금요일(직전 거래일) 개장 이전");
  assert.ok(from >= Math.floor(mon.getTime() / 1000) - 6 * 24 * 3600, "6일 안쪽");
});

test("expectedMinuteBars: KR 세션 09:00~15:30(390분) — 개장 전 0·장중 경과분·마감 후 클램프·주말 0", () => {
  // 월요일(2026-07-13) 각 시점의 KST 벽시계 → 개장 후 경과분(retry 임계 기준).
  assert.equal(expectedMinuteBars("KR", new Date("2026-07-13T08:00:00+09:00")), 0, "개장 전");
  assert.equal(expectedMinuteBars("KR", new Date("2026-07-13T09:00:00+09:00")), 0, "개장 정각");
  assert.equal(expectedMinuteBars("KR", new Date("2026-07-13T11:00:00+09:00")), 120, "11시=120분 경과");
  assert.equal(expectedMinuteBars("KR", new Date("2026-07-13T18:00:00+09:00")), 390, "마감 후 세션 전체로 클램프");
  assert.equal(expectedMinuteBars("KR", new Date("2026-07-11T11:00:00+09:00")), 0, "토요일=0(직전 금요일장 이미 축적)");
});

test("marketDayOf: US 저녁 세션은 KST로 다음날이지만 거래일은 ET 기준", () => {
  // 2026-07-10 20:00 ET(EDT) = 2026-07-11 00:00 UTC = 2026-07-11 09:00 KST
  const at = new Date("2026-07-10T20:00:00-04:00");
  assert.equal(marketDayOf("US", at), "2026-07-10"); // KST date(07-11) 사용 금지 계약
  assert.equal(marketDayOf("KR", at), "2026-07-11");
});

test("synthesizeTodayBar: US 세션이 KST 이틀에 걸쳐도 ET 당일 분봉만 집계, v=0", () => {
  // now = 2026-07-10 15:30 ET(장중). KST로는 이미 07-11 04:30.
  const now = new Date("2026-07-10T15:30:00-04:00");
  const minutes: IntradayCandle[] = [
    bar(sec("2026-07-09T15:00:00-04:00"), 99, 99, 99, 99), // 전일(ET) — 제외
    bar(sec("2026-07-10T09:31:00-04:00"), 10, 12, 9, 11), // 개장 직후(KST 07-10 22:31)
    bar(sec("2026-07-10T15:29:00-04:00"), 11, 15, 8, 14), // 마감 직전(KST 07-11 04:29)
  ];
  assert.deepEqual(synthesizeTodayBar(minutes, "US", now), {
    date: "2026-07-10",
    o: 10,
    h: 15,
    l: 8,
    c: 14,
    v: 0, // 합성 봉 v=0 고정 계약
  });
});

test("synthesizeTodayBar: 당일 분봉 없으면 null(정직한 공백)", () => {
  const now = new Date("2026-07-10T15:30:00-04:00");
  assert.equal(synthesizeTodayBar([], "US", now), null);
  assert.equal(
    synthesizeTodayBar([bar(sec("2026-07-09T15:00:00-04:00"), 1, 1, 1, 1)], "US", now),
    null,
  );
});

test("synthesizeTodayBar: KR은 KST 당일 기준", () => {
  const now = new Date("2026-07-10T10:00:00+09:00");
  const out = synthesizeTodayBar(
    [bar(sec("2026-07-10T09:15:00+09:00"), 100, 110, 95, 105)],
    "KR",
    now,
  );
  assert.deepEqual(out, { date: "2026-07-10", o: 100, h: 110, l: 95, c: 105, v: 0 });
});

test("mergeCandles: 같은 time은 primary(정본) 채택, 결과 오름차순", () => {
  const primary = [bar(60, 2, 2, 2, 2)];
  const secondary = [bar(120, 3, 3, 3, 3), bar(0, 1, 1, 1, 1), bar(60, 9, 9, 9, 9)];
  const out = mergeCandles(primary, secondary);
  assert.deepEqual(
    out.map((c) => [c.time, c.o]),
    [
      [0, 1],
      [60, 2], // 충돌 버킷은 primary
      [120, 3],
    ],
  );
});

test("mergeLiveCandles: 충돌 버킷 결합(h/l 확장·c 라이브·o/v 백필), 최신 라이브 이어붙임, 과거 라이브 폐기", () => {
  const backfill: IntradayCandle[] = [
    bar(0, 1, 2, 0.5, 1.5),
    { time: 60, o: 10, h: 12, l: 9, c: 11, v: 7 }, // 백필 마지막 = 라이브 forming과 충돌 버킷
  ];
  const live: IntradayCandle[] = [
    bar(0, 99, 99, 99, 99), // 백필 마지막보다 과거 — 폐기(백필이 정본)
    { time: 60, o: 11, h: 13, l: 8, c: 12.5, v: 3 }, // 충돌 — 결합돼야 함(덮어쓰기 금지)
    bar(120, 12, 14, 12, 13), // 백필 마지막보다 최신 — 그대로 이어붙임
  ];
  assert.deepEqual(mergeLiveCandles(backfill, live), [
    bar(0, 1, 2, 0.5, 1.5),
    { time: 60, o: 10, h: 13, l: 8, c: 12.5, v: 7 }, // o·v=백필, h/l=확장, c=라이브
    bar(120, 12, 14, 12, 13),
  ]);
});

test("mergeLiveCandles: 백필이 비면 라이브 그대로, 라이브가 비면 백필 그대로", () => {
  const live = [bar(60, 1, 1, 1, 1)];
  assert.deepEqual(mergeLiveCandles([], live), live);
  const backfill = [bar(0, 1, 2, 0.5, 1.5)];
  assert.deepEqual(mergeLiveCandles(backfill, []), backfill);
});

test("missingOlderRange: DB 빈 경우 전체, 일부 부족은 [from, oldest-1], 충분하면 null", () => {
  assert.deepEqual(missingOlderRange(null, 100, 200), { from: 100, to: 200 });
  assert.deepEqual(missingOlderRange(150, 100, 200), { from: 100, to: 149 });
  assert.equal(missingOlderRange(100, 100, 200), null); // 요청 시작이 DB 범위 안
  assert.equal(missingOlderRange(50, 100, 200), null);
  assert.equal(missingOlderRange(null, 200, 100), null); // from > to 방어
});

test("isChartLiveSource: 확인된 실피드 틱만 통과 — mock·source 미상(baseline 합성) 불허", () => {
  assert.equal(isChartLiveSource("mock"), false);
  assert.equal(isChartLiveSource("kis"), true);
  assert.equal(isChartLiveSource("finnhub"), true);
  assert.equal(isChartLiveSource(undefined), false); // baseline 합성 quote(ts=0) → 1970 캔들 방지
});

test("isCurrentDailyPeriod: day=당일 일치만 갱신", () => {
  assert.equal(isCurrentDailyPeriod("day", "2026-07-10", "2026-07-10"), true);
  assert.equal(isCurrentDailyPeriod("day", "2026-07-09", "2026-07-10"), false);
});

test("isCurrentDailyPeriod: week=ISO주(월요일 시작) — 같은 주만 갱신, 일요일은 전주 귀속", () => {
  // 2026-07-06(월) ~ 2026-07-12(일)이 한 주.
  assert.equal(isCurrentDailyPeriod("week", "2026-07-06", "2026-07-10"), true); // 월 vs 금
  assert.equal(isCurrentDailyPeriod("week", "2026-07-06", "2026-07-12"), true); // 월 vs 일(같은 ISO주)
  assert.equal(isCurrentDailyPeriod("week", "2026-07-05", "2026-07-06"), false); // 전주 일 vs 이번주 월
  assert.equal(isCurrentDailyPeriod("week", "2026-06-29", "2026-07-06"), false); // 지난주 봉 — 무시
});

test("isCurrentDailyPeriod: month=YYYY-MM 일치만 갱신(연 경계 포함)", () => {
  assert.equal(isCurrentDailyPeriod("month", "2026-07-01", "2026-07-31"), true);
  assert.equal(isCurrentDailyPeriod("month", "2026-06-30", "2026-07-01"), false);
  assert.equal(isCurrentDailyPeriod("month", "2025-12-31", "2026-01-02"), false);
});

test("formatMarketTime/Date: 분봉 X축 라벨은 시장 tz(KST·ET) — UTC 표기 회귀 방지", () => {
  const krOpen = sec("2026-07-10T09:00:00+09:00"); // = UTC 00:00 — UTC로 찍으면 "00:00"
  assert.equal(formatMarketTime("KR", krOpen), "09:00");
  assert.equal(formatMarketDate("KR", krOpen), "7. 10.");
  const usOpen = sec("2026-07-10T09:30:00-04:00"); // = UTC 13:30 — UTC로 찍으면 "13:30"
  assert.equal(formatMarketTime("US", usOpen), "09:30");
  assert.equal(formatMarketDate("US", usOpen), "7. 10.");
});

test("lookbackStartDate: 일봉 룩백 컷오프(연 경계 포함)", () => {
  assert.equal(lookbackStartDate("2026-07-11", 730), "2024-07-11");
  assert.equal(lookbackStartDate("2026-01-01", 1), "2025-12-31");
});
