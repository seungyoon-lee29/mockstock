// 테스트 러너(node:test + tsx) 동작 확인용 스모크. fillOrder 테스트는 T02b~에서 추가.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyOf } from "./types";

test("스모크: node:test 러너가 TS를 실행한다", () => {
  assert.equal(1 + 1, 2);
  assert.equal(keyOf("US", "AAPL"), "US:AAPL"); // TS 모듈 임포트도 로드되는지 확인
});
