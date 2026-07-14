// GET /api/portfolio?league=us|kr — 세션 유저의 활성 리그 시즌 포트폴리오(계좌·보유·미체결·거래내역·실현손익).
// 신뢰 경계(db.md): userId=세션에서만, seasonId=서버 active 시즌. 금액은 numeric 문자열 그대로 반환.
// 평가액은 계산하지 않는다 — 클라가 SSE 가격으로 로컬 재계산(§9). 부수효과 없음(계좌 lazy upsert 안 함).
import type { NextRequest } from "next/server";
import { and, desc, eq, gt, sum } from "drizzle-orm";
import { accounts, orders, positions, seasons } from "@mockstock/shared/schema";
import type { Market } from "@mockstock/shared";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { buildPortfolio, TRADE_HISTORY_LIMIT } from "@/lib/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export async function GET(req: NextRequest): Promise<Response> {
  // 세션 게이트 — 미로그인·게스트(익명)는 포트폴리오 없음(§5.4 게스트는 도메인 데이터 미생성) → 401.
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session || session.user.isAnonymous) {
    return json(401, { message: "로그인이 필요합니다." });
  }
  const userId = session.user.id;

  // 리그 파싱 — us|kr 외 400.
  const url = new URL(req.url);
  const league = url.searchParams.get("league");
  const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) return json(400, { message: "리그를 지정해 주세요." });

  const db = getDb();

  // 서버가 active 리그 시즌 결정(없으면 404 — 시즌 생성은 크론 몫).
  const [season] = await db
    .select({
      id: seasons.id,
      market: seasons.market,
      startsAt: seasons.startsAt,
      endsAt: seasons.endsAt,
      seedMoney: seasons.seedMoney,
    })
    .from(seasons)
    .where(and(eq(seasons.status, "active"), eq(seasons.market, market)))
    .orderBy(desc(seasons.startsAt))
    .limit(1);
  if (!season) return json(404, { message: "진행 중인 시즌이 없습니다." });

  // 시즌 스코프 집계·목록은 서로 독립 → 병렬 조회.
  const [accountRows, reservedRows, realizedRows, positionRows, openOrderRows, tradeRows] =
    await Promise.all([
      db
        .select({ cash: accounts.cash })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, season.id)))
        .limit(1),
      // open 매수 주문 reserved SUM(예약 현금). numeric 합산은 Postgres에 위임(정확).
      db
        .select({ v: sum(orders.reserved) })
        .from(orders)
        .where(
          and(
            eq(orders.userId, userId),
            eq(orders.seasonId, season.id),
            eq(orders.status, "open"),
            eq(orders.side, "buy"),
          ),
        ),
      // 실현손익 SUM — 전량 매도한 qty=0 잔여 로우도 포함해야 하므로 qty 필터 없이 전체 집계.
      db
        .select({ v: sum(positions.realizedPnl) })
        .from(positions)
        .where(and(eq(positions.userId, userId), eq(positions.seasonId, season.id))),
      // 보유 목록은 qty>0만(전량 매도 로우 제외).
      db
        .select({
          market: positions.market,
          symbol: positions.symbol,
          qty: positions.qty,
          costBasis: positions.costBasis,
          realizedPnl: positions.realizedPnl,
        })
        .from(positions)
        .where(and(eq(positions.userId, userId), eq(positions.seasonId, season.id), gt(positions.qty, "0"))),
      db
        .select({
          id: orders.id,
          market: orders.market,
          symbol: orders.symbol,
          side: orders.side,
          type: orders.type,
          qty: orders.qty,
          limitPrice: orders.limitPrice,
          reserved: orders.reserved,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(and(eq(orders.userId, userId), eq(orders.seasonId, season.id), eq(orders.status, "open")))
        .orderBy(desc(orders.createdAt)),
      // 거래내역 — 체결된 주문(status='filled')만, 체결시각 최신순 최근 N건.
      db
        .select({
          id: orders.id,
          market: orders.market,
          symbol: orders.symbol,
          side: orders.side,
          type: orders.type,
          qty: orders.qty,
          filledPrice: orders.filledPrice,
          filledAt: orders.filledAt,
        })
        .from(orders)
        .where(and(eq(orders.userId, userId), eq(orders.seasonId, season.id), eq(orders.status, "filled")))
        .orderBy(desc(orders.filledAt))
        .limit(TRADE_HISTORY_LIMIT),
    ]);

  return Response.json(
    buildPortfolio(
      season,
      accountRows[0]?.cash ?? null,
      reservedRows[0]?.v ?? null,
      realizedRows[0]?.v ?? null,
      positionRows,
      openOrderRows,
      tradeRows,
    ),
  );
}
