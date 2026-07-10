// 지정가 접수·취소·환불 트랜잭션 테스트 — node:test + PGlite(인메모리 Postgres) + drizzle/pglite.
// shared/drizzle 마이그레이션을 그대로 적용한 뒤 실제 예약 차감·40% 1차 검증·CAS 취소/환불 경로를 태운다.
// (fillOrder.test.ts와 동일 관례 — web은 이 디렉터리 *.test.ts 를 tsx --test 로 실행.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { SEED_MONEY } from "@mockstock/shared";
import { accounts, orders, positions, seasons, users } from "@mockstock/shared/schema";
import { cancelOrder, placeLimitOrder } from "./limit";

type DB = ReturnType<typeof drizzle>;

const SEED_KR = SEED_MONEY.KR; // 1,000만 KRW → 40% 상한 = 400만
const SEED_US = SEED_MONEY.US; // 10,000 USD → 40% 상한 = 4,000
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../shared/drizzle");

function cents(v: string): number {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const c = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -c : c;
}

async function newDb(cash = SEED_KR, market: "KR" | "US" = "KR"): Promise<DB> {
  const seed = market === "KR" ? SEED_KR : SEED_US;
  const actualCash = cash === SEED_KR && market === "US" ? SEED_US : cash;
  const client = new PGlite();
  const db = drizzle(client);
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  await db.insert(users).values({ id: "u1", name: "테스터" });
  await db.insert(users).values({ id: "u2", name: "다른사람" });
  await db.insert(seasons).values({
    id: "s1",
    market,
    startsAt: new Date("2026-07-01T00:00:00Z"),
    endsAt: new Date("2026-07-31T00:00:00Z"),
    seedMoney: String(seed),
  });
  await db.insert(accounts).values({ userId: "u1", seasonId: "s1", cash: actualCash.toFixed(2) });
  return db;
}

let seq = 0;
function oid(): string {
  return `o${++seq}`;
}

function place(
  db: DB,
  o: { market: "US" | "KR"; symbol: string; side: "buy" | "sell"; qty: number; limitPrice: number },
  userId = "u1",
) {
  const id = oid();
  return placeLimitOrder(db, {
    orderId: id,
    userId,
    seasonId: "s1",
    ...o,
    idempotencyKey: id,
  }).then((r) => ({ id, r }));
}

async function cashCents(db: DB, userId = "u1"): Promise<number> {
  const [a] = await db.select().from(accounts).where(eq(accounts.userId, userId));
  return cents(a.cash);
}
async function getOrder(db: DB, id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o ?? null;
}

// ① 매수 접수 — 예상금액 예약 차감 + reserved 기록 + open.
test("① 매수 지정가 접수: 예약 차감·reserved 기록", async () => {
  const db = await newDb();
  const { id, r } = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 2, limitPrice: 74_000 });
  assert.deepEqual(r, { ok: true });
  assert.equal(await cashCents(db), (SEED_KR - 148_000) * 100); // 74000×2 예약
  const o = (await getOrder(db, id))!;
  assert.equal(o.status, "open");
  assert.equal(o.type, "limit");
  assert.equal(cents(o.reserved!), 148_000 * 100);
});

// ② US 매수 접수 — 네이티브 USD로 예약(fxRate 없음, §4.4 리그 분리).
test("② US 매수 지정가: 네이티브 USD 예약(reserved=460)", async () => {
  const db = await newDb(SEED_US, "US");
  const { id, r } = await place(db, { market: "US", symbol: "AAPL", side: "buy", qty: 2, limitPrice: 230 });
  assert.deepEqual(r, { ok: true });
  assert.equal(await cashCents(db), (SEED_US - 460) * 100); // 230×2=460 USD 예약(fx 없음)
  const o = (await getOrder(db, id))!;
  assert.equal(cents(o.reserved!), 460 * 100); // ponytail: 네이티브 USD — fx 곱 없음
});

// ③ 잔액 부족 — 예약 불가, 현금 불변, 주문 없음(롤백).
test("③ 매수 잔액 부족: insufficient-cash, 현금 불변·주문 없음", async () => {
  const db = await newDb(100_000);
  const { id, r } = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 2, limitPrice: 74_000 });
  assert.deepEqual(r, { ok: false, reason: "insufficient-cash" });
  assert.equal(await cashCents(db), 100_000 * 100);
  assert.equal(await getOrder(db, id), null);
});

