// 체결 트랜잭션 단일 함수 — web(시장가)·worker(지정가)가 공용 호출(B9).
//
// 불변식 (PRD §6.2~§6.5 · .claude/rules/db.md):
//  ① 모든 상태 전이(fill·cancel·expire)는 status='open' CAS + RETURNING + 단일 트랜잭션.
//     첫 문장은 CAS — UPDATE orders SET status=.. WHERE id=$1 AND status='open'
//     RETURNING reserved_krw → 영향 행 0이면 이후 전부 스킵(이중 체결/재기동 방어, B10).
//     환불액은 RETURNING된 reserved_krw만 사용(호출부 재계산 금지).
//  ② 매도 체결은 현금 credit: cash_krw += 체결가 × fxRate × qty.
//  ③ 지정가 매수는 재차감 금지 — 접수 시 차감한 reserved_krw를 소진하고,
//     실체결액(체결가 × fxRate × qty)과의 차액만 cash_krw로 환급.
//     시장가 매수만 조건부 원자 차감: SET cash_krw = cash_krw - $x WHERE cash_krw >= $x.
//  ④ 40% 종목 편중 상한(A5)은 트랜잭션 내부 SELECT ... FOR UPDATE로 재검증(TOCTOU 차단).
//  ⑤ B12 회계 — costBasisKrw = 총 취득원가(KRW). 매수 += 체결가×fxRate×qty,
//     매도는 수량 비례 원가만 차감(costBasisKrw × 매도qty/보유qty),
//     realizedPnl += 매도대금(KRW) − 차감 원가(환차손익 포함).
//     원가를 주당 반올림하지 않고 총액으로 덜어내므로 Σ realizedPnl ≡ 현금 증감 정확히 성립.
//
// 비즈니스 실패는 throw 대신 FillResult 유니온으로 반환한다. 실패 경로는 실제 잔액/포지션을
// 건드리기 전(검증 우선)에 판정하므로, 실패 시엔 order.status='rejected'(+ 예약 환불)만
// 커밋하면 되고 별도 롤백이 필요 없다 — 성공/거절 모두 단일 트랜잭션 커밋으로 귀결.

import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { accounts, orders, positions, seasons } from "./schema";
import { POSITION_LIMIT_PCT } from "./rules";
import type { Market, Side } from "./types";

export interface FillInput {
  orderId: string;
  userId: string;
  seasonId: string;
  market: Market;
  symbol: string;
  side: Side;
  /** 시장가는 즉시 차감·체결, 지정가는 reservedKrw 예약분 소진 경로(위 불변식 ③). */
  orderType: "market" | "limit";
  qty: number;
  /** 체결가 (워커 스냅샷 또는 매칭 도달가). 클라이언트 값 금지. */
  filledPrice: number;
  /** US는 접수/체결 시점 고정 환율, KR은 1. */
  fxRate: number;
  /** 지정가 매수 접수 시 예약한 원본 금액(orders.reservedKrw). 차액 환급의 기준값. */
  reservedKrw?: string;
}

export type FillResult =
  | { ok: true; alreadyFilled: false }
  | {
      ok: false;
      reason: "already-filled" | "insufficient-cash" | "insufficient-qty" | "over-limit";
    };

