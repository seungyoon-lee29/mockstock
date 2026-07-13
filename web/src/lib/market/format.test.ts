// 시총 compute/format 단위 테스트 — 라이브 시총 = shares × price 파생 + 조/억·T/B/M 축약.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMarketCap, formatMarketCap } from "./format";

test("computeMarketCap — shares × price(문자열 shares)", () => {
  // 삼성전자 근사: 5,969,782,550주 × 285,000원 = 1,701,388,026,750,000원 ≈ 1,701.4조
  const cap = computeMarketCap("5969782550", 285000);
  assert.equal(cap, 5969782550 * 285000);
  assert.equal(formatMarketCap(cap, "KRW"), "1701.4조");
});

test("computeMarketCap — shares 미상/비수치/0 → null", () => {
  assert.equal(computeMarketCap(null, 285000), null);
  assert.equal(computeMarketCap(undefined, 285000), null);
  assert.equal(computeMarketCap("", 285000), null);
  assert.equal(computeMarketCap("abc", 285000), null);
  assert.equal(computeMarketCap("0", 285000), null);
});

test("computeMarketCap — 가격 비정상 → null", () => {
  assert.equal(computeMarketCap("1000000", 0), null);
  assert.equal(computeMarketCap("1000000", NaN), null);
  assert.equal(computeMarketCap("1000000", -5), null);
});

test("formatMarketCap — null cap → 대시", () => {
  assert.equal(formatMarketCap(null, "KRW"), "—");
  assert.equal(formatMarketCap(null, "USD"), "—");
  assert.equal(formatMarketCap(NaN, "USD"), "—");
});

test("formatMarketCap — USD T/B/M 버킷", () => {
  // Apple 근사: 14,840,000,000주 × $250 = $3.71T
  assert.equal(formatMarketCap(computeMarketCap("14840000000", 250), "USD"), "$3.71T");
  assert.equal(formatMarketCap(850_200_000_000, "USD"), "$850.20B");
  assert.equal(formatMarketCap(5_000_000, "USD"), "$5.00M");
});

test("formatMarketCap — KRW 억/조 경계", () => {
  assert.equal(formatMarketCap(3_400 * 1e8, "KRW"), "3,400억"); // 3.4e11 < 1e12 → 억
  assert.equal(formatMarketCap(1.5 * 1e12, "KRW"), "1.5조"); // ≥1e12 → 조
});
