// 유니버스 계약 테스트(D5·D6) — alias 검색·시장별 규모·키 유일성·기존 순서 보존(봇 TOPCAP=앞5 가정).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyOf } from "./types";
import { searchUniverse, UNIVERSE } from "./universe";

test("searchUniverse — 한국어 alias 부분일치(D5)", () => {
  assert.equal(searchUniverse("애플")[0]?.symbol, "AAPL");
  assert.equal(searchUniverse("마이크로")[0]?.symbol, "MSFT");
  assert.equal(searchUniverse("엔비디아")[0]?.symbol, "NVDA");
  assert.ok(searchUniverse("구글").some((e) => e.symbol === "GOOGL"));
  assert.ok(searchUniverse("에어비앤비").some((e) => e.symbol === "ABNB"));
});

test("searchUniverse — 기존 심볼·종목명 검색 유지", () => {
  assert.ok(searchUniverse("aapl").some((e) => e.symbol === "AAPL"));
  assert.ok(searchUniverse("삼성전자").some((e) => e.symbol === "005930"));
  assert.ok(searchUniverse("tesla").some((e) => e.symbol === "TSLA"));
});

test("유니버스 규모(D6) — KR 38 · US 48, 키 중복 없음", () => {
  assert.equal(UNIVERSE.filter((e) => e.market === "KR").length, 38);
  assert.equal(UNIVERSE.filter((e) => e.market === "US").length, 48);
  const keys = new Set(UNIVERSE.map((e) => keyOf(e.market, e.symbol)));
  assert.equal(keys.size, UNIVERSE.length);
});

test("기존 배열 순서 보존 — 시장별 앞 5개(봇 TOPCAP 가정) 불변", () => {
  const first5 = (m: string) =>
    UNIVERSE.filter((e) => e.market === m)
      .slice(0, 5)
      .map((e) => e.symbol);
  assert.deepEqual(first5("KR"), ["005930", "000660", "373220", "207940", "005380"]);
  assert.deepEqual(first5("US"), ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"]);
});

test("US 전 종목 한국어 alias 보유(D5)", () => {
  for (const e of UNIVERSE.filter((x) => x.market === "US")) {
    assert.ok(e.aliases && e.aliases.length > 0, `${e.symbol} alias 누락`);
  }
});
