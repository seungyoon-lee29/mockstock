// 시즌 수명주기 테스트 — node:test + PGlite(인메모리 Postgres) + drizzle/pglite.
// fillOrder.test.ts와 동일하게 shared/drizzle 마이그레이션 SQL을 적용한 뒤 실제 CAS/트랜잭션
// 경로를 태운다. 단축 시즌은 durationMs cfg로, "만료"는 endsAt를 과거로 밀어 결정적으로 재현한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  instruments,
  orders,
  portfolioSnapshots,
  positions,
  seasonResults,
  seasons,
  users,
} from "./schema";
import {
  ensureActiveSeason,
  finalizeDueSeasons,
  maxDrawdownPct,
  monthlyPeriod,
  resetSeason,
  snapshotPortfolios,
  weeklyPeriod,
} from "./seasons";
import { fillOrder } from "./fillOrder";
import { SEED_MONEY, SEED_MONEY_KRW } from "./rules";

type DB = ReturnType<typeof drizzle>;

const SEED_KR = SEED_MONEY_KRW; // 1,000만 KRW
const SEED_US = SEED_MONEY.US;  // 10,000 USD
const CFG_KR = { seedMoney: SEED_KR, durationMs: 60_000 }; // KR 단축 시즌(1분 롤링)
const CFG_US = { seedMoney: SEED_US, durationMs: 60_000 }; // US 단축 시즌(1분 롤링)
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

function cents(v: string): number {
  const [i, f = ""] = v.replace("-", "").split(".");
  const c = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return v.startsWith("-") ? -c : c;
}

async function newDb(): Promise<DB> {
  const client = new PGlite();
  const db = drizzle(client);
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    await client.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  // 종목 마스터(평가용 lastPrice). fxRates 제거됨 — 네이티브 통화 직접 평가.
  await db.insert(instruments).values([
    { market: "KR", symbol: "005930", name: "삼성전자", currency: "KRW", lastPrice: "120000" },
    { market: "KR", symbol: "000660", name: "SK하이닉스", currency: "KRW", lastPrice: "180000" },
    { market: "US", symbol: "AAPL", name: "Apple", currency: "USD", lastPrice: "210" },
  ]);
  return db;
}

let seq = 0;
async function acct(db: DB, seasonId: string, userId: string, cash: number, isBot = false) {
  await db.insert(users).values({ id: userId, name: userId, isBot }).onConflictDoNothing();
  await db.insert(accounts).values({ userId, seasonId, cash: cash.toFixed(2) });
}
/** 시장가 매수를 fillOrder로 체결(현금 차감·포지션 적립). */
async function buy(db: DB, seasonId: string, userId: string, market: "US" | "KR", symbol: string, qty: number, price: number) {
  const id = `o${++seq}`;
  await db.insert(orders).values({ id, userId, seasonId, market, symbol, side: "buy", type: "market", qty: String(qty), idempotencyKey: id });
  await fillOrder(db, { orderId: id, userId, seasonId, market, symbol, side: "buy", orderType: "market", qty, filledPrice: price });
}
/** open 매수 지정가(예약 현금)를 삽입 + 계좌 현금 선차감(접수 시뮬레이션). 만료 스윕이 환불한다. */
async function reserveAmt(db: DB, seasonId: string, userId: string, reserved: number) {
  const id = `o${++seq}`;
  await db.insert(orders).values({ id, userId, seasonId, market: "KR", symbol: "005930", side: "buy", type: "limit", qty: "1", limitPrice: "1", reserved: reserved.toFixed(2), status: "open", idempotencyKey: id });
  await db.update(accounts).set({ cash: sql`${accounts.cash} - ${reserved.toFixed(2)}::numeric` }).where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)));
  return id;
}

async function expireNow(db: DB, seasonId: string) {
  await db.update(seasons).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(seasons.id, seasonId));
}
async function cashOf(db: DB, seasonId: string, userId: string): Promise<number> {
  const [a] = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)));
  return cents(a.cash);
}
async function resultsOf(db: DB, seasonId: string) {
  return db.select().from(seasonResults).where(eq(seasonResults.seasonId, seasonId));
}

