// 포트폴리오 조립 순수 로직 단위 테스트 — node:test + tsx, DB·네트워크 없이 실행.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolio,
  type FilledOrderRow,
  type OpenOrderRow,
  type PositionRow,
  type SeasonMetaRow,
} from "./portfolio";

const season: SeasonMetaRow = {
  id: "season_x",
  market: "KR",
  startsAt: new Date("2026-07-06T00:00:00.000Z"),
  endsAt: new Date("2026-07-10T06:30:00.000Z"),
  seedMoney: "10000000.00",
};

test("buildPortfolio: 셰이프 + Date→ISO + numeric 문자열 원문 유지", () => {
  const positions: PositionRow[] = [
    { market: "KR", symbol: "005930", qty: "10", costBasis: "700000.00", realizedPnl: "12345.00" },
    { market: "US", symbol: "AAPL", qty: "3", costBasis: "600000.00", realizedPnl: "0" },
  ];
  const openOrders: OpenOrderRow[] = [
    {
      id: "o1",
      market: "KR",
      symbol: "000660",
      side: "buy",
      type: "limit",
      qty: "5",
      limitPrice: "200000.00",
      reserved: "1000000.00",
      createdAt: new Date("2026-07-06T01:00:00.000Z"),
    },
  ];

  const trades: FilledOrderRow[] = [
    {
      id: "t1",
      market: "KR",
      symbol: "005930",
      side: "sell",
      type: "market",
      qty: "2",
      filledPrice: "71000.00",
      filledAt: new Date("2026-07-07T02:30:00.000Z"),
    },
  ];

  const r = buildPortfolio(season, "5000000.00", "1000000.00", "12345.00", positions, openOrders, trades);

  assert.equal(r.season.startsAt, "2026-07-06T00:00:00.000Z");
  assert.equal(r.season.seedMoney, "10000000.00");
  assert.equal(r.season.market, "KR");
  assert.equal(r.cash, "5000000.00"); // 원문 유지(반올림·재계산 금지)
  assert.equal(r.reserved, "1000000.00");
  assert.equal(r.realizedPnl, "12345.00");
  assert.equal(r.positions.length, 2);
  assert.equal(r.positions[0].costBasis, "700000.00");
  assert.equal(r.openOrders[0].createdAt, "2026-07-06T01:00:00.000Z");
  assert.equal(r.openOrders[0].limitPrice, "200000.00");
  assert.equal(r.openOrders[0].reserved, "1000000.00");
  // 거래내역 — filledAt Date→ISO, 숫자 문자열 원문 유지.
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, "sell");
  assert.equal(r.trades[0].filledPrice, "71000.00");
  assert.equal(r.trades[0].filledAt, "2026-07-07T02:30:00.000Z");
});

test("buildPortfolio: 계좌 미조인 → 시드머니 폴백, 집계 null → '0'", () => {
  const r = buildPortfolio(season, null, null, null, [], [], []);
  assert.equal(r.cash, "10000000.00"); // seedMoney 폴백
  assert.equal(r.reserved, "0");
  assert.equal(r.realizedPnl, "0");
  assert.deepEqual(r.positions, []);
  assert.deepEqual(r.openOrders, []);
  assert.deepEqual(r.trades, []);
});
