// 시장 캘린더 세션 판정 테스트. UTC 절대시각(...Z)으로 구성해 tz·DST 변환을 실제로 태운다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSession } from "./marketCalendar";

const at = (iso: string) => new Date(iso);

test("KR 정규장 경계 [09:00, 15:30) — 평일 2026-07-06(월)", () => {
  assert.equal(marketSession("KR", at("2026-07-05T23:59:00Z")), "closed"); // 08:59 KST
  assert.equal(marketSession("KR", at("2026-07-06T00:00:00Z")), "open"); // 09:00 KST
  assert.equal(marketSession("KR", at("2026-07-06T06:29:00Z")), "open"); // 15:29 KST
  assert.equal(marketSession("KR", at("2026-07-06T06:30:00Z")), "closed"); // 15:30 KST
});

test("US 정규장 경계 [09:30, 16:00) — 평일 2026-07-06(월)", () => {
  assert.equal(marketSession("US", at("2026-07-06T13:29:00Z")), "closed"); // 09:29 ET
  assert.equal(marketSession("US", at("2026-07-06T13:30:00Z")), "open"); // 09:30 ET
  assert.equal(marketSession("US", at("2026-07-06T19:59:00Z")), "open"); // 15:59 ET
  assert.equal(marketSession("US", at("2026-07-06T20:00:00Z")), "closed"); // 16:00 ET
});

test("US DST — 7월 개장은 22:30 KST(=13:30 UTC, EDT)", () => {
  assert.equal(marketSession("US", at("2026-07-06T13:29:00Z")), "closed");
  assert.equal(marketSession("US", at("2026-07-06T13:30:00Z")), "open");
});

test("US DST — 1월 개장은 23:30 KST(=14:30 UTC, EST)", () => {
  // 2026-01-05(월), 휴장일 아님
  assert.equal(marketSession("US", at("2026-01-05T14:29:00Z")), "closed");
  assert.equal(marketSession("US", at("2026-01-05T14:30:00Z")), "open");
});

test("주말은 양 시장 closed — 2026-07-04(토)·07-05(일)", () => {
  assert.equal(marketSession("KR", at("2026-07-04T03:00:00Z")), "closed"); // 토 12:00 KST
  assert.equal(marketSession("US", at("2026-07-04T15:00:00Z")), "closed"); // 토 11:00 ET
  assert.equal(marketSession("KR", at("2026-07-05T03:00:00Z")), "closed"); // 일 12:00 KST
});

test("공휴일 closed — US 7/3(독립기념일 관측), KR 6/3(지방선거)·7/17(제헌절)", () => {
  assert.equal(marketSession("US", at("2026-07-03T14:00:00Z")), "closed"); // 10:00 ET
  assert.equal(marketSession("KR", at("2026-06-03T03:00:00Z")), "closed"); // 12:00 KST
  assert.equal(marketSession("KR", at("2026-07-17T03:00:00Z")), "closed"); // 12:00 KST
});

test("US 반일장 오버라이드 — 2026-11-27 13:00 ET 조기 마감", () => {
  assert.equal(marketSession("US", at("2026-11-27T17:59:00Z")), "open"); // 12:59 ET
  assert.equal(marketSession("US", at("2026-11-27T18:00:00Z")), "closed"); // 13:00 ET
  // 대조: 평일 정규장은 13:30 ET에도 open
  assert.equal(marketSession("US", at("2026-07-06T17:30:00Z")), "open"); // 13:30 ET
});

test("KR 개장지연 오버라이드 — 2026-01-02 10:00 개장", () => {
  assert.equal(marketSession("KR", at("2026-01-02T00:30:00Z")), "closed"); // 09:30 KST
  assert.equal(marketSession("KR", at("2026-01-02T01:00:00Z")), "open"); // 10:00 KST
  // 대조: 평일 정규장은 09:30 KST에 open
  assert.equal(marketSession("KR", at("2026-01-05T00:30:00Z")), "open"); // 09:30 KST(월)
});

test("KR 수능일 오버라이드 — 2026-11-19 [10:00, 16:30) 지연 개폐장", () => {
  assert.equal(marketSession("KR", at("2026-11-19T00:30:00Z")), "closed"); // 09:30 KST(지연 개장 전)
  assert.equal(marketSession("KR", at("2026-11-19T07:00:00Z")), "open"); // 16:00 KST(정규 마감 후·연장 중)
  assert.equal(marketSession("KR", at("2026-11-19T07:30:00Z")), "closed"); // 16:30 KST
});