// ── 순수 함수: MDD ─────────────────────────────────────────────────────────────
test("maxDrawdownPct: 표본 부족 0, peak 대비 최대 낙폭", () => {
  assert.equal(maxDrawdownPct([]), 0);
  assert.equal(maxDrawdownPct([100]), 0);
  assert.equal(maxDrawdownPct([100, 110, 99]), (110 - 99) / 110 * 100); // 10%
  assert.equal(maxDrawdownPct([100, 90, 120, 60]), (120 - 60) / 120 * 100); // 50%(회복 후 신저점)
});

// ⑦ US 금요일 경계: weeklyPeriod("US") endsAt이 금요일 16:00 ET 이후여야 한다(DST 양방향).
test("⑦ US 금요일 경계: endsAt이 미 동부 금 16:00(여름/겨울 DST) 이후", () => {
  // 여름 DST (EDT = UTC-4): 2026-07-10 금 14:00 ET = 18:00Z
  const summerDuring = new Date("2026-07-10T18:00:00Z");
  const summerPeriod = weeklyPeriod("US", summerDuring);
  // 금 16:00 EDT = 20:00Z
  assert.ok(
    summerPeriod.endsAt.getTime() >= new Date("2026-07-10T20:00:00Z").getTime(),
    `여름 endsAt(${summerPeriod.endsAt.toISOString()})이 2026-07-10T20:00:00Z 이상이어야 함`,
  );
  // 정확히 금 16:00 EDT = 20:00Z여야 함
  assert.equal(
    summerPeriod.endsAt.toISOString(),
    "2026-07-10T20:00:00.000Z",
    `여름 endsAt이 정확히 20:00Z여야 함, got: ${summerPeriod.endsAt.toISOString()}`,
  );

  // 겨울 EST (EST = UTC-5): 2026-01-09 금 14:00 ET = 19:00Z
  const winterDuring = new Date("2026-01-09T19:00:00Z");
  const winterPeriod = weeklyPeriod("US", winterDuring);
  // 금 16:00 EST = 21:00Z
  assert.ok(
    winterPeriod.endsAt.getTime() >= new Date("2026-01-09T21:00:00Z").getTime(),
    `겨울 endsAt(${winterPeriod.endsAt.toISOString()})이 2026-01-09T21:00:00Z 이상이어야 함`,
  );
  assert.equal(
    winterPeriod.endsAt.toISOString(),
    "2026-01-09T21:00:00.000Z",
    `겨울 endsAt이 정확히 21:00Z여야 함, got: ${winterPeriod.endsAt.toISOString()}`,
  );

  // KR 같은 주는 US보다 endsAt이 이르다(금 15:30 KST = 06:30Z vs US 금 20:00Z).
  const krPeriod = weeklyPeriod("KR", summerDuring);
  assert.ok(
    krPeriod.endsAt.getTime() < summerPeriod.endsAt.getTime(),
    `KR endsAt(${krPeriod.endsAt.toISOString()})이 US endsAt(${summerPeriod.endsAt.toISOString()})보다 이르야 함`,
  );

  // 시즌 id에 market이 인코딩되어야 한다.
  const krId = `season_${krPeriod.startsAt.toISOString()}:KR`;
  const usId = `season_${summerPeriod.startsAt.toISOString()}:US`;
  assert.ok(krId.includes(":KR"), "KR id에 :KR 포함");
  assert.ok(usId.includes(":US"), "US id에 :US 포함");
});

// ── monthlyPeriod: 월간(달력월) 경계 ─────────────────────────────────────────
test("monthlyPeriod KR: 일반 달 — start=1일 00:00 KST, end=말일 15:30 KST", () => {
  // 2026-07 (31일). now는 달 중간(7/15 정오 KST = 03:00Z).
  const now = new Date("2026-07-15T03:00:00Z");
  const p = monthlyPeriod("KR", now);
  // 1일 00:00 KST = 2026-06-30T15:00:00Z
  assert.equal(p.startsAt.toISOString(), "2026-06-30T15:00:00.000Z");
  // 7/31 15:30 KST = 2026-07-31T06:30:00Z
  assert.equal(p.endsAt.toISOString(), "2026-07-31T06:30:00.000Z");
});

