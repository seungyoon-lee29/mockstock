// 리플레이 로컬 체결·지표 순수 로직 테스트 — node:test + tsx, DB·네트워크 없이 실행.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initAccount,
  equityOf,
  buy,
  sell,
  returnPct,
  maxDrawdown,
  buyAndHoldReturnPct,
  firstIndexOnOrAfter,
  lastIndexOnOrBefore,
  stepIntervalMs,
  savePendingReplay,
  loadPendingReplay,
  clearPendingReplay,
  visibleSeries,
  type Candle,
} from "./replay";

const SEED = 10_000_000;

test("전량 매수→전량 매도 라운드트립: 가격 불변이면 시드 보존", () => {
  let a = initAccount(SEED);
  a = buy(a, 100, 1);
  assert.equal(a.cash, 0);
  assert.ok(Math.abs(a.qty * 100 - SEED) < 1e-6); // 평가액 = 시드
  a = sell(a, 100, 1);
  assert.ok(Math.abs(a.cash - SEED) < 1e-6);
  assert.equal(a.qty, 0);
  assert.equal(a.trades, 2);
});

test("가격 2배 후 평가·수익률", () => {
  let a = initAccount(SEED);
  a = buy(a, 50, 1); // 전량 매수
  const eq = equityOf(a, 100); // 2배
  assert.ok(Math.abs(eq - SEED * 2) < 1e-6);
  assert.ok(Math.abs(returnPct(eq, SEED) - 100) < 1e-9);
});

test("부분 매수/매도 비중", () => {
  let a = initAccount(SEED);
  a = buy(a, 100, 0.5); // 현금 절반 투입
  assert.ok(Math.abs(a.cash - SEED / 2) < 1e-6);
  const qty0 = a.qty;
  a = sell(a, 100, 0.5); // 보유 절반 매도
  assert.ok(Math.abs(a.qty - qty0 / 2) < 1e-6);
});

test("현금/보유 소진 시 no-op(음수 방지)", () => {
  let a = initAccount(SEED);
  a = sell(a, 100, 1); // 보유 없음 → 무변화
  assert.equal(a.trades, 0);
  a = buy(a, 100, 1);
  const after = buy(a, 100, 1); // 현금 0 → 무변화
  assert.equal(after.trades, a.trades);
});

test("maxDrawdown: 100→150→75 고점대비 -50%", () => {
  assert.ok(Math.abs(maxDrawdown([100, 150, 75]) - -50) < 1e-9);
  assert.equal(maxDrawdown([100, 110, 120]), 0); // 우상향이면 낙폭 0
});

const candles: Candle[] = [
  { date: "2019-12-31", o: 1, h: 1, l: 1, c: 90, v: 0 },
  { date: "2020-01-02", o: 1, h: 1, l: 1, c: 100, v: 0 },
  { date: "2020-03-20", o: 1, h: 1, l: 1, c: 60, v: 0 },
  { date: "2020-07-31", o: 1, h: 1, l: 1, c: 120, v: 0 },
  { date: "2020-09-30", o: 1, h: 1, l: 1, c: 150, v: 0 },
];

test("재생 구간 인덱스 경계", () => {
  assert.equal(firstIndexOnOrAfter(candles, "2020-01-02"), 1); // warmup 제외 시작
  assert.equal(lastIndexOnOrBefore(candles, "2020-07-31"), 3); // tail 제외 끝
});

test("buyAndHold 수익률: 100→120 = +20%", () => {
  assert.ok(Math.abs(buyAndHoldReturnPct(candles, 1, 3) - 20) < 1e-9);
});

test("배속 간격: 클수록 짧다", () => {
  assert.ok(stepIntervalMs(30) < stepIntervalMs(10));
  assert.ok(stepIntervalMs(10) < stepIntervalMs(1));
});

