// instruments 시세 영속화(D12a/b) — 부팅 멱등 시드 + 실피드 lastPrice 단조 upsert.
//
// 게이트:
//  - B4 mock 제외: mock 틱은 영속화 안 함(tapTick에서 차단).
//  - B13 Neon 보존: flush는 DB 존재 + 개장 중일 때만. 유휴엔 DB 미접촉(autosuspend 유지).
//  - 단조성: ON CONFLICT DO UPDATE ... WHERE 로 옛 틱의 역행 차단 —
//    기존 last_price_at NULL(시드 직후)은 항상 패배, 그 외엔 excluded가 더 최신일 때만 갱신.
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getEntry, keyOf, UNIVERSE, type Tick } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import { instruments } from "@mockstock/shared/schema";
import { getDb } from "./db";

type Db = PgDatabase<any, any, any>;

const FLUSH_INTERVAL_MS = Number(process.env.LAST_PRICE_FLUSH_MS ?? 30_000);

/**
 * 부팅 멱등 시드(D12a) — UNIVERSE 전 종목을 instruments에 삽입. 기존 로우는 보존(onConflictDoNothing).
 * 초기 기준선: lastPrice·prevClose=seedPrice(근사 실가격), prevCloseDate·lastPriceAt=NULL
 * (크론 실종가·실틱이 도착하면 대체). 반환 = 시드 대상 종목 수.
 */
export async function seedInstruments(db: Db): Promise<number> {
  const rows = UNIVERSE.map((e) => ({
    market: e.market,
    symbol: e.symbol,
    name: e.name,
    currency: e.currency,
    prevClose: e.seedPrice.toFixed(2), // numeric — 문자열(float 금지, db.md)
    prevCloseDate: null,
    lastPrice: e.seedPrice.toFixed(2),
    lastPriceAt: null,
  }));
  await db.insert(instruments).values(rows).onConflictDoNothing();
  return rows.length;
}

/** 틱 버퍼 탭(순수) — mock 제외(B4), 심볼별 최신 ts만 유지(늦게 도착한 옛 틱은 버림). */
export function tapTick(buf: Map<string, Tick>, tick: Tick): void {
  if (tick.source === "mock") return;
  const key = keyOf(tick.market, tick.symbol);
  const prev = buf.get(key);
  if (prev && prev.ts >= tick.ts) return;
  buf.set(key, tick);
}

/**
 * lastPrice 단조 upsert(D12b) — conflict target (market,symbol) 명시.
 * 갱신 조건: 기존 last_price_at IS NULL(항상 패배) OR excluded.last_price_at이 더 최신.
 * 유니버스 밖 심볼은 방어적으로 스킵(시드 대상 아님 → name/currency 불명).
 */
export async function upsertLastPrices(db: Db, ticks: Iterable<Tick>): Promise<void> {
  const rows = [];
  for (const t of ticks) {
    const entry = getEntry(t.market, t.symbol);
    if (!entry) continue;
    rows.push({
      market: t.market,
      symbol: t.symbol,
      name: entry.name,
      currency: entry.currency,
      prevClose: entry.seedPrice.toFixed(2), // 신규 insert 경로 전용 — conflict 시 미갱신
      lastPrice: t.price.toFixed(2),
      lastPriceAt: new Date(t.ts),
    });
  }
  if (rows.length === 0) return;
  await db
    .insert(instruments)
    .values(rows)
    .onConflictDoUpdate({
      target: [instruments.market, instruments.symbol],
      set: {
        lastPrice: sql`excluded.last_price`,
        lastPriceAt: sql`excluded.last_price_at`,
      },
      setWhere: sql`${instruments.lastPriceAt} IS NULL OR excluded.last_price_at > ${instruments.lastPriceAt}`,
    });
}

/** 버퍼 flush — DB 없으면(키리스 로컬) no-op, 전 시장 마감이면 DB 미접촉(B13). */
export async function flushLastPrices(buf: Map<string, Tick>): Promise<void> {
  if (buf.size === 0) return;
  const db = getDb();
  if (!db) return; // DATABASE_URL 없음(mock 로컬) — 조용히 스킵
  const now = new Date();
  // B13: 유휴 시 버퍼 유지 → 다음 개장 flush로 지연 영속화(단조 가드가 역행을 막는다).
  if (!isMarketOpen("KR", now) && !isMarketOpen("US", now)) return;
  const batch = [...buf.values()];
  buf.clear();
  try {
    await upsertLastPrices(db, batch);
  } catch (e) {
    // ponytail: 재큐 없음 — 다음 30초 배치가 더 최신 값이라 이번 배치 유실은 무해.
    console.error("[instruments] lastPrice upsert 실패", e);
  }
}

/** 주기 flush 기동(aggregator flush와 동일 주기 관행) — 반환값 = 정지 함수. */
export function startLastPriceFlush(buf: Map<string, Tick>): () => void {
  const timer = setInterval(() => void flushLastPrices(buf), FLUSH_INTERVAL_MS);
  timer.unref?.(); // 타이머가 프로세스 종료를 막지 않게
  return () => clearInterval(timer);
}