test("monthlyPeriod KR: 12월 — 연 롤오버(start=12/1, end=12/31 15:30 KST)", () => {
  const now = new Date("2026-12-10T03:00:00Z");
  const p = monthlyPeriod("KR", now);
  assert.equal(p.startsAt.toISOString(), "2026-11-30T15:00:00.000Z"); // 12/1 00:00 KST
  assert.equal(p.endsAt.toISOString(), "2026-12-31T06:30:00.000Z"); // 12/31 15:30 KST
});

test("monthlyPeriod KR: 2월 윤년(2028)=29일 / 비윤년(2027)=28일", () => {
  const leap = monthlyPeriod("KR", new Date("2028-02-10T03:00:00Z"));
  assert.equal(leap.endsAt.toISOString(), "2028-02-29T06:30:00.000Z"); // 2028 윤년 → 29일
  const nonLeap = monthlyPeriod("KR", new Date("2027-02-10T03:00:00Z"));
  assert.equal(nonLeap.endsAt.toISOString(), "2027-02-28T06:30:00.000Z"); // 2027 비윤년 → 28일
});

test("monthlyPeriod US: end=말일 16:00 ET — 여름 EDT(GMT-4)·겨울 EST(GMT-5) 모두", () => {
  // 여름 달: 2026-07 → 7/31 16:00 EDT = 20:00Z
  const summer = monthlyPeriod("US", new Date("2026-07-15T03:00:00Z"));
  assert.equal(summer.startsAt.toISOString(), "2026-06-30T15:00:00.000Z"); // 7/1 00:00 KST
  assert.equal(summer.endsAt.toISOString(), "2026-07-31T20:00:00.000Z");
  // 겨울 달: 2026-01 → 1/31 16:00 EST = 21:00Z
  const winter = monthlyPeriod("US", new Date("2026-01-15T03:00:00Z"));
  assert.equal(winter.endsAt.toISOString(), "2026-01-31T21:00:00.000Z");
});

// currentPeriod는 비-export → ensureActiveSeason 경유로 경계·id 검증.
// durationMs 없으면 월간 경계, 있으면 롤링(불변) 경계여야 한다.
test("currentPeriod: durationMs 없으면 월간 경계(ensureActiveSeason 경유)", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, { seedMoney: SEED_KR }, "KR"); // durationMs 없음
  const p = monthlyPeriod("KR", new Date());
  assert.equal(season.startsAt.toISOString(), p.startsAt.toISOString());
  assert.equal(season.endsAt.toISOString(), p.endsAt.toISOString());
  assert.equal(season.id, `season_${p.startsAt.toISOString()}:KR`);
});

test("currentPeriod: durationMs 있으면 롤링 경계 불변(60s 단축 시즌)", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_KR, "KR"); // durationMs 60_000
  const span = season.endsAt.getTime() - season.startsAt.getTime();
  assert.equal(span, 60_000); // 롤링 길이 정확히 durationMs
  assert.equal(season.startsAt.getTime() % 60_000, 0); // durationMs 격자에 정렬
});

