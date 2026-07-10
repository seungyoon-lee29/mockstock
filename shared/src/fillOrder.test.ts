// fillOrder 정산 불변식 테스트 — node:test + PGlite(인메모리 Postgres) + drizzle/pglite.
// shared/drizzle 마이그레이션 SQL을 그대로 적용한 뒤 시드하고, 실제 CAS/조건부 UPDATE/
// FOR UPDATE 경로를 태운다. PGlite는 단일 세션이라 진짜 동시성은 재현하지 못하므로,
// 40% 상한 재검증(⑥)은 순차 실행으로 "체결 시점 재검증 로직" 자체를 검증한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { accounts, orders, positions, seasons, users } from "./schema";
import { fillOrder, type FillInput } from "./fillOrder";
import { SEED_MONEY_KRW, SEED_MONEY_USD } from "./rules";

type DB = ReturnType<typeof drizzle>;

const SEED_KR = SEED_MONEY_KRW; // 1,000만 → 40% 상한 = 400만
const SEED_US = SEED_MONEY_USD; // 1만 → 40% 상한 = 4천
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** 리그별 시즌 id + 시드. KR=원, US=달러 네이티브. */
const SEASON = { KR: "s_kr", US: "s_us" } as const;

/** numeric(_,2) 문자열 → 정수 센트(테스트 검증용 — 부동소수 비교 회피). 음수(realizedPnl 손실) 포함. */
function cents(v: string): number {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const c = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -c : c;
}

async function newDb(cashKr = SEED_KR, cashUs = SEED_US): Promise<DB> {
  const client = new PGlite();
  const db = drizzle(client);
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  await db.insert(users).values({ id: "u1", name: "테스터" });
  await db.insert(seasons).values([
    { id: SEASON.KR, market: "KR", startsAt: new Date("2026-07-01T00:00:00Z"), endsAt: new Date("2026-07-31T00:00:00Z"), seedMoney: String(SEED_KR) },
    { id: SEASON.US, market: "US", startsAt: new Date("2026-07-01T00:00:00Z"), endsAt: new Date("2026-07-31T00:00:00Z"), seedMoney: String(SEED_US) },
  ]);
  await db.insert(accounts).values([
    { userId: "u1", seasonId: SEASON.KR, cash: cashKr.toFixed(2) },
    { userId: "u1", seasonId: SEASON.US, cash: cashUs.toFixed(2) },
  ]);
  return db;
}

let seq = 0;
async function placeOrder(
  db: DB,
  seasonId: string,
  o: {
    market: "US" | "KR";
    symbol: string;
    side: "buy" | "sell";
    type?: "market" | "limit";
    qty: number;
    limitPrice?: number;
    reserved?: string;
  },
): Promise<string> {
  const id = `o${++seq}`;
  await db.insert(orders).values({
    id,
    userId: "u1",
    seasonId,
    market: o.market,
    symbol: o.symbol,
    side: o.side,
    type: o.type ?? "market",
    qty: String(o.qty),
    limitPrice: o.limitPrice != null ? String(o.limitPrice) : null,
    reserved: o.reserved ?? null,
    idempotencyKey: id,
  });
  return id;
}

function fill(db: DB, orderId: string, seasonId: string, i: Omit<FillInput, "orderId" | "userId" | "seasonId">) {
  return fillOrder(db, { orderId, userId: "u1", seasonId, ...i });
}

async function cashCents(db: DB, seasonId: string): Promise<number> {
  const [a] = await db.select().from(accounts).where(and(eq(accounts.userId, "u1"), eq(accounts.seasonId, seasonId)));
  return cents(a.cash);
}

async function pos(db: DB, seasonId: string, market: "US" | "KR", symbol: string) {
  const [p] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.seasonId, seasonId), eq(positions.market, market), eq(positions.symbol, symbol)));
  return p ?? null;
}

async function orderStatus(db: DB, id: string): Promise<string> {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o.status;
}