// 미래 누설 금지 불변식(§5.3): visibleSeries는 **전체** 캔들(미래 포함)을 받아도 커서까지
// 자른 **뒤** 주봉 집계해야 한다. 집계 후 주-시작일로 필터하는 회귀(aggregate-then-filter)는
// 부분 주의 h/c에 커서 이후 캔들(수요일 h=99·c=42)을 새어들게 하므로 이 테스트가 잡아낸다.
test("주봉 미래 누설 없음: visibleSeries가 전체 캔들을 받아도 부분 주에 커서 이후 OHLC 미포함", () => {
  const daily: Candle[] = [
    { date: "2020-03-16", o: 10, h: 12, l: 9, c: 11, v: 1 }, // 월 (주1)
    { date: "2020-03-17", o: 11, h: 13, l: 10, c: 12, v: 1 }, // 화 (주1) ← 커서
    { date: "2020-03-18", o: 12, h: 99, l: 11, c: 42, v: 1 }, // 수 (주1) 미래 — 극단 h/c
    { date: "2020-03-23", o: 20, h: 22, l: 19, c: 21, v: 1 }, // 다음 주 월 (주2) 미래
  ];
  const cursor = 1; // 화요일까지만 관측(미래 캔들 2개 포함한 전체 배열을 그대로 전달)
  const weekly = visibleSeries(daily, cursor, "week", { finished: false, revealTail: false });
  assert.equal(weekly.length, 1); // 다음 주(주2) 미포함
  assert.equal(weekly[0].c, 12); // 부분 주 종가 = 커서 종가 — 수요일 c=42 미반영 (aggregate-then-filter면 42)
  assert.equal(weekly[0].h, 13); // 부분 주 고가 = 커서까지의 max — 수요일 h=99 미반영 (aggregate-then-filter면 99)
});

// 월봉도 동일 불변식: 커서까지 자른 **뒤** YYYY-MM 집계 — 같은 달의 커서 이후 캔들(h=99·c=42)과
// 다음 달 캔들이 부분 월에 새어들면 이 테스트가 잡아낸다.
test("월봉 미래 누설 없음: visibleSeries가 전체 캔들을 받아도 부분 월에 커서 이후 OHLC 미포함", () => {
  const daily: Candle[] = [
    { date: "2020-03-27", o: 10, h: 12, l: 9, c: 11, v: 1 }, // 3월 (월1)
    { date: "2020-03-30", o: 11, h: 13, l: 10, c: 12, v: 1 }, // 3월 (월1) ← 커서
    { date: "2020-03-31", o: 12, h: 99, l: 11, c: 42, v: 1 }, // 3월 (월1) 미래 — 극단 h/c
    { date: "2020-04-01", o: 20, h: 22, l: 19, c: 21, v: 1 }, // 4월 (월2) 미래
  ];
  const cursor = 1; // 3/30까지만 관측(미래 캔들 2개 포함한 전체 배열을 그대로 전달)
  const monthly = visibleSeries(daily, cursor, "month", { finished: false, revealTail: false });
  assert.equal(monthly.length, 1); // 다음 달(4월) 미포함
  assert.equal(monthly[0].c, 12); // 부분 월 종가 = 커서 종가 — 3/31 c=42 미반영
  assert.equal(monthly[0].h, 13); // 부분 월 고가 = 커서까지의 max — 3/31 h=99 미반영
  assert.equal(monthly[0].date, "2020-03-27"); // date = 월 첫 거래일
});

test("게스트 결과 보존(§194): 저장→로드 라운드트립·손상 데이터 거부·정리", () => {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  const pending = { id: "abc", scenarioId: "covid-2020", returnPct: 12.5, mdd: -8.3 };
  savePendingReplay(pending);
  assert.deepEqual(loadPendingReplay(), pending); // 라운드트립

  clearPendingReplay();
  assert.equal(loadPendingReplay(), null); // 정리 후 없음

  store.set("mockstock.replay.pending", JSON.stringify({ id: 1, returnPct: "x" }));
  assert.equal(loadPendingReplay(), null); // 타입 손상 → 거부

  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});