// ① KR 단축 시즌 풀사이클 — 생성→매매→만료→finalize(expire·환불·finalValue·rank).
test("① KR 풀사이클: 생성→매매→만료→확정(랭킹·환불·봇 제외)", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_KR, "KR");
  assert.equal(season.status, "active");
  assert.equal(season.market, "KR");
  assert.ok(season.id.endsWith(":KR"), `시즌 id에 :KR 인코딩, got: ${season.id}`);

  await acct(db, season.id, "u1", SEED_KR);
  await acct(db, season.id, "u2", SEED_KR);
  await acct(db, season.id, "b1", SEED_KR, true); // 봇

  await buy(db, season.id, "u1", "KR", "005930", 10, 100_000); // cash 9,000,000 / hold 10×120,000
  await reserveAmt(db, season.id, "u1", 500_000); // cash 8,500,000, open 예약
  await buy(db, season.id, "u2", "KR", "000660", 5, 200_000); // cash 9,000,000 / hold 5×180,000
  await reserveAmt(db, season.id, "b1", 300_000); // 봇도 예약(만료 환불 검증용)

  await expireNow(db, season.id);
  const done = await finalizeDueSeasons(db);
  assert.deepEqual(done, [season.id]);

  const [s] = await db.select().from(seasons).where(eq(seasons.id, season.id));
  assert.equal(s.status, "finalized");

  // open 예약 만료 + 환불 → cash 복원.
  assert.equal(await cashOf(db, season.id, "u1"), 9_000_000 * 100);
  assert.equal(await cashOf(db, season.id, "b1"), SEED_KR * 100);

  const rows = (await resultsOf(db, season.id)).sort((a, b) => a.rank - b.rank);
  assert.equal(rows.length, 2); // 봇 제외
  // u1: 9,000,000 + 10×120,000 = 10,200,000 (+2.00%) / u2: 9,000,000 + 5×180,000 = 9,900,000 (-1.00%)
  assert.equal(rows[0].userId, "u1");
  assert.equal(rows[0].rank, 1);
  assert.equal(cents(rows[0].finalValue), 10_200_000 * 100);
  assert.equal(rows[0].returnPct, "2.00");
  assert.equal(rows[1].userId, "u2");
  assert.equal(cents(rows[1].finalValue), 9_900_000 * 100);
  assert.equal(rows[1].returnPct, "-1.00");
});

// ① US 단축 시즌 풀사이클 — USD 네이티브(환산 없음) finalValue 검증.
test("① US 풀사이클: USD 네이티브 단축 시즌 생성→매매→만료→확정", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_US, "US");
  assert.equal(season.status, "active");
  assert.equal(season.market, "US");
  assert.ok(season.id.endsWith(":US"), `시즌 id에 :US 인코딩, got: ${season.id}`);

  await acct(db, season.id, "uA", SEED_US);
  await acct(db, season.id, "uB", SEED_US);

  // uA: AAPL 10주 매수(필 price $200), lastPrice=$210 → 보유가치 $2,100
  await buy(db, season.id, "uA", "US", "AAPL", 10, 200);
  // uB: 현금 그대로
  // uA: cash = 10,000 - 2,000 = 8,000 + 보유 2,100 = 10,100 (+1.00%)
  // uB: cash = 10,000 (+0.00%)

  await expireNow(db, season.id);
  const done = await finalizeDueSeasons(db);
  assert.deepEqual(done, [season.id]);

  const rows = (await resultsOf(db, season.id)).sort((a, b) => a.rank - b.rank);
  assert.equal(rows.length, 2);
  // uA: 8,000 + 10×210 = 10,100 (+1.00%)
  assert.equal(rows[0].userId, "uA");
  assert.equal(cents(rows[0].finalValue), 10_100 * 100);
  assert.equal(rows[0].returnPct, "1.00");
  assert.equal(rows[1].userId, "uB");
  assert.equal(cents(rows[1].finalValue), SEED_US * 100);
  assert.equal(rows[1].returnPct, "0.00");
});

// ① 두 리그 동시 active — 교차 오염 없음(KR 확정이 US에 영향 없음).
test("① 두 리그 동시 active: finalize 교차 오염 없음", async () => {
  const db = await newDb();
  const krSeason = await ensureActiveSeason(db, CFG_KR, "KR");
  const usSeason = await ensureActiveSeason(db, CFG_US, "US");

  await acct(db, krSeason.id, "k1", SEED_KR);
  await acct(db, usSeason.id, "u1", SEED_US);
  await buy(db, krSeason.id, "k1", "KR", "005930", 1, 100_000);
  await buy(db, usSeason.id, "u1", "US", "AAPL", 1, 200);

  // KR만 만료
  await expireNow(db, krSeason.id);
  const done = await finalizeDueSeasons(db);
  assert.deepEqual(done, [krSeason.id]); // KR만 확정

  const [kr] = await db.select().from(seasons).where(eq(seasons.id, krSeason.id));
  const [us] = await db.select().from(seasons).where(eq(seasons.id, usSeason.id));
  assert.equal(kr.status, "finalized");
  assert.equal(us.status, "active"); // US는 영향 없음

  // KR 결과만 있음
  const krResults = await resultsOf(db, krSeason.id);
  const usResults = await resultsOf(db, usSeason.id);
  assert.equal(krResults.length, 1);
  assert.equal(usResults.length, 0); // US는 아직 확정 전
});

