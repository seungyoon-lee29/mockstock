// baseline(D12c·d) 순수 로직 테스트 — buildBaselineMap 폴백/오버레이 + 키별 ts 병합.
// 주의: package.json test 글롭(src/lib/*.test.ts, src/lib/orders/*.test.ts)에 안 잡힌다.
// 실행: npx tsx --test src/lib/market/baseline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIVERSE, keyOf, seedPriceOf, toQuote, type Quote } from "@mockstock/shared";
import {
  applyBaseline,
  applyTicks,
  buildBaselineMap,
  type BaselineMap,
} from "./baseline";

const AAPL = keyOf("US", "AAPL");
const SEED_AAPL = seedPriceOf("US", "AAPL");
const T0 = Date.parse("2026-07-10T15:00:00Z");

test("buildBaselineMap: 로우 없으면(키리스 로컬) 전 종목 seedPrice 폴백", () => {
  const map = buildBaselineMap([], null);
  assert.equal(Object.keys(map).length, UNIVERSE.length);
  assert.deepEqual(map[AAPL], {
    market: "US",
    symbol: "AAPL",
    lastPrice: String(SEED_AAPL),
    prevClose: String(SEED_AAPL),
    lastPriceAt: null,
  });
});

test("buildBaselineMap: market 필터 — us만 남는다", () => {
  const map = buildBaselineMap([], "US");
  assert.ok(map[AAPL]);
  assert.equal(Object.values(map).some((b) => b.market === "KR"), false);
});

test("buildBaselineMap: instruments 로우가 seed 기저를 덮고, NULL 컬럼은 기저 유지", () => {
  const at = new Date(T0);
  const map = buildBaselineMap(
    [
      { market: "US", symbol: "AAPL", lastPrice: "231.50", prevClose: "228.00", lastPriceAt: at },
      { market: "US", symbol: "MSFT", lastPrice: null, prevClose: null, lastPriceAt: null },
    ],
    null,
  );
  assert.deepEqual(map[AAPL], {
    market: "US",
    symbol: "AAPL",
    lastPrice: "231.50",
    prevClose: "228.00",
    lastPriceAt: at.toISOString(),
  });
  // NULL 컬럼(시드 직후)은 seedPrice 기저 유지
  assert.equal(map[keyOf("US", "MSFT")].lastPrice, String(seedPriceOf("US", "MSFT")));
});

const base: BaselineMap = {
  [AAPL]: {
    market: "US",
    symbol: "AAPL",
    lastPrice: "231.50",
    prevClose: "228.00",
    lastPriceAt: new Date(T0).toISOString(),
  },
};

test("applyBaseline: 빈 맵 시드 — price=lastPrice, change=lastPrice−prevClose", () => {
  const out = applyBaseline({}, base);
  assert.deepEqual(out[AAPL], {
    market: "US",
    symbol: "AAPL",
    price: 231.5,
    prevClose: 228,
    change: 3.5,
    changePct: (3.5 / 228) * 100,
    ts: T0,
  });
});

test("applyBaseline: 더 최신 틱이 있으면 가격·ts 유지, prevClose 기준선만 교정", () => {
  const cur: Quote = toQuote({ market: "US", symbol: "AAPL", price: 233, ts: T0 + 1000 }, SEED_AAPL);
  const out = applyBaseline({ [AAPL]: cur }, base);
  assert.equal(out[AAPL].price, 233); // baseline lastPrice(231.50)로 되돌리지 않음
  assert.equal(out[AAPL].ts, T0 + 1000);
  assert.equal(out[AAPL].prevClose, 228); // 기준선은 baseline으로 교정
  assert.equal(out[AAPL].change, 5);
});

test("applyBaseline: prevClose 교정 분기가 quote.source를 보존한다(source 세탁 방지)", () => {
  const cur: Quote = toQuote(
    { market: "US", symbol: "AAPL", price: 233, ts: T0 + 1000, source: "mock" },
    SEED_AAPL,
  );
  const out = applyBaseline({ [AAPL]: cur }, base);
  assert.equal(out[AAPL].prevClose, 228); // 교정 분기를 탔는지 확인
  assert.equal(out[AAPL].source, "mock"); // 유실되면 mock이 차트 가드를 통과한다
});

test("applyBaseline: 더 오래된 quote는 baseline으로 대체 / 변화 없으면 참조 유지", () => {
  const stale: Quote = toQuote({ market: "US", symbol: "AAPL", price: 100, ts: T0 - 1000 }, 228);
  const out = applyBaseline({ [AAPL]: stale }, base);
  assert.equal(out[AAPL].price, 231.5);

  const same = applyBaseline(out, base); // 이미 반영됨 → 참조 그대로(리렌더 방지)
  assert.equal(same, out);
});

test("applyBaseline: lastPriceAt NULL은 최저 우선순위 — 어떤 기존 quote도 못 이긴다", () => {
  const noTs: BaselineMap = {
    [AAPL]: { ...base[AAPL], lastPriceAt: null },
  };
  const cur: Quote = toQuote({ market: "US", symbol: "AAPL", price: 233, ts: 1 }, 228);
  const out = applyBaseline({ [AAPL]: cur }, noTs);
  assert.equal(out[AAPL].price, 233);
  const seeded = applyBaseline({}, noTs); // 빈 자리는 채운다(ts=0)
  assert.equal(seeded[AAPL].price, 231.5);
  assert.equal(seeded[AAPL].ts, 0);
});

test("applyTicks: 최신 틱만 채택(역행·중복 차단), prevClose는 baseline 우선", () => {
  const prevCloses = { [AAPL]: 228 };
  const seeded = applyBaseline({}, base);
  const out = applyTicks(
    seeded,
    [{ market: "US", symbol: "AAPL", price: 234, ts: T0 + 2000 }],
    prevCloses,
  );
  assert.equal(out[AAPL].price, 234);
  assert.equal(out[AAPL].change, 6); // 기준선 = baseline prevClose(228), seedPrice 아님

  // 역행(과거 ts)·동일 ts 틱은 무시 → 참조 그대로
  const rewind = applyTicks(
    out,
    [
      { market: "US", symbol: "AAPL", price: 1, ts: T0 },
      { market: "US", symbol: "AAPL", price: 1, ts: T0 + 2000 },
    ],
    prevCloses,
  );
  assert.equal(rewind, out);
});

test("applyTicks: baseline 미도착이면 seedPrice 폴백으로 change 계산(하위호환)", () => {
  const out = applyTicks(
    {},
    [{ market: "US", symbol: "AAPL", price: SEED_AAPL + 2, ts: T0 }],
    {},
  );
  assert.equal(out[AAPL].prevClose, SEED_AAPL);
  assert.equal(out[AAPL].change, 2);
});