// ① 시장가 매수 성공 — 현금 차감 + costBasis 적립.
test("① 시장가 매수: 현금 차감·원가 적립", async () => {
  const db = await newDb();
  const id = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", qty: 3 });
  const r = await fill(db, id, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", orderType: "market", qty: 3, filledPrice: 75000 });
  assert.deepEqual(r, { ok: true, alreadyFilled: false });
  assert.equal(await cashCents(db, SEASON.KR), (SEED_KR - 225000) * 100);
  const p = (await pos(db, SEASON.KR, "KR", "005930"))!;
  assert.equal(cents(p.costBasis), 225000 * 100);
  assert.equal(Number(p.qty), 3);
});

// ② 잔액 부족 → rejected. 40% 상한(400만) 아래이지만 현금이 모자란 상황.
test("② 잔액 부족: insufficient-cash rejected", async () => {
  const db = await newDb(100_000, SEED_US);
  const id = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", qty: 2 });
  const r = await fill(db, id, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", orderType: "market", qty: 2, filledPrice: 75000 });
  assert.deepEqual(r, { ok: false, reason: "insufficient-cash" });
  assert.equal(await cashCents(db, SEASON.KR), 100_000 * 100); // 현금 불변
  assert.equal(await pos(db, SEASON.KR, "KR", "005930"), null);
  assert.equal(await orderStatus(db, id), "rejected");
});

// ③ 같은 주문 2회 체결 → 두 번째는 CAS 0행 no-op.
test("③ 이중 체결 차단: 두 번째 fillOrder는 already-filled no-op", async () => {
  const db = await newDb();
  const id = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", qty: 2 });
  const args = { market: "KR" as const, symbol: "005930", side: "buy" as const, orderType: "market" as const, qty: 2, filledPrice: 75000 };
  const r1 = await fill(db, id, SEASON.KR, args);
  const afterFirst = await cashCents(db, SEASON.KR);
  const r2 = await fill(db, id, SEASON.KR, args);
  assert.deepEqual(r1, { ok: true, alreadyFilled: false });
  assert.deepEqual(r2, { ok: false, reason: "already-filled" });
  assert.equal(await cashCents(db, SEASON.KR), afterFirst); // 두 번째가 아무 것도 바꾸지 않음
  assert.equal(Number((await pos(db, SEASON.KR, "KR", "005930"))!.qty), 2);
});

// ④ 부분 매도 — 수량 비례 원가 차감 + realizedPnl(네이티브 USD, fxRate 없음).
test("④ 부분 매도: 비례 원가 차감·realizedPnl", async () => {
  const db = await newDb();
  const buy = await placeOrder(db, SEASON.US, { market: "US", symbol: "AAPL", side: "buy", qty: 4 });
  await fill(db, buy, SEASON.US, { market: "US", symbol: "AAPL", side: "buy", orderType: "market", qty: 4, filledPrice: 230 });
  // 매수원가 = 230×4 = 920 USD
  const sell = await placeOrder(db, SEASON.US, { market: "US", symbol: "AAPL", side: "sell", qty: 2 });
  const r = await fill(db, sell, SEASON.US, { market: "US", symbol: "AAPL", side: "sell", orderType: "market", qty: 2, filledPrice: 250 });
  assert.deepEqual(r, { ok: true, alreadyFilled: false });
  // 매도대금 = 250×2 = 500 / 차감원가 = 920×2/4 = 460 / realized = 40
  const p = (await pos(db, SEASON.US, "US", "AAPL"))!;
  assert.equal(Number(p.qty), 2);
  assert.equal(cents(p.costBasis), 460 * 100);
  assert.equal(cents(p.realizedPnl), 40 * 100);
  assert.equal(await cashCents(db, SEASON.US), (SEED_US - 920 + 500) * 100);
});

// ⑤ 지정가 매수 — 예약 소진 + 유리한 체결가 차액 환급(USD 네이티브).
test("⑤ 지정가 매수: 예약 소진 + 차액 환급", async () => {
  const db = await newDb();
  // 접수: 지정가 240×2 = 480 예약(현금 선차감).
  const reservedAmt = (240 * 2).toFixed(2);
  await db.update(accounts).set({ cash: (SEED_US - 480).toFixed(2) }).where(and(eq(accounts.userId, "u1"), eq(accounts.seasonId, SEASON.US)));
  const id = await placeOrder(db, SEASON.US, { market: "US", symbol: "AAPL", side: "buy", type: "limit", qty: 2, limitPrice: 240, reserved: reservedAmt });
  // 체결: 더 유리한 230에 도달 → 실체결 230×2 = 460, 차액 20 환급.
  const r = await fill(db, id, SEASON.US, { market: "US", symbol: "AAPL", side: "buy", orderType: "limit", qty: 2, filledPrice: 230, reserved: reservedAmt });
  assert.deepEqual(r, { ok: true, alreadyFilled: false });
  assert.equal(await cashCents(db, SEASON.US), (SEED_US - 460) * 100); // 순차감 = 실체결액
  assert.equal(cents((await pos(db, SEASON.US, "US", "AAPL"))!.costBasis), 460 * 100);
  assert.equal(await orderStatus(db, id), "filled");
});

// ⑥ 40% 상한 재검증 — 한도(400만) 초과 두 번째 매수 rejected.
//    PGlite 단일 세션이라 동시성 대신 순차로 "체결 시점 재검증" 로직을 검증한다.
test("⑥ 40% 상한: 초과 두 번째 매수 over-limit rejected", async () => {
  const db = await newDb();
  const b1 = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", qty: 30 });
  await fill(db, b1, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", orderType: "market", qty: 30, filledPrice: 100_000 }); // 300만
  const b2 = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", qty: 20 });
  const r = await fill(db, b2, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", orderType: "market", qty: 20, filledPrice: 100_000 }); // +200만 → 500만 > 400만
  assert.deepEqual(r, { ok: false, reason: "over-limit" });
  assert.equal(cents((await pos(db, SEASON.KR, "KR", "005930"))!.costBasis), 3_000_000 * 100); // 불변
  assert.equal(await cashCents(db, SEASON.KR), (SEED_KR - 3_000_000) * 100);
  assert.equal(await orderStatus(db, b2), "rejected");
});

// ⑦ 보유 초과 매도 → insufficient-qty rejected.
test("⑦ 보유 초과 매도: insufficient-qty rejected", async () => {
  const db = await newDb();
  const buy = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", qty: 2 });
  await fill(db, buy, SEASON.KR, { market: "KR", symbol: "005930", side: "buy", orderType: "market", qty: 2, filledPrice: 75000 });
  const cashAfterBuy = await cashCents(db, SEASON.KR);
  const sell = await placeOrder(db, SEASON.KR, { market: "KR", symbol: "005930", side: "sell", qty: 5 });
  const r = await fill(db, sell, SEASON.KR, { market: "KR", symbol: "005930", side: "sell", orderType: "market", qty: 5, filledPrice: 80000 });
  assert.deepEqual(r, { ok: false, reason: "insufficient-qty" });
  assert.equal(await cashCents(db, SEASON.KR), cashAfterBuy); // 현금 불변
  assert.equal(Number((await pos(db, SEASON.KR, "KR", "005930"))!.qty), 2); // 보유 불변
  assert.equal(await orderStatus(db, sell), "rejected");
});

// ⑧-KR 불변식 — KR 리그 무작위 매수/매도 후 매 스텝:
//    cash + Σ costBasis ≡ seed + Σ realizedPnl (엄밀 등호, 정수 센트).
test("⑧-KR 정산 불변식(KR 리그): cash + Σ원가 ≡ seed + Σ realizedPnl", async () => {
  const db = await newDb();
  const seedCents = SEED_KR * 100;
  // 결정적 LCG(재현 가능). 시장가만 사용 → 예약 현금이 0이라 불변식이 순수형으로 성립.
  let state = 12345;
  const rnd = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const syms = [
    { s: "005930", base: 75_000 },
    { s: "000660", base: 210_000 },
  ];

  async function invariant() {
    const ps = await db.select().from(positions).where(eq(positions.seasonId, SEASON.KR));
    const costSum = ps.reduce((a, p) => a + cents(p.costBasis), 0);
    const realizedSum = ps.reduce((a, p) => a + cents(p.realizedPnl), 0);
    assert.equal(await cashCents(db, SEASON.KR) + costSum, seedCents + realizedSum);
  }

  for (let i = 0; i < 40; i++) {
    const sym = syms[Math.floor(rnd() * syms.length)];
    const buy = rnd() < 0.55;
    const qty = 1 + Math.floor(rnd() * 15);
    const price = Math.round(sym.base * (0.9 + rnd() * 0.2));
    const id = await placeOrder(db, SEASON.KR, { market: "KR", symbol: sym.s, side: buy ? "buy" : "sell", qty });
    await fill(db, id, SEASON.KR, {
      market: "KR",
      symbol: sym.s,
      side: buy ? "buy" : "sell",
      orderType: "market",
      qty,
      filledPrice: price,
    }); // 거절되면 상태 불변 → 불변식은 그대로 성립
    await invariant();
  }
});

// ⑧-US 불변식 — US 리그 네이티브 USD 무작위 매수/매도 후 매 스텝:
//    cash + Σ costBasis ≡ seed + Σ realizedPnl (엄밀 등호, 정수 센트).
test("⑧-US 정산 불변식(US 리그): cash + Σ원가 ≡ seed + Σ realizedPnl", async () => {
  const db = await newDb();
  const seedCents = SEED_US * 100;
  let state = 99999;
  const rnd = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const syms = [
    { s: "AAPL", base: 230 },
    { s: "MSFT", base: 480 },
  ];

  async function invariant() {
    const ps = await db.select().from(positions).where(eq(positions.seasonId, SEASON.US));
    const costSum = ps.reduce((a, p) => a + cents(p.costBasis), 0);
    const realizedSum = ps.reduce((a, p) => a + cents(p.realizedPnl), 0);
    assert.equal(await cashCents(db, SEASON.US) + costSum, seedCents + realizedSum);
  }

  for (let i = 0; i < 40; i++) {
    const sym = syms[Math.floor(rnd() * syms.length)];
    const buy = rnd() < 0.55;
    const qty = 1 + Math.floor(rnd() * 6);
    const price = Math.round(sym.base * (0.9 + rnd() * 0.2) * 100) / 100; // 소수점 2자리
    const id = await placeOrder(db, SEASON.US, { market: "US", symbol: sym.s, side: buy ? "buy" : "sell", qty });
    await fill(db, id, SEASON.US, {
      market: "US",
      symbol: sym.s,
      side: buy ? "buy" : "sell",
      orderType: "market",
      qty,
      filledPrice: price,
    }); // 거절되면 상태 불변 → 불변식은 그대로 성립
    await invariant();
  }
});