// ② finalize 2회 멱등 — 두 번째 스윕은 no-op(재환불·중복 랭킹 없음).
test("② finalize 멱등: 재실행은 no-op(이중 환불·중복 랭킹 없음)", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_KR, "KR");
  await acct(db, season.id, "u1", SEED_KR);
  await reserveAmt(db, season.id, "u1", 500_000);
  await expireNow(db, season.id);

  const first = await finalizeDueSeasons(db);
  assert.deepEqual(first, [season.id]);
  const cashAfter = await cashOf(db, season.id, "u1");
  const resAfter = (await resultsOf(db, season.id)).length;

  const second = await finalizeDueSeasons(db);
  assert.deepEqual(second, []); // 이미 finalized → 스윕 대상 아님
  assert.equal(await cashOf(db, season.id, "u1"), cashAfter); // 재환불 없음
  assert.equal((await resultsOf(db, season.id)).length, resAfter);
});

// ③ KR reset 멱등 — 신규 시즌 생성 + 직전 로스터 시드 재설정, 재실행해도 중복/재설정 흔들림 없음.
test("③ KR reset 멱등: 신규 시즌 + 로스터 시드 재설정", async () => {
  const db = await newDb();
  // 직전(확정된) KR 시즌 + 매매로 줄어든 계좌.
  await db.insert(seasons).values({ id: "sp", market: "KR", startsAt: new Date(Date.now() - 600_000), endsAt: new Date(Date.now() - 300_000), seedMoney: SEED_KR.toFixed(2), status: "finalized" });
  await acct(db, "sp", "u1", 3_000_000);
  await buy(db, "sp", "u1", "KR", "005930", 1, 100_000);

  const s1 = await resetSeason(db, CFG_KR, "KR");
  assert.notEqual(s1.id, "sp");
  assert.equal(s1.market, "KR");
  assert.ok(s1.id.endsWith(":KR"), `reset 후 시즌 id에 :KR, got: ${s1.id}`);
  assert.equal(await cashOf(db, s1.id, "u1"), SEED_KR * 100); // 신규 시즌 시드 재설정
  const posNew = await db.select().from(positions).where(eq(positions.seasonId, s1.id));
  assert.equal(posNew.length, 0); // 클린 슬레이트

  const s2 = await resetSeason(db, CFG_KR, "KR");
  assert.equal(s2.id, s1.id); // 같은 기간 → 같은 시즌(멱등)
  assert.equal(await cashOf(db, s1.id, "u1"), SEED_KR * 100);
  const active = await db.select().from(seasons).where(eq(seasons.status, "active"));
  assert.equal(active.length, 1); // 이중 생성 없음
});

// ③ reset 교차 리그 격리 — KR reset이 US 직전 시즌 로스터를 오염시키지 않음.
test("③ reset 교차 리그 격리: KR reset이 US 로스터에 영향 없음", async () => {
  const db = await newDb();
  // US 확정 시즌
  await db.insert(seasons).values({ id: "us-prior", market: "US", startsAt: new Date(Date.now() - 600_000), endsAt: new Date(Date.now() - 300_000), seedMoney: SEED_US.toFixed(2), status: "finalized" });
  await acct(db, "us-prior", "uU", SEED_US);
  // KR 확정 시즌
  await db.insert(seasons).values({ id: "kr-prior", market: "KR", startsAt: new Date(Date.now() - 600_000), endsAt: new Date(Date.now() - 300_000), seedMoney: SEED_KR.toFixed(2), status: "finalized" });
  await acct(db, "kr-prior", "uK", SEED_KR);

  // KR reset — US 로스터는 이관되지 않아야 함
  const krNew = await resetSeason(db, CFG_KR, "KR");
  const usAccounts = await db.select().from(accounts).where(eq(accounts.seasonId, krNew.id));
  const userIds = usAccounts.map((a) => a.userId);
  assert.ok(!userIds.includes("uU"), "US 유저가 KR 새 시즌에 이관되면 안 됨");
  assert.ok(userIds.includes("uK"), "KR 유저는 KR 새 시즌에 이관됨");
});