// ④ 40% 상한 1차 검증 — 초과 접수 거절(§6.4).
test("④ 40% 상한 초과 접수: over-limit", async () => {
  const db = await newDb();
  const { id, r } = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 45, limitPrice: 100_000 }); // 450만 > 400만
  assert.deepEqual(r, { ok: false, reason: "over-limit" });
  assert.equal(await cashCents(db), SEED_KR * 100); // 차감 없음
  assert.equal(await getOrder(db, id), null);
});

// ⑤ 매수 예약이 40% 한도를 소진 — 두 번째 접수는 대기 예약까지 합산해 거절.
test("⑤ 대기 매수 예약 합산 40% 재검증", async () => {
  const db = await newDb();
  const a = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 30, limitPrice: 100_000 }); // 300만 예약
  assert.deepEqual(a.r, { ok: true });
  const b = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 20, limitPrice: 100_000 }); // +200만 → 500만 > 400만
  assert.deepEqual(b.r, { ok: false, reason: "over-limit" });
});

// ⑥ 매도 접수 — 보유 충분, 예약 컬럼 없음(reserved null).
test("⑥ 매도 지정가 접수: 보유 검증·예약 없음", async () => {
  const db = await newDb();
  await db.insert(positions).values({ userId: "u1", seasonId: "s1", market: "KR", symbol: "005930", qty: "5", costBasis: "350000.00" });
  const { id, r } = await place(db, { market: "KR", symbol: "005930", side: "sell", qty: 3, limitPrice: 80_000 });
  assert.deepEqual(r, { ok: true });
  const o = (await getOrder(db, id))!;
  assert.equal(o.status, "open");
  assert.equal(o.reserved, null);
  assert.equal(await cashCents(db), SEED_KR * 100); // 매도는 현금 변화 없음
});

// ⑦ 매도 보유 부족 — 기존 open 매도 qty 합산해 초과면 거절(§6.4).
test("⑦ 매도 보유 부족: open 매도 합산 insufficient-qty", async () => {
  const db = await newDb();
  await db.insert(positions).values({ userId: "u1", seasonId: "s1", market: "KR", symbol: "005930", qty: "5", costBasis: "350000.00" });
  const first = await place(db, { market: "KR", symbol: "005930", side: "sell", qty: 4, limitPrice: 80_000 });
  assert.deepEqual(first.r, { ok: true });
  const second = await place(db, { market: "KR", symbol: "005930", side: "sell", qty: 3, limitPrice: 80_000 }); // 5 − 4 = 1 < 3
  assert.deepEqual(second.r, { ok: false, reason: "insufficient-qty" });
});

// ⑧ 취소(매수) — 예약 환불 + status cancelled.
test("⑧ 매수 지정가 취소: 예약 환불·cancelled", async () => {
  const db = await newDb();
  const { id } = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 2, limitPrice: 74_000 });
  assert.equal(await cashCents(db), (SEED_KR - 148_000) * 100);
  const c = await cancelOrder(db, "u1", id);
  assert.deepEqual(c, { ok: true, refunded: true });
  assert.equal(await cashCents(db), SEED_KR * 100); // 환불
  assert.equal((await getOrder(db, id))!.status, "cancelled");
});

// ⑨ 취소(매도) — 예약 없음 → refunded:false, 현금 불변.
test("⑨ 매도 지정가 취소: refunded:false", async () => {
  const db = await newDb();
  await db.insert(positions).values({ userId: "u1", seasonId: "s1", market: "KR", symbol: "005930", qty: "5", costBasis: "350000.00" });
  const { id } = await place(db, { market: "KR", symbol: "005930", side: "sell", qty: 3, limitPrice: 80_000 });
  const c = await cancelOrder(db, "u1", id);
  assert.deepEqual(c, { ok: true, refunded: false });
  assert.equal((await getOrder(db, id))!.status, "cancelled");
});

// ⑩ 취소 방어 — 타인 주문·이미 취소된 주문은 no-op(이중 환불 불가).
test("⑩ 취소 방어: 타인·재취소는 ok:false, 환불 없음", async () => {
  const db = await newDb();
  const { id } = await place(db, { market: "KR", symbol: "005930", side: "buy", qty: 2, limitPrice: 74_000 });
  // 타인(u2)이 취소 시도 → 실패, 환불 없음.
  assert.deepEqual(await cancelOrder(db, "u2", id), { ok: false });
  assert.equal(await cashCents(db), (SEED_KR - 148_000) * 100);
  // 본인 취소 성공 후 재취소 → no-op(이중 환불 불가).
  assert.deepEqual(await cancelOrder(db, "u1", id), { ok: true, refunded: true });
  assert.deepEqual(await cancelOrder(db, "u1", id), { ok: false });
  assert.equal(await cashCents(db), SEED_KR * 100); // 환불 1회만
});
