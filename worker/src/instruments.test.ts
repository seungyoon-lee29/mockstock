// instruments 영속화 단위 테스트(D12a/b) — 버퍼 단조성·mock 제외·upsert 계약(SQL 단조 가드).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { keyOf, type Tick } from "@mockstock/shared";
import { seedInstruments, tapTick, upsertLastPrices } from "./instruments";

const tick = (over: Partial<Tick> = {}): Tick => ({
  market: "US",
  symbol: "AAPL",
  price: 231.5,
  ts: 1_000,
  source: "finnhub",
  ...over,
});

const KEY = keyOf("US", "AAPL");

test("tapTick — 신규·최신 틱은 버퍼 갱신", () => {
  const buf = new Map<string, Tick>();
  tapTick(buf, tick({ ts: 1_000, price: 230 }));
  assert.equal(buf.get(KEY)?.price, 230);
  tapTick(buf, tick({ ts: 2_000, price: 231 })); // 더 최신 → 교체
  assert.equal(buf.get(KEY)?.price, 231);
});

test("tapTick — 늦게 도착한 옛 틱 무시(동일 ts 포함)", () => {
  const buf = new Map<string, Tick>();
  tapTick(buf, tick({ ts: 2_000, price: 231 }));
  tapTick(buf, tick({ ts: 1_000, price: 999 })); // 옛 틱
  tapTick(buf, tick({ ts: 2_000, price: 888 })); // 동일 ts
  assert.equal(buf.get(KEY)?.price, 231);
});

test("tapTick — mock 틱 제외(B4)", () => {
  const buf = new Map<string, Tick>();
  tapTick(buf, tick({ source: "mock" }));
  assert.equal(buf.size, 0);
});

// upsert 캡처용 가짜 db — insert 체인 인자만 기록(실 DB 불필요).
function fakeDb() {
  const captured: { rows?: any[]; cfg?: any; inserted: boolean } = { inserted: false };
  const db = {
    insert: () => ({
      values: (rows: any[]) => {
        captured.inserted = true;
        captured.rows = rows;
        return {
          onConflictDoUpdate: (cfg: any) => {
            captured.cfg = cfg;
            return Promise.resolve();
          },
          onConflictDoNothing: () => Promise.resolve(),
        };
      },
    }),
  };
  return { db: db as any, captured };
}

test("upsertLastPrices — 행 구성(numeric 문자열·ts→Date)·유니버스 밖 스킵", async () => {
  const { db, captured } = fakeDb();
  await upsertLastPrices(db, [
    tick({ ts: 5_000, price: 231.5 }),
    tick({ symbol: "NOPE-없는심볼" }), // 유니버스 밖 → 스킵
  ]);
  assert.equal(captured.rows?.length, 1);
  const row = captured.rows![0];
  assert.equal(row.lastPrice, "231.50"); // numeric은 문자열(float 금지, db.md)
  assert.deepEqual(row.lastPriceAt, new Date(5_000));
});

test("upsertLastPrices — 전부 유니버스 밖이면 DB 미접촉", async () => {
  const { db, captured } = fakeDb();
  await upsertLastPrices(db, [tick({ symbol: "NOPE" })]);
  assert.equal(captured.inserted, false);
});

test("upsertLastPrices — conflict target (market,symbol) + 단조 setWhere(기존 NULL은 항상 패배)", async () => {
  const { db, captured } = fakeDb();
  await upsertLastPrices(db, [tick()]);
  // conflict target 명시(D12b)
  const targets = captured.cfg.target.map((c: any) => c.name);
  assert.deepEqual(targets, ["market", "symbol"]);
  // setWhere: last_price_at IS NULL(시드 직후 — 항상 패배) OR excluded가 더 최신일 때만 갱신
  const { sql: where } = new PgDialect().sqlToQuery(captured.cfg.setWhere);
  assert.match(where, /"last_price_at" is null or excluded\.last_price_at > /i);
});

test("seedInstruments — 유니버스 전 종목(86)·onConflictDoNothing·기준선=seedPrice·lastPriceAt NULL", async () => {
  let seeded: any[] | undefined;
  const db = {
    insert: () => ({
      values: (rows: any[]) => {
        seeded = rows;
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  } as any;
  const n = await seedInstruments(db);
  assert.equal(n, 86); // KR 38 + US 48 (D6)
  assert.equal(seeded?.length, 86);
  const aapl = seeded!.find((r) => r.symbol === "AAPL");
  assert.equal(aapl.lastPrice, aapl.prevClose); // 초기 기준선 = seedPrice
  assert.equal(aapl.lastPriceAt, null); // 실틱 도착 전 — 단조 가드에서 항상 패배
  assert.equal(aapl.prevCloseDate, null);
});
