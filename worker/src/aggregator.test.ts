// 게이트 3종 자체검증(DB 미접촉): mock 제외(B4)·장중 게이트(B5)·롤오버 버퍼 적재.
// flush()는 IO라 여기서 안 건드림(start() 미호출 → 타이머·DB 없음). pendingCount로만 관찰.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarketOpen } from "@mockstock/shared/calendar";
import { CandleAggregator } from "./aggregator";

/** 휴장일 비결정성 제거 — 10:00 KST(=01:00 UTC)가 실제 개장인 평일을 탐색해 반환. */
function findOpenKrTs(): number {
  const d = new Date("2026-01-05T01:00:00Z");
  for (let i = 0; i < 400; i++) {
    if (isMarketOpen("KR", d)) return d.getTime();
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error("개장 평일을 찾지 못함");
}

test("mock 제외·장중 게이트·분 롤오버 버퍼 적재", () => {
  const openTs = findOpenKrTs();
  const agg = new CandleAggregator();

  // B4: mock 틱은 분 롤오버해도 버퍼에 안 쌓임.
  agg.add({ market: "KR", symbol: "005930", price: 100, ts: openTs, source: "mock" });
  agg.add({ market: "KR", symbol: "005930", price: 101, ts: openTs + 60_000, source: "mock" });
  assert.equal(agg.pendingCount, 0);

  // 실틱·장중: 다음 분 첫 틱에서 직전 분봉 완성 → 버퍼 1.
  agg.add({ market: "KR", symbol: "005930", price: 100, ts: openTs, source: "kis" });
  agg.add({ market: "KR", symbol: "005930", price: 101, ts: openTs + 60_000, source: "kis" });
  assert.equal(agg.pendingCount, 1);

  // B5: 장외 실틱은 폐기 → 버퍼 불변.
  const closedTs = openTs + 12 * 60 * 60 * 1000; // +12h → 22:00 KST(마감 후)
  assert.equal(isMarketOpen("KR", new Date(closedTs)), false);
  agg.add({ market: "KR", symbol: "000660", price: 50, ts: closedTs, source: "kis" });
  agg.add({ market: "KR", symbol: "000660", price: 51, ts: closedTs + 60_000, source: "kis" });
  assert.equal(agg.pendingCount, 1);
});
