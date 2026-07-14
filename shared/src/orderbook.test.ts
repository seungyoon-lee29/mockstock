// synthOrderbook 자기검증(표시 전용 mock book) — 정렬·최우선호가·KR 호가단위·결정성.
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthOrderbook, ORDERBOOK_LEVELS } from "./orderbook";
import { krTickSize } from "./mock";

test("KR synth — asks 오름차순 · bids 내림차순 · 최우선호가", () => {
  const price = 256500; // 삼성전자류(밴드 200k~500k → tick 500)
  const tick = krTickSize(price);
  const ob = synthOrderbook("KR", "005930", price, 0);

  assert.equal(ob.asks.length, ORDERBOOK_LEVELS);
  assert.equal(ob.bids.length, ORDERBOOK_LEVELS);
  assert.equal(ob.source, "synth");

  // asks 가격 오름차순, bids 가격 내림차순
  for (let i = 1; i < ORDERBOOK_LEVELS; i++) {
    assert.ok(ob.asks[i].price > ob.asks[i - 1].price, `asks[${i}] 오름차순 위배`);
    assert.ok(ob.bids[i].price < ob.bids[i - 1].price, `bids[${i}] 내림차순 위배`);
  }

  // 최우선 매도 = price+tick, 최우선 매수 = price
  assert.equal(ob.asks[0].price, price + tick);
  assert.equal(ob.bids[0].price, price);

  // 모든 KR 호가는 그 가격대 tick의 배수
  for (const lvl of [...ob.asks, ...ob.bids]) {
    assert.equal(lvl.price % krTickSize(lvl.price), 0, `${lvl.price} 호가단위 위배`);
  }
});

test("KR 호가단위 밴드 경계 — 중복·역전·교차 없음", () => {
  // 리뷰 지적: 256500(밴드 중앙)만 테스트하면 경계 불변식이 안 걸린다. tick이 바뀌는 경계값들을
  // 훑어 어떤 레벨도 중복/역전/스프레드 교차(최우선매도≤최우선매수)를 만들지 않음을 고정.
  for (const price of [2000, 5000, 20000, 50000, 200000, 500000, 199900, 499900]) {
    const ob = synthOrderbook("KR", "005930", price, 0);
    const asks = ob.asks.map((l) => l.price);
    const bids = ob.bids.map((l) => l.price);
    assert.equal(new Set(asks).size, asks.length, `price=${price} asks 중복`);
    assert.equal(new Set(bids).size, bids.length, `price=${price} bids 중복`);
    for (let i = 1; i < ORDERBOOK_LEVELS; i++) {
      assert.ok(asks[i] > asks[i - 1], `price=${price} asks 오름차순 위배`);
      assert.ok(bids[i] < bids[i - 1], `price=${price} bids 내림차순 위배`);
    }
    assert.ok(asks[0] > bids[0], `price=${price} 스프레드 교차`);
  }
});

test("qty 결정적 — 같은 인자 두 호출 동일", () => {
  const a = synthOrderbook("KR", "005930", 256500, 0);
  const b = synthOrderbook("KR", "005930", 256500, 999); // ts만 다름
  assert.deepEqual(
    a.asks.map((l) => l.qty),
    b.asks.map((l) => l.qty),
  );
  assert.deepEqual(
    a.bids.map((l) => l.qty),
    b.bids.map((l) => l.qty),
  );
});

test("비정상 가격 → 빈 호가", () => {
  assert.deepEqual(synthOrderbook("US", "AAPL", 0, 0).asks, []);
  assert.deepEqual(synthOrderbook("US", "AAPL", -1, 0).bids, []);
  assert.deepEqual(synthOrderbook("US", "AAPL", NaN, 0).asks, []);
});
