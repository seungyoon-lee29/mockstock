// web 폴백 mock 스트림 틱 계약 — source:"mock"이 실려야 차트 mock 가드(isChartLiveSource)와
// 시장가 open 간주(validate.ts)가 worker mock 피드와 동일하게 동작한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "./priceSource";

test('snapshot: mock 틱에 source:"mock" 명시(가드 우회 회귀 방지)', () => {
  const ticks = snapshot([{ market: "US", symbol: "AAPL" }]);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].source, "mock");
});
