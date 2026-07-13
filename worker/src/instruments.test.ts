// instruments 영속화 단위 테스트(D12a/b) — 버퍼 단조성·mock 제외·upsert 계약(SQL 단조 가드).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { keyOf, seedPriceOf, type Tick } from "@mockstock/shared";
import { seedInstruments, tapTick, upsertLastPrices, loadAnchors } from "./instruments";

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

// loadAnchors — 콜드 부팅 레이스 가드: 시드가와 같은 행(브리지 미착지)은 세지도 넣지도 않는다.
function anchorDb(rows: { market: "KR" | "US"; symbol: string; lastPrice: string | null }[]) {
  return { select: () => ({ from: () => Promise.resolve(rows) }) } as any;
}

test("loadAnchors — 시드가 그대로인 행은 카운트·앵커 제외(폴러 조기종료 방지)", async () => {
  const map = new Map<string, number>();
  // AAPL·005930 둘 다 아직 seedPrice(브리지 전) → n=0, map 비어야 함(폴러 계속 돔).
  const n = await loadAnchors(
    anchorDb([
      { market: "US", symbol: "AAPL", lastPrice: String(seedPriceOf("US", "AAPL")) },
      { market: "KR", symbol: "005930", lastPrice: String(seedPriceOf("KR", "005930")) },
    ]),
    map,
  );
  assert.equal(n, 0);
  assert.equal(map.size, 0);
});

test("loadAnchors — 브리지된(시드가와 다른) 값만 카운트·앵커 등록", async () => {
  const map = new Map<string, number>();
  const n = await loadAnchors(
    anchorDb([
      { market: "KR", symbol: "005930", lastPrice: "285000" }, // 브리지된 실 종가
      { market: "US", symbol: "AAPL", lastPrice: String(seedPriceOf("US", "AAPL")) }, // 아직 시드
      { market: "US", symbol: "TSLA", lastPrice: null }, // NULL → 스킵
    ]),
    map,
  );
  assert.equal(n, 1);
  assert.equal(map.get(keyOf("KR", "005930")), 285000);
  assert.equal(map.has(keyOf("US", "AAPL")), false);
});
