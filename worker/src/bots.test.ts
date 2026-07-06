// 봇 결정 로직 자가 검증(순수 함수만 — DB 불필요). 실행: npx tsx --test worker/src/bots.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIVERSE, keyOf, type Tick, type UniverseEntry } from "@mockstock/shared";
import { botCountOf, buildBots, buyQty, decide } from "./bots";

test("botCountOf: 0 명시는 비활성(0), 미설정·비정상만 기본 3", () => {
  assert.equal(botCountOf("0"), 0); // 0은 유효값 — 봇 완전 비활성
  assert.equal(botCountOf(undefined), 3);
  assert.equal(botCountOf(""), 3);
  assert.equal(botCountOf("abc"), 3);
  assert.equal(botCountOf("-1"), 3);
  assert.equal(botCountOf("5"), 5);
});

const kr = (sym: string) => UNIVERSE.find((e) => e.market === "KR" && e.symbol === sym)!;
const priced = (e: UniverseEntry, price: number): { entry: UniverseEntry; tick: Tick } => ({
  entry: e,
  tick: { market: e.market, symbol: e.symbol, price, ts: Date.now(), source: "mock" },
});

test("buildBots: 기본 3개는 전략 1개씩, >3 이면 번호 순환", () => {
  const three = buildBots(3);
  assert.deepEqual(three.map((b) => b.name), ["랜덤봇", "모멘텀봇", "인덱스봇"]);
  assert.deepEqual(three.map((b) => b.strategy), ["random", "momentum", "index"]);
  const five = buildBots(5);
  assert.equal(five[3].name, "랜덤봇 2");
  assert.equal(five[3].id, "bot_random_2");
});

test("buyQty: 예산/원화가 내림, US는 환율 없으면 0", () => {
  const samsung = priced(kr("005930"), 75000); // 7.5만원
  assert.equal(buyQty(samsung, 0, 1_000_000), 13); // 100만 예산 → 13주
  const apple = priced(UNIVERSE.find((e) => e.market === "US" && e.symbol === "AAPL")!, 230);
  assert.equal(buyQty(apple, 0, 1_000_000), 0); // 환율 0 → US 스킵
  assert.equal(buyQty(apple, 1350, 1_000_000), 3); // 230*1350=310,500 → 3주
});

test("momentum: 상승 상위 매수 + 하락 보유 매도", () => {
  const bot = buildBots(3)[1]; // 모멘텀봇
  const up = kr("005930");
  const down = kr("000660");
  const market = [priced(up, up.seedPrice * 1.05), priced(down, down.seedPrice * 0.95)];
  const holdings = new Map([[`${bot.id}|${keyOf(down.market, down.symbol)}`, 7]]);
  const intents = decide(bot, market, holdings, 0, 1_000_000);
  const buy = intents.find((i) => i.side === "buy");
  const sell = intents.find((i) => i.side === "sell");
  assert.equal(buy?.entry.symbol, up.symbol); // 상승 종목 매수
  assert.equal(sell?.entry.symbol, down.symbol); // 하락 보유분 매도
  assert.equal(sell?.qty, 7); // 보유 전량
});

test("index: 시총 상위(유니버스 선두)만 매수, 하위 종목은 후보 제외", () => {
  const bot = buildBots(3)[2]; // 인덱스봇
  const low = kr("034730"); // KR 유니버스 말미 → 시총 상위 후보 아님
  const intents = decide(bot, [priced(low, low.seedPrice)], new Map(), 0, 1_000_000);
  assert.equal(intents.length, 0); // 후보 없음 → 주문 없음
});
