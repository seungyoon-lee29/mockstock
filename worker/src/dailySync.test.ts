// 브리지 가드 단위 테스트 — daily_candles → instruments 앵커 upsert(실 DB 불필요, SQL 렌더 검증).
// 핵심 회귀 방지: 오늘의 실시간 lastPrice(lastPriceAt = 장중 실시각)를 거래일 자정 종가로 덮지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildBridgeQuery } from "./candles/dailySync";

function render(market: "KR" | "US"): string {
  return new PgDialect().sqlToQuery(buildBridgeQuery(market)).sql.toLowerCase();
}

test("buildBridgeQuery — instruments를 update하고 최근 2종가로 last/prev를 세팅", () => {
  const q = render("KR");
  assert.match(q, /update "instruments"/);
  assert.match(q, /last_price/);
  assert.match(q, /prev_close/);
  // 심볼별 최신 2행: row_number desc + r=1(최신)·r=2(전일) 조인
  assert.match(q, /row_number\(\) over/);
  assert.match(q, /order by date desc/);
});

test("buildBridgeQuery — 프로덕션 가드: 더 최신 실틱(lastPriceAt)은 덮지 않는다", () => {
  const q = render("KR");
  // WHERE 절 가드: 기존 last_price_at NULL(키리스 로컬)이거나 거래일 자정보다 옛 값일 때만 update.
  // 오늘의 실틱 lastPriceAt(장중 실시각) > 거래일 자정 → 조건 거짓 → 실가가 항상 이긴다.
  assert.match(q, /last_price_at is null or .*last_price_at < .*::timestamptz/);
});

test("buildBridgeQuery — prevClose는 prevCloseDate가 바뀔 때만 갱신(B7 멱등 관행)", () => {
  const q = render("US");
  assert.match(q, /prev_close_date is distinct from/);
  // 시장 스코프가 쿼리에 바인딩된다(KR/US 분리 실행).
  assert.match(render("US"), /"instruments"\."market"|i\.market|market" =|market =/);
});
