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
