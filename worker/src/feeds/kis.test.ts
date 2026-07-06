// H0STCNT0 파서 회귀 테스트 — 필드 인덱스 off-by-one이면 KR 가격이 틀어짐(돈 정확성 경로).
// 실행: npx tsx --test worker/src/feeds/kis.test.ts. WS·네트워크·상태 무관, 합성 프레임만.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTradeFrame } from "./kis";

const N = 46; // 레코드당 필드 수(H0STCNT0). 이 상수가 바뀌면 테스트가 깨져 경보.

/** 46필드 레코드 1건 조립. 지정 인덱스만 값 세팅, 나머지는 필러. */
function record(fields: Record<number, string>): string {
  const f = Array<string>(N).fill("0");
  for (const [i, v] of Object.entries(fields)) f[Number(i)] = v;
  return f.join("^");
}
/** flag|tr_id|data_cnt|body 프레임 조립. */
function frame(body: string, count: number, trId = "H0STCNT0", flag = "0"): string {
  return `${flag}|${trId}|${count}|${body}`;
}

test("단일 레코드: symbol=[0], price=Number([2])", () => {
  const raw = frame(record({ 0: "005930", 1: "093000", 2: "74500" }), 1);
  assert.deepEqual(parseTradeFrame(raw), [{ symbol: "005930", price: 74500 }]);
});

test("다건(46×2, data_cnt=2): 레코드 2개로 정확 분리", () => {
  const body = record({ 0: "005930", 2: "74500" }) + "^" + record({ 0: "000660", 2: "120000" });
  assert.deepEqual(parseTradeFrame(frame(body, 2)), [
    { symbol: "005930", price: 74500 },
    { symbol: "000660", price: 120000 },
  ]);
});

test("필드 인덱스 회귀 가드: [0]=종목코드, [2]=가격 (이웃 필드 오인 방지)", () => {
  // [1]=093000(HHMMSS), [3]=74600(호가 등) 등 이웃에 가격처럼 보이는 값을 심어 off-by-one 유도.
  const raw = frame(record({ 0: "005930", 1: "093000", 2: "74500", 3: "74600" }), 1);
  const [rec] = parseTradeFrame(raw);
  assert.equal(rec.symbol, "005930"); // [1] "093000" 아님
  assert.equal(rec.price, 74500); // [1]→93000 도 [3]→74600 도 아님
});

test("제어/PINGPONG 프레임은 데이터로 오인하지 않음", () => {
  assert.deepEqual(parseTradeFrame(JSON.stringify({ header: { tr_id: "PINGPONG" } })), []);
  // flag는 '0'이나 tr_id가 H0STCNT0가 아닌 프레임(AES 체결통보 등)도 폐기.
  assert.deepEqual(parseTradeFrame(frame(record({ 0: "005930", 2: "74500" }), 1, "H0STCNI0")), []);
});
