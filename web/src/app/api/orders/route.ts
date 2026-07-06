// POST /api/orders — 주문 접수. 시장가(T04): 워커 스냅샷가로 즉시 체결. 지정가(T08): 예약·접수 후
// 워커 매칭 루프가 체결(§6.1). 신뢰 경계(§6.1·db.md): userId=세션, seasonId=서버 active 시즌.
// 클라 입력은 6필드뿐(market·symbol·side·qty·limitPrice·idempotencyKey), 체결가는 워커만(클라 가격 금지).
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { SEED_MONEY_KRW } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import { fillOrder } from "@mockstock/shared/fillOrder";
import { accounts, fxRates, orders, seasons } from "@mockstock/shared/schema";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fetchSnapshot, pushOrderSync } from "@/lib/market/workerClient";
import { placeLimitOrder, type PlaceLimitResult } from "@/lib/orders/limit";
import {
  fillResultToHttp,
  isMarketTradable,
  isSnapshotFresh,
  parseOrderInput,
} from "@/lib/orders/validate";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/** §6.1 멱등 재생 — 기존 주문의 현재 상태를 200으로 반환(에러 아님). */
function replay(order: { id: string; status: string }): Response {
  return json(200, {
    ok: order.status === "filled",
    orderId: order.id,
    status: order.status,
    message: order.status === "filled" ? "체결되었습니다." : "접수된 주문입니다.",
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/** 지정가 접수 실패(PlaceLimitResult) → HTTP. 성공 케이스는 호출부에서 별도 처리. */
function placeFailToHttp(r: Extract<PlaceLimitResult, { ok: false }>): { httpStatus: number; message: string } {
  switch (r.reason) {
    case "insufficient-cash":
      return { httpStatus: 422, message: "주문 가능 현금이 부족합니다." };
    case "insufficient-qty":
      return { httpStatus: 422, message: "보유 수량이 부족합니다(미체결 매도 포함)." };
    case "over-limit":
      return { httpStatus: 422, message: "종목당 매수 상한(시드의 40%)을 초과했습니다." };
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  // 1. 세션 게이트 — 비로그인 401, 익명(게스트) 403(주문은 로그인 게이트, §5.4).
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return json(401, { message: "로그인이 필요합니다." });
  if (session.user.isAnonymous) return json(403, { message: "로그인이 필요합니다." });
  const userId = session.user.id;

  // 2. 입력 검증 (garbage는 DB 접근 전에 조기 거절). userId·seasonId는 절대 클라에서 받지 않음.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { message: "요청 본문이 올바르지 않습니다." });
  }
  const parsed = parseOrderInput(raw);
  if (!parsed.ok) return json(400, { message: parsed.message });
  const { market, symbol, side, qty, idempotencyKey } = parsed.value;

  const db = getDb();

  // 3. 서버가 active 시즌 결정. 없으면 접수 불가(시즌 생성은 리셋 크론/T06 몫).
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  if (!season) return json(409, { message: "진행 중인 시즌이 없습니다." });
  const seasonId = season.id;

  // 4. 시즌 계좌 lazy upsert — 첫 진입 시 시드 지급(§4.4). 이미 있으면 무변경.
  await db
    .insert(accounts)
    .values({ userId, seasonId, cashKrw: SEED_MONEY_KRW.toFixed(2) })
    .onConflictDoNothing();

  // 5. 멱등: 같은 (userId, idempotencyKey) 주문이 있으면 원본 결과 재생(§6.1).
  const [existing] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (existing) return replay(existing);

  // 6. 환율: US는 fx_rates 로우 필수(없으면 차단, §6.6). KR은 1. 매수 지정가/시장가는 이 값을 고정.
  let fxRate = 1;
  if (market === "US") {
    const [fx] = await db
      .select({ rate: fxRates.rate })
      .from(fxRates)
      .where(eq(fxRates.pair, "USDKRW"))
      .limit(1);
    if (!fx) {
      return json(422, { message: "환율 정보를 불러올 수 없어 미국 주문을 접수할 수 없습니다." });
    }
    fxRate = Number(fx.rate);
  }

  const orderId = crypto.randomUUID();

  // ── 지정가(§6.4): 장외에도 접수 허용 → 개장 후 워커 매칭 루프가 체결. 스냅샷/시장가 게이트 없음. ──
  if (parsed.type === "limit") {
    const { limitPrice } = parsed.value;
    let result: PlaceLimitResult;
    try {
      result = await placeLimitOrder(db, {
        orderId,
        userId,
        seasonId,
        market,
        symbol,
        side,
        qty,
        limitPrice,
        fxRate,
        idempotencyKey,
      });
    } catch (e) {
      // 동시 중복 접수 — 유니크 위반이면 원본 결과 멱등 재생.
      if (isUniqueViolation(e)) {
        const [dup] = await db
          .select({ id: orders.id, status: orders.status })
          .from(orders)
          .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)))
          .limit(1);
        if (dup) return replay(dup);
      }
      throw e;
    }
    if (!result.ok) {
      const { httpStatus, message } = placeFailToHttp(result);
      return json(httpStatus, { ok: false, orderId, message });
    }

    // 워커 매칭 캐시에 upsert push(§7.1). 실패는 조용히 무시 — 워커 재동기화+CAS가 안전망.
    void pushOrderSync("upsert", {
      id: orderId,
      userId,
      seasonId,
      market,
      symbol,
      side,
      qty: String(qty),
      limitPrice: String(limitPrice),
      fxRate: side === "buy" ? String(fxRate) : null,
      reservedKrw: null, // 워커는 reservedKrw를 DB에서 재조회(CAS RETURNING) — 캐시엔 불필요.
    });

    // §5.5 장외 접수 피드백 — 개장 후 체결 예정 안내(캘린더 기준, mock은 UI 편의상 근사).
    const queued = !isMarketOpen(market, new Date());
    return json(201, {
      ok: true,
      orderId,
      status: "open",
      queued,
      message: queued
        ? "지정가 주문을 접수했습니다. 개장 후 가격 도달 시 체결됩니다."
        : "지정가 주문을 접수했습니다. 가격 도달 시 체결됩니다.",
    });
  }

  // ── 시장가(§6.1): 워커 스냅샷가로 즉시 체결. ──
  // 7. 시세: 워커 /snapshot. 미응답·타임아웃·스테일(now−at>30초) 전부 동일 fail-closed(§6.1).
  const tick = await fetchSnapshot(market, symbol);
  const now = Date.now();
  if (!tick || !isSnapshotFresh(now, tick.at)) {
    return json(503, { message: "시세 연결 복구 중입니다. 잠시 후 다시 시도해 주세요." });
  }

  // 8. 시장 세션: mock source면 open 간주(§7.5), 그 외엔 정규장만 시장가 허용.
  if (!isMarketTradable(market, tick.source, new Date(now))) {
    return json(422, { message: "장 마감 중에는 시장가 주문을 낼 수 없습니다." });
  }

  // 9. orders insert(open, reservedKrw=null, fxRate 기록) → fillOrder(market)로 즉시 체결.
  try {
    await db.insert(orders).values({
      id: orderId,
      userId,
      seasonId,
      market,
      symbol,
      side,
      type: "market",
      qty: String(qty),
      fxRate: String(fxRate),
      reservedKrw: null,
      status: "open",
      idempotencyKey,
    });
  } catch (e) {
    // 동시 중복 접수 — 유니크 위반이면 원본 결과를 멱등 재생.
    if (isUniqueViolation(e)) {
      const [dup] = await db
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (dup) return replay(dup);
    }
    throw e;
  }

  const result = await fillOrder(db, {
    orderId,
    userId,
    seasonId,
    market,
    symbol,
    side,
    orderType: "market",
    qty,
    filledPrice: tick.price,
    fxRate,
  });
  const { httpStatus, message } = fillResultToHttp(result);
  return json(httpStatus, { ok: result.ok, orderId, message });
}
