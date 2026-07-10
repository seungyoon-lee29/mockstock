// 지정가 매칭 루프 (T08 §6.3·§7.7). 인메모리 open 캐시(부팅 로드 + web push + 장중 60초 재동기화)를
// 시세북과 대조해 도달 시 fillOrder 체결. DB status='open'이 진실, 캐시는 힌트 — CAS가 최종 안전망(B10).
//  · DATABASE_URL 없으면 스킵+경고(키 없는 mock 로컬 데모 npm run dev:worker 가 깨지지 않도록).
//  · 부팅 로드·재동기화는 seasons.status='active' 조인 필수(확정 시즌 체결 이중 차단, §4.1).
import { and, eq } from "drizzle-orm";
import { type Market, type Side } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import { fillOrder } from "@mockstock/shared/fillOrder";
import { orders, seasons } from "@mockstock/shared/schema";
import { config } from "./config";
import { getDb } from "./db";
import { matchDecision } from "./matchRule";
import type { PriceBook } from "./priceBook";

type Db = NonNullable<ReturnType<typeof getDb>>;

interface OpenOrder {
  id: string;
  userId: string;
  seasonId: string;
  market: Market;
  symbol: string;
  side: Side;
  qty: number;
  limitPrice: number;
  reserved: string | null;
}

/** web push 페이로드(§7.1 payload.order). 숫자는 numeric 문자열로 오지만 방어적으로 coerce. */
export interface SyncOrderInput {
  id: string;
  userId?: string;
  seasonId?: string;
  market?: Market;
  symbol?: string;
  side?: Side;
  qty?: number | string;
  limitPrice?: number | string | null;
  reserved?: string | null;
}

const MATCH_INTERVAL_MS = 2_000; // 캐시↔시세북 대조 주기(무DB, 저비용).
const RESYNC_INTERVAL_MS = 60_000; // 장중 DB 재동기화 주기(§7.7).

const cache = new Map<string, OpenOrder>();
let matchDb: Db | null = null; // syncOrder 게이트(DB 없으면 매칭 비활성 → push 무시).

/**
 * web 접수/취소 push 반영(§7.1). DB 없으면 no-op(mock 로컬).
 * upsert = open 지정가 캐시 반영, cancel = 캐시에서 제거. 캐시가 어긋나도 CAS가 이중 체결을 막는다.
 */
export function syncOrder(op: "upsert" | "cancel", order: SyncOrderInput): void {
  if (!matchDb) return;
  if (op === "cancel") {
    cache.delete(order.id);
    return;
  }
  // upsert — open 지정가 필수 필드 검증(미비 페이로드는 무시, 재동기화가 안전망).
  if (!order.market || !order.symbol || !order.side || order.qty == null || order.limitPrice == null) return;
  if (!order.userId || !order.seasonId) return;
  cache.set(order.id, {
    id: order.id,
    userId: order.userId,
    seasonId: order.seasonId,
    market: order.market,
    symbol: order.symbol,
    side: order.side,
    qty: Number(order.qty),
    limitPrice: Number(order.limitPrice),
    reserved: order.reserved ?? null,
  });
}

/** open 지정가 전량 재로드(§4.1 active 조인). */
async function resync(db: Db): Promise<void> {
  // §7.7 Neon 보존: 실 피드 장외엔 DB 미접촉. mock 피드거나 개장 중일 때만 재동기화.
  const now = new Date();
  const anyOpen =
    isMarketOpen("KR", now) ||
    isMarketOpen("US", now) ||
    config.feeds.KR === "mock" ||
    config.feeds.US === "mock";
  if (!anyOpen) return;

  const rows = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      seasonId: orders.seasonId,
      market: orders.market,
      symbol: orders.symbol,
      side: orders.side,
      qty: orders.qty,
      limitPrice: orders.limitPrice,
      reserved: orders.reserved,
    })
    .from(orders)
    .innerJoin(seasons, eq(orders.seasonId, seasons.id))
    .where(and(eq(orders.status, "open"), eq(orders.type, "limit"), eq(seasons.status, "active")));

  cache.clear();
  for (const r of rows) {
    if (r.limitPrice == null) continue; // 지정가인데 limitPrice 없으면 판정 불가 → 스킵.
    cache.set(r.id, {
      id: r.id,
      userId: r.userId,
      seasonId: r.seasonId,
      market: r.market,
      symbol: r.symbol,
      side: r.side,
      qty: Number(r.qty),
      limitPrice: Number(r.limitPrice),
      reserved: r.reserved,
    });
  }
}

/** 캐시 순회 — 도달 주문 체결. 결과 무관 종결 주문은 캐시에서 제거(DB가 진실). */
async function evaluate(db: Db, book: PriceBook): Promise<void> {
  if (cache.size === 0) return;
  const now = Date.now();
  for (const o of [...cache.values()]) {
    const decision = matchDecision(o.side, o.limitPrice, o.market, book.get(o.market, o.symbol), now);
    if (!decision.fill) continue;

    const result = await fillOrder(db, {
      orderId: o.id,
      userId: o.userId,
      seasonId: o.seasonId,
      market: o.market,
      symbol: o.symbol,
      side: o.side,
      orderType: "limit",
      qty: o.qty,
      filledPrice: decision.price,
      reserved: o.reserved ?? undefined,
    });

    cache.delete(o.id); // 체결·이미체결·거절 모두 종결 → 캐시에서 제거.
    if (result.ok) {
      console.log(`[matching] 체결 ${o.market}:${o.symbol} ${o.side} ${o.qty}@${decision.price}`);
    } else if (result.reason !== "already-filled") {
      console.log(`[matching] 거절 ${o.id} (${result.reason}) — 캐시 제거`);
    }
  }
}

/** 매칭 루프 시작. DATABASE_URL 없으면 스킵(경고). index.ts가 부팅 시 1회 호출. */
export function startMatching(book: PriceBook): void {
  const db = getDb();
  matchDb = db;
  if (!db) {
    console.warn("[matching] DATABASE_URL 미설정 — 지정가 매칭 스킵(mock 로컬 데모 모드)");
    return;
  }
  void resync(db); // 부팅 로드.
  const evalTimer = setInterval(() => void evaluate(db, book), MATCH_INTERVAL_MS);
  const resyncTimer = setInterval(() => void resync(db), RESYNC_INTERVAL_MS);
  evalTimer.unref?.();
  resyncTimer.unref?.();
  console.log(`[matching] 지정가 매칭 루프 시작 (대조 ${MATCH_INTERVAL_MS}ms · 재동기화 ${RESYNC_INTERVAL_MS}ms)`);
}
