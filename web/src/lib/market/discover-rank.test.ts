// rankOrder 순수 정렬 테스트 — 같은 quotes·popular 입력에 순서 결정론적.
// 실행: npx tsx --test src/lib/market/discover-rank.test.ts (package.json test 글롭에 포함됨)
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyOf, type Market, type Quote } from "@mockstock/shared";
import { rankOrder } from "./discover-rank";

const E = (symbol: string, market: Market = "US") => ({ market, symbol });
const K = (symbol: string, market: Market = "US") => keyOf(market, symbol);
// 정렬은 changePct만 본다 — 최소 필드만 채운 Quote.
const q = (changePct: number): Quote =>
  ({ market: "US", symbol: "X", price: 0, prevClose: 0, change: 0, changePct, ts: 0 });

test("popular 순위 우선 — 체결 건수 순서 그대로", () => {
  const entries = [E("A"), E("B"), E("C")];
  const rankOf = new Map([[K("C"), 0], [K("A"), 1], [K("B"), 2]]);
  assert.deepEqual(rankOrder(entries, rankOf, {}), [K("C"), K("A"), K("B")]);
});

test("popular 비면 등락률 내림차순 폴백", () => {
  const entries = [E("A"), E("B"), E("C")];
  const quotes: Record<string, Quote> = {
    [K("A")]: q(5),
    [K("B")]: q(-10),
    [K("C")]: q(10),
  };
  assert.deepEqual(rankOrder(entries, new Map(), quotes), [
    K("C"),
    K("A"),
    K("B"),
  ]);
});

test("popular 있는 종목 먼저, 없는 종목은 등락률로 뒤에", () => {
  const entries = [E("A"), E("B"), E("C")];
  const rankOf = new Map([[K("A"), 0]]); // A만 인기
  const quotes: Record<string, Quote> = {
    [K("B")]: q(-10),
    [K("C")]: q(10),
  };
  assert.deepEqual(rankOrder(entries, rankOf, quotes), [K("A"), K("C"), K("B")]);
});

test("결정론적 — 같은 입력 두 번 호출 동일 결과", () => {
  const entries = [E("A"), E("B")];
  const quotes: Record<string, Quote> = { [K("A")]: q(1), [K("B")]: q(2) };
  const r1 = rankOrder(entries, new Map(), quotes);
  const r2 = rankOrder(entries, new Map(), quotes);
  assert.deepEqual(r1, r2);
});