// numeric(_,2) 문자열 ↔ 정수 센트. 부동소수 라운딩 없이 정확한 원가 회계(§6.5) —
// 같은 센트 값을 현금·원가·손익 양쪽에 쓰므로 독립 반올림으로 인한 누수가 없다.
function toCents(v: string): number {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const cents = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -cents : cents;
}
function fromCents(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
/** 체결금액(KRW)을 센트 정수로. 체결가·환율은 float이라도 여기서 한 번만 반올림한다. */
function amountCents(price: number, fxRate: number, qty: number): number {
  return Math.round(price * fxRate * qty * 100);
}

/**
 * 단일 트랜잭션으로 주문을 체결한다. `db`는 drizzle 핸들(내부에서 트랜잭션을 연다).
 */
export async function fillOrder(
  db: PgDatabase<any, any, any>,
  input: FillInput,
): Promise<FillResult> {
  const { orderId, userId, seasonId, market, symbol, side, orderType, qty } = input;

  return db.transaction(async (tx): Promise<FillResult> => {
    // ① CAS — open 주문만 filled로 전이. 영향 0행이면 이미 처리된 주문 → 전체 no-op.
    const claimed = await tx
      .update(orders)
      .set({
        status: "filled",
        filledPrice: String(input.filledPrice),
        fxRate: String(input.fxRate),
        filledAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "open")))
      .returning({ reservedKrw: orders.reservedKrw });

    if (claimed.length === 0) return { ok: false, reason: "already-filled" };
    const reservedKrw = claimed[0].reservedKrw; // 지정가 매수만 값 존재, 그 외 null

    // 검증 실패 시 호출: 예약분(지정가 매수) 환불 + status='rejected' 커밋. 현금/포지션은
    // 아직 손대지 않았으므로 롤백 불필요(RETURNING된 reserved_krw만으로 환불, ①).
    const reject = async (reason: "insufficient-cash" | "insufficient-qty" | "over-limit") => {
      if (reservedKrw != null) {
        await tx
          .update(accounts)
          .set({ cashKrw: sql`${accounts.cashKrw} + ${reservedKrw}::numeric` })
          .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)));
      }
      await tx
        .update(orders)
        .set({ status: "rejected", filledPrice: null, fxRate: null, filledAt: null })
        .where(eq(orders.id, orderId));
      return { ok: false, reason } as const;
    };

    const posWhere = and(
      eq(positions.userId, userId),
      eq(positions.seasonId, seasonId),
      eq(positions.market, market),
      eq(positions.symbol, symbol),
    );

    if (side === "sell") {
      // ② 매도: 보유 qty 검증(FOR UPDATE) → 수량 비례 원가 차감 + 현금 credit.
      const [pos] = await tx
        .select({ qty: positions.qty, cost: positions.costBasisKrw })
        .from(positions)
        .where(posWhere)
        .for("update");

      const heldQty = pos ? Number(pos.qty) : 0;
      if (!pos || heldQty < qty) return reject("insufficient-qty");

      const proceedsCents = amountCents(input.filledPrice, input.fxRate, qty);
      // soldCost = 총 취득원가 × (매도 qty / 보유 qty). 전량 매도면 qty===heldQty → 원가 전액.
      const soldCostCents = Math.round((toCents(pos.cost) * qty) / heldQty);
      const proceeds = fromCents(proceedsCents);
      const soldCost = fromCents(soldCostCents);
      const pnlDelta = fromCents(proceedsCents - soldCostCents);

      await tx
        .update(positions)
        .set({
          qty: sql`${positions.qty} - ${String(qty)}::numeric`,
          costBasisKrw: sql`${positions.costBasisKrw} - ${soldCost}::numeric`,
          realizedPnl: sql`${positions.realizedPnl} + ${pnlDelta}::numeric`,
        })
        .where(posWhere);

      await tx
        .update(accounts)
        .set({ cashKrw: sql`${accounts.cashKrw} + ${proceeds}::numeric` })
        .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)));

      return { ok: true, alreadyFilled: false };
    }

    // 매수 — 체결금액(KRW).
    const costCents = amountCents(input.filledPrice, input.fxRate, qty);
    const cost = fromCents(costCents);

    // ④ 40% 상한 재검증: 시즌 시드 × 40% 기준. 해당 종목 포지션 + open 매수 주문을
    //    FOR UPDATE로 잠그고 (기존 원가 + 대기 예약 + 이번 체결액) 합산해 초과면 거절.
    const [season] = await tx
      .select({ seed: seasons.seedMoney })
      .from(seasons)
      .where(eq(seasons.id, seasonId));
    const limitCents = Math.round(toCents(season.seed) * POSITION_LIMIT_PCT);

    const posLock = await tx
      .select({ cost: positions.costBasisKrw })
      .from(positions)
      .where(posWhere)
      .for("update");
    const posCostCents = posLock.length ? toCents(posLock[0].cost) : 0;

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
      )
      .for("update");
    const openReservedCents = openBuys.reduce(
      (s, r) => s + (r.reserved != null ? toCents(r.reserved) : 0),
      0,
    );

    if (posCostCents + openReservedCents + costCents > limitCents) return reject("over-limit");

    if (orderType === "limit") {
      // ③ 지정가 매수: 재차감 금지. 예약분 소진 + (예약 − 실체결) 차액만 환급.
      const refundCents = (reservedKrw != null ? toCents(reservedKrw) : costCents) - costCents;
      if (refundCents !== 0) {
        await tx
          .update(accounts)
          .set({ cashKrw: sql`${accounts.cashKrw} + ${fromCents(refundCents)}::numeric` })
          .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)));
      }
    } else {
      // 시장가 매수: 조건부 원자 차감. 영향 0행 = 잔액 부족.
      const deducted = await tx
        .update(accounts)
        .set({ cashKrw: sql`${accounts.cashKrw} - ${cost}::numeric` })
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.seasonId, seasonId),
            sql`${accounts.cashKrw} >= ${cost}::numeric`,
          ),
        )
        .returning({ cashKrw: accounts.cashKrw });
      if (deducted.length === 0) return reject("insufficient-cash");
    }

    // ⑤ 포지션 적립: 총 취득원가에 이번 체결액을 그대로 더한다(현금 차감액과 동일 센트 값).
    await tx
      .insert(positions)
      .values({ userId, seasonId, market, symbol, qty: String(qty), costBasisKrw: cost })
      .onConflictDoUpdate({
        target: [positions.userId, positions.seasonId, positions.market, positions.symbol],
        set: {
          qty: sql`${positions.qty} + ${String(qty)}::numeric`,
          costBasisKrw: sql`${positions.costBasisKrw} + ${cost}::numeric`,
        },
      });

    return { ok: true, alreadyFilled: false };
  });
}
