// 상장주식수 파서 단위 테스트 — KR lstn_stcn(문자열 정수) + US shareOutstanding(백만 단위).
import { test } from "node:test";
import assert from "node:assert/strict";
import { millionsToShares } from "./sharesOutstanding";
import { parseShares } from "./candles/kisRest";

test("parseShares(KR lstn_stcn) — 정수 문자열·콤마·공백 정규화", () => {
  assert.equal(parseShares("5969782550"), "5969782550"); // 삼성전자 근사
  assert.equal(parseShares("0005969782550"), "5969782550"); // 선행 0 제거
  assert.equal(parseShares("1,234,567"), "1234567");
  assert.equal(parseShares(" 42 "), "42");
});

test("parseShares — 비수치·0·음수·소수 → null", () => {
  assert.equal(parseShares(null), null);
  assert.equal(parseShares(undefined), null);
  assert.equal(parseShares(""), null);
  assert.equal(parseShares("abc"), null);
  assert.equal(parseShares("0"), null);
  assert.equal(parseShares("-5"), null);
  assert.equal(parseShares("12.5"), null); // 소수점 불허(정수 주식수)
});

test("millionsToShares(US shareOutstanding, 백만 단위) — ×1e6 정수화", () => {
  // Finnhub profile2.shareOutstanding 은 백만 주 단위. 14840 → 14,840,000,000주
  assert.equal(millionsToShares(14840), "14840000000");
  assert.equal(millionsToShares(15.5), "15500000"); // 소수 백만 → 반올림 정수
  assert.equal(millionsToShares("2500"), "2500000000"); // 문자열도 허용
});

test("millionsToShares — 비수치·0·음수 → null", () => {
  assert.equal(millionsToShares(undefined), null);
  assert.equal(millionsToShares(null), null);
  assert.equal(millionsToShares(0), null);
  assert.equal(millionsToShares(-100), null);
  assert.equal(millionsToShares("nope"), null);
});
