// 순수 검증 로직 단위 테스트 (T04) — node:test + tsx, DB·네트워크 없이 실행.
// DB·워커 연동 경로(세션·시즌·체결)는 키 발급 후 통합 테스트 몫(ticket §10).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMarketOrderInput,
  parseOrderInput,
  isSnapshotFresh,
  isMarketTradable,
  fillResultToHttp,
  SNAPSHOT_MAX_AGE_MS,
} from "./validate";

const KEY = "123e4567-e89b-42d3-a456-426614174000"; // 유효 UUIDv4

test("parseMarketOrderInput: 정상 입력 통과", () => {
  const r = parseMarketOrderInput({ market: "KR", symbol: "005930", side: "buy", qty: 3, idempotencyKey: KEY });
  assert.deepEqual(r, {
    ok: true,
    value: { market: "KR", symbol: "005930", side: "buy", qty: 3, idempotencyKey: KEY },
  });
});

test("parseMarketOrderInput: 비객체·잘못된 시장/방향 거절", () => {
  assert.equal(parseMarketOrderInput(null).ok, false);
  assert.equal(parseMarketOrderInput("x").ok, false);
  assert.equal(parseMarketOrderInput({ market: "JP", symbol: "005930", side: "buy", qty: 1, idempotencyKey: KEY }).ok, false);
  assert.equal(parseMarketOrderInput({ market: "KR", symbol: "005930", side: "hold", qty: 1, idempotencyKey: KEY }).ok, false);
});

test("parseMarketOrderInput: 유니버스 밖 종목 거절", () => {
  assert.equal(parseMarketOrderInput({ market: "KR", symbol: "999999", side: "buy", qty: 1, idempotencyKey: KEY }).ok, false);
  // AAPL은 US 유니버스 — 시장 불일치면 거절
  assert.equal(parseMarketOrderInput({ market: "KR", symbol: "AAPL", side: "buy", qty: 1, idempotencyKey: KEY }).ok, false);
  assert.equal(parseMarketOrderInput({ market: "US", symbol: "AAPL", side: "buy", qty: 1, idempotencyKey: KEY }).ok, true);
});

test("parseMarketOrderInput: 수량은 1 이상 정수", () => {
  for (const qty of [0, -1, 1.5, Number.NaN, "3" as unknown as number]) {
    assert.equal(parseMarketOrderInput({ market: "KR", symbol: "005930", side: "buy", qty, idempotencyKey: KEY }).ok, false);
  }
});

test("parseMarketOrderInput: idempotencyKey UUIDv4 강제", () => {
  assert.equal(parseMarketOrderInput({ market: "KR", symbol: "005930", side: "buy", qty: 1, idempotencyKey: "not-a-uuid" }).ok, false);
  // v1 UUID(세 번째 그룹이 1로 시작)는 거절
  assert.equal(parseMarketOrderInput({ market: "KR", symbol: "005930", side: "buy", qty: 1, idempotencyKey: "123e4567-e89b-12d3-a456-426614174000" }).ok, false);
});

test("parseOrderInput: limitPrice 없으면 시장가", () => {
  const r = parseOrderInput({ market: "KR", symbol: "005930", side: "buy", qty: 3, idempotencyKey: KEY });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.type, "market");
});

test("parseOrderInput: limitPrice 있으면 지정가(값 통과)", () => {
  const r = parseOrderInput({ market: "KR", symbol: "005930", side: "buy", qty: 3, limitPrice: 74000, idempotencyKey: KEY });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.type === "limit" && r.value.limitPrice === 74000);
});

test("parseOrderInput: 잘못된 limitPrice 거절(0·음수·비숫자·NaN)", () => {
  for (const limitPrice of [0, -1, "74000" as unknown as number, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = parseOrderInput({ market: "KR", symbol: "005930", side: "buy", qty: 1, limitPrice, idempotencyKey: KEY });
    assert.equal(r.ok, false);
  }
});

test("parseOrderInput: 공통 필드 검증은 시장가와 동일(유니버스 밖 거절)", () => {
  assert.equal(parseOrderInput({ market: "KR", symbol: "999999", side: "buy", qty: 1, limitPrice: 100, idempotencyKey: KEY }).ok, false);
});

test("isSnapshotFresh: 30초 경계", () => {
  const now = 1_000_000;
  assert.equal(isSnapshotFresh(now, now), true);
  assert.equal(isSnapshotFresh(now, now - SNAPSHOT_MAX_AGE_MS), true); // 정확히 30초
  assert.equal(isSnapshotFresh(now, now - SNAPSHOT_MAX_AGE_MS - 1), false); // 30초 초과
});

test("isMarketTradable: mock source는 항상 거래 가능(§7.5)", () => {
  // 일요일(장 마감) — 실 소스면 닫힘, mock이면 열림.
  const sunday = new Date("2026-07-05T02:00:00Z");
  assert.equal(isMarketTradable("KR", "mock", sunday), true);
  assert.equal(isMarketTradable("KR", "kis", sunday), false);
  assert.equal(isMarketTradable("KR", undefined, sunday), false);
});

test("isMarketTradable: 실 소스는 정규장만", () => {
  // 2026-07-06 월요일 10:00 KST(=01:00 UTC) → KR 정규장(09:00~15:30)
  const krOpen = new Date("2026-07-06T01:00:00Z");
  assert.equal(isMarketTradable("KR", "kis", krOpen), true);
  // 2026-07-06 월요일 07:00 KST(=2026-07-05T22:00 UTC) → 개장 전
  const krPre = new Date("2026-07-05T22:00:00Z");
  assert.equal(isMarketTradable("KR", "kis", krPre), false);
});

test("fillResultToHttp: 전 케이스 매핑", () => {
  assert.deepEqual(fillResultToHttp({ ok: true, alreadyFilled: false }), { httpStatus: 200, message: "체결되었습니다." });
  assert.equal(fillResultToHttp({ ok: false, reason: "already-filled" }).httpStatus, 200);
  assert.equal(fillResultToHttp({ ok: false, reason: "insufficient-cash" }).httpStatus, 422);
  assert.equal(fillResultToHttp({ ok: false, reason: "insufficient-qty" }).httpStatus, 422);
  assert.equal(fillResultToHttp({ ok: false, reason: "over-limit" }).httpStatus, 422);
});
