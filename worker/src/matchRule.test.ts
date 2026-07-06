// matchDecision 순수 판정 테스트 — node:test + tsx, DB·시세북 없이 실행.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Market, Side, Tick } from "@mockstock/shared";
import { matchDecision } from "./matchRule";

/** now 기준 age(ms) 전 틱 1건. source 기본 mock(항상 open). */
function tick(price: number, now: number, ageMs = 0, source: Tick["source"] = "mock"): Tick {
  return { market: "KR", symbol: "005930", price, ts: now - ageMs, source };
}
function decide(side: Side, limit: number, t: Tick | undefined, now: number, market: Market = "KR") {
  return matchDecision(side, limit, market, t, now);
}

const NOW = Date.UTC(2026, 6, 6, 1, 0, 0); // 2026-07-06 10:00 KST(월) — KR 정규장
const SUNDAY = Date.UTC(2026, 6, 5, 2, 0, 0); // 2026-07-05 11:00 KST(일) — 장 마감

test("매수 도달: tick ≤ limit → 체결가 = min(limit, tick) = tick", () => {
  assert.deepEqual(decide("buy", 75_000, tick(74_500, NOW), NOW), { fill: true, price: 74_500 });
});

test("매수 미도달: tick > limit → no fill", () => {
  assert.deepEqual(decide("buy", 75_000, tick(75_500, NOW), NOW), { fill: false });
});

test("매도 도달: tick ≥ limit → 체결가 = max(limit, tick) = tick", () => {
  assert.deepEqual(decide("sell", 75_000, tick(75_800, NOW), NOW), { fill: true, price: 75_800 });
});

test("매도 미도달: tick < limit → no fill", () => {
  assert.deepEqual(decide("sell", 75_000, tick(74_900, NOW), NOW), { fill: false });
});

test("갭 통과 매수: tick가 limit보다 크게 아래 → 유리한 틱가로 체결(§6.3)", () => {
  assert.deepEqual(decide("buy", 75_000, tick(70_000, NOW), NOW), { fill: true, price: 70_000 });
});

test("갭 통과 매도: tick가 limit보다 크게 위 → 유리한 틱가로 체결(§6.3)", () => {
  assert.deepEqual(decide("sell", 75_000, tick(80_000, NOW), NOW), { fill: true, price: 80_000 });
});

test("스테일: 신선도 초과 틱은 도달해도 스킵", () => {
  assert.deepEqual(decide("buy", 75_000, tick(74_000, NOW, 30_001), NOW), { fill: false });
  // 정확히 30초는 신선(경계 포함).
  assert.deepEqual(decide("buy", 75_000, tick(74_000, NOW, 30_000), NOW), { fill: true, price: 74_000 });
});

test("장외 실소스: 시장 마감이면 도달해도 no fill", () => {
  assert.deepEqual(decide("buy", 75_000, tick(74_000, SUNDAY, 0, "kis"), SUNDAY), { fill: false });
});

test("mock-open: mock 소스는 캘린더 마감(일요일)에도 open 간주 → 체결(§7.5)", () => {
  assert.deepEqual(decide("buy", 75_000, tick(74_000, SUNDAY, 0, "mock"), SUNDAY), { fill: true, price: 74_000 });
});

test("정규장 실소스 도달: 장중이면 체결", () => {
  assert.deepEqual(decide("buy", 75_000, tick(74_000, NOW, 0, "kis"), NOW), { fill: true, price: 74_000 });
});

test("틱 없음: no fill", () => {
  assert.deepEqual(decide("buy", 75_000, undefined, NOW), { fill: false });
});
