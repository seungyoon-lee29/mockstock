// 지정가 접수·취소 트랜잭션 (T08 §6.4·§6.3). 체결은 shared/fillOrder 단독 — 여기선 "예약·취소"만.
//  · 접수(매수): 예상금액(limit×fx×qty)을 조건부 원자 차감 + reservedKrw 기록(접수 트랜잭션).
//    US는 접수 시점 fxRate를 고정 기록(예약액=환불액 정합, §6.6). 40% 상한은 여기서 1차 검증
//    (체결 시 fillOrder가 FOR UPDATE로 재검증, §6.4).
//  · 접수(매도): 예약 컬럼 없이 `보유 qty − 해당 종목 open 매도 qty 합 ≥ 주문 qty` 서브쿼리 검증.
//    fxRate·reservedKrw는 null(매도는 체결 시점 환율, §6.6).
//  · 취소: status='open' CAS + RETURNING reserved_krw → 매수면 환불(단일 트랜잭션, db.md).
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { accounts, orders, positions, seasons } from "@mockstock/shared/schema";
import { POSITION_LIMIT_PCT, type Market, type Side } from "@mockstock/shared";

type Db = PgDatabase<any, any, any>;

// numeric(_,2) 문자열 ↔ 센트 정수 — fillOrder·seasons와 동일 규약(라운딩 누수 없는 합산).
// ponytail: 이 유틸은 shared 3파일에서 이미 각자 로컬 보유하는 확립된 패턴 — 지역 복제 유지.
function toCents(v: string): number {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const c = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -c : c;
}
function fromCents(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export interface PlaceLimitInput {
  orderId: string;
  userId: string;
  seasonId: string;
  market: Market;
  symbol: string;
  side: Side;
  qty: number;
  limitPrice: number;
  /** US 매수 지정가의 접수 시점 고정 환율(§6.6). KR=1. 매도는 무시(null 저장). */
  fxRate: number;
  idempotencyKey: string;
}

export type PlaceLimitResult =
  | { ok: true }
  | { ok: false; reason: "insufficient-cash" | "insufficient-qty" | "over-limit" };

/**
 * 지정가 주문을 접수한다(단일 트랜잭션). 성공 시 status='open' 주문 1건이 생긴다.
 * 멱등키 충돌(UNIQUE(user_id, key))은 insert에서 throw → 호출부가 원본 결과 멱등 재생(§6.1).
 */
export async function placeLimitOrder(db: Db, i: PlaceLimitInput): Promise<PlaceLimitResult> {
  const { orderId, userId, seasonId, market, symbol, side, qty, limitPrice, fxRate } = i;

  return db.transaction(async (tx): Promise<PlaceLimitResult> => {
    const posWhere = and(
      eq(positions.userId, userId),
      eq(positions.seasonId, seasonId),
      eq(positions.market, market),
      eq(positions.symbol, symbol),
    );

    if (side === "sell") {
      // 매도: 보유 − 해당 종목 open 매도 주문 qty 합 ≥ 주문 qty (예약 컬럼 없이 서브쿼리, §6.4).
      const [pos] = await tx.select({ qty: positions.qty }).from(positions).where(posWhere);
      const held = pos ? Number(pos.qty) : 0;
      const openSells = await tx
        .select({ qty: orders.qty })
        .from(orders)
        .where(
          and(
            eq(orders.userId, userId),
            eq(orders.seasonId, seasonId),
            eq(orders.market, market),
            eq(orders.symbol, symbol),
            eq(orders.side, "sell"),
            eq(orders.status, "open"),
          ),
        );
      const reservedQty = openSells.reduce((s, r) => s + Number(r.qty), 0);
      if (held - reservedQty < qty) return { ok: false, reason: "insufficient-qty" };

      await tx.insert(orders).values({
        id: orderId,
        userId,
        seasonId,
        market,
        symbol,
        side,
        type: "limit",
        qty: String(qty),
        limitPrice: String(limitPrice),
        fxRate: null, // 매도는 체결 시점 환율(§6.6) — 매칭 루프가 기록.
        reservedKrw: null,
        status: "open",
        idempotencyKey: i.idempotencyKey,
      });
      return { ok: true };
    }

    // 매수: 예상금액 예약. limit×fx×qty를 센트로 한 번만 반올림(현금·예약·환불 동일 값).
    const reservedCents = Math.round(limitPrice * fxRate * qty * 100);
    const reserved = fromCents(reservedCents);

    // 40% 상한 1차 검증(§6.4) — 기존 원가 + 대기 매수 예약 + 이번 예약 ≤ 시드×40%.
    const [season] = await tx.select({ seed: seasons.seedMoney }).from(seasons).where(eq(seasons.id, seasonId));
    const limitCents = Math.round(toCents(season.seed) * POSITION_LIMIT_PCT);
    const [pos] = await tx.select({ cost: positions.costBasisKrw }).from(positions).where(posWhere);
    const posCostCents = pos ? toCents(pos.cost) : 0;
    const openBuys = await tx
      .select({ reserved: orders.reservedKrw })
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          eq(orders.seasonId, seasonId),
          eq(orders.market, market),
          eq(orders.symbol, symbol),
          eq(orders.side, "buy"),
          eq(orders.status, "open"),
        ),
      );
    const openReservedCents = openBuys.reduce((s, r) => s + (r.reserved != null ? toCents(r.reserved) : 0), 0);
    if (posCostCents + openReservedCents + reservedCents > limitCents) {
      return { ok: false, reason: "over-limit" };
    }

    // 조건부 원자 차감: cash_krw -= reserved WHERE cash_krw >= reserved. 0행이면 잔액 부족.
    const deducted = await tx
      .update(accounts)
      .set({ cashKrw: sql`${accounts.cashKrw} - ${reserved}::numeric` })
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.seasonId, seasonId),
          sql`${accounts.cashKrw} >= ${reserved}::numeric`,
        ),
      )
      .returning({ cashKrw: accounts.cashKrw });
    if (deducted.length === 0) return { ok: false, reason: "insufficient-cash" };

    await tx.insert(orders).values({
      id: orderId,
      userId,
      seasonId,
      market,
      symbol,
      side,
      type: "limit",
      qty: String(qty),
      limitPrice: String(limitPrice),
      fxRate: String(fxRate), // 매수 지정가는 접수 시점 환율 고정(§6.6).
      reservedKrw: reserved,
      status: "open",
      idempotencyKey: i.idempotencyKey,
    });
    return { ok: true };
  });
}

export type CancelResult = { ok: true; refunded: boolean } | { ok: false };

/**
 * 지정가 주문 취소 — 본인 open 주문만. CAS(id AND user_id AND status='open') RETURNING reserved_krw →
 * 매수 예약이면 환불(단일 트랜잭션, §6.3). 취소·확정 expire 경합·재시도에도 이중 환불 불가.
 */
export async function cancelOrder(db: Db, userId: string, orderId: string): Promise<CancelResult> {
  return db.transaction(async (tx): Promise<CancelResult> => {
    const cancelled = await tx
      .update(orders)
      .set({ status: "cancelled" })
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId), eq(orders.status, "open")))
      .returning({ seasonId: orders.seasonId, reservedKrw: orders.reservedKrw });
    if (cancelled.length === 0) return { ok: false };

    const { seasonId, reservedKrw } = cancelled[0];
    if (reservedKrw == null) return { ok: true, refunded: false }; // 매도 지정가 등 예약 없음.

    await tx
      .update(accounts)
      .set({ cashKrw: sql`${accounts.cashKrw} + ${reservedKrw}::numeric` })
      .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)));
    return { ok: true, refunded: true };
  });
}