// ④ 취소·만료 경합 — 이미 취소된 예약은 만료 스윕이 재환불하지 않는다(CAS WHERE status='open').
test("④ 취소·만료 경합: 취소된 주문은 이중 환불 불가", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_KR, "KR");
  await acct(db, season.id, "u1", SEED_KR);
  // 취소된 지정가(예약 현금은 취소 시 이미 환불되었다고 가정 — 여기선 현금 선차감을 하지 않음).
  await db.insert(orders).values({ id: "ocx", userId: "u1", seasonId: season.id, market: "KR", symbol: "005930", side: "buy", type: "limit", qty: "1", limitPrice: "1", reserved: (700_000).toFixed(2), status: "cancelled", idempotencyKey: "ocx" });
  const before = await cashOf(db, season.id, "u1");

  await expireNow(db, season.id);
  await finalizeDueSeasons(db);

  assert.equal(await cashOf(db, season.id, "u1"), before); // 취소분 재환불 없음
  const [o] = await db.select().from(orders).where(eq(orders.id, "ocx"));
  assert.equal(o.status, "cancelled"); // 만료로 덮이지 않음
});

// ⑤ 스냅샷 — totalValue = cash + open매수 예약 + 보유 평가액(예약 포함, §4.1).
test("⑤ snapshotPortfolios: 예약 현금 포함 총자산 기록", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_KR, "KR");
  await acct(db, season.id, "u1", SEED_KR);
  await buy(db, season.id, "u1", "KR", "005930", 10, 100_000); // cash 9,000,000 / hold 10×120,000
  await reserveAmt(db, season.id, "u1", 500_000); // cash 8,500,000 + 예약 500,000

  const n = await snapshotPortfolios(db);
  assert.equal(n, 1);
  const [snap] = await db.select().from(portfolioSnapshots).where(eq(portfolioSnapshots.seasonId, season.id));
  // 8,500,000 + 500,000(예약) + 1,200,000(보유) = 10,200,000
  assert.equal(cents(snap.totalValue), 10_200_000 * 100);
});

// ⑥ 동률 타이브레이커 — 같은 수익률이면 MDD 낮은 쪽이 상위(§4.2).
test("⑥ 랭킹 타이브레이커: 동률 시 MDD 낮은 쪽 상위", async () => {
  const db = await newDb();
  const season = await ensureActiveSeason(db, CFG_KR, "KR");
  await acct(db, season.id, "u1", 10_500_000); // 둘 다 +5%, 포지션 없음
  await acct(db, season.id, "u2", 10_500_000);
  // u1 MDD 10%(11,000,000→9,900,000), u2 MDD 5%(10,500,000→9,975,000).
  const snap = (userId: string, date: string, v: number) => ({ userId, seasonId: season.id, date, totalValue: v.toFixed(2) });
  await db.insert(portfolioSnapshots).values([
    snap("u1", "2026-07-06", 10_000_000), snap("u1", "2026-07-07", 11_000_000), snap("u1", "2026-07-08", 9_900_000),
    snap("u2", "2026-07-06", 10_000_000), snap("u2", "2026-07-07", 10_500_000), snap("u2", "2026-07-08", 9_975_000),
  ]);

  await expireNow(db, season.id);
  await finalizeDueSeasons(db);
  const rows = (await resultsOf(db, season.id)).sort((a, b) => a.rank - b.rank);
  assert.equal(rows[0].userId, "u2"); // 같은 +5%지만 MDD 5% < 10%
  assert.equal(rows[0].mdd, "5.00");
  assert.equal(rows[1].userId, "u1");
  assert.equal(rows[1].mdd, "10.00");
});
