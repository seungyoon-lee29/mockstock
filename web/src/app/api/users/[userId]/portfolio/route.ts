// GET /api/users/[userId]/portfolio?league=us|kr — 참가자 공개 포트폴리오(리더보드 행 클릭 상세).
// 무인증 공개: 리더보드 API가 이미 전 참가자 {cash, reserved, positions}를 공개하는 것과 동일 표면.
// 일반 유저는 미체결 주문·거래내역을 숨긴다(비공개 전략). 봇은 공개 벤치마크(§4.3)라 전부 공개.
// 조회 전용(계좌 lazy upsert 등 부수효과 없음). 금액은 numeric 문자열 그대로(§9 클라 로컬 평가).
import { and, desc, eq, gt, sum } from "drizzle-orm";
import type { Market } from "@mockstock/shared";
import { accounts, orders, positions, seasons, users } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import { isCacheFresh } from "@/lib/leaderboard";
import {
  buildPortfolio,
  TRADE_HISTORY_LIMIT,
  type FilledOrderRow,
  type OpenOrderRow,
  type ParticipantPortfolio,
} from "@/lib/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// (market,userId)별 인메모리 TTL 캐시 — 리더보드 라우트와 동일한 §7.7 Neon 각성 억제.
// 404(유저 부재 등)도 함께 캐시해 반복 조회의 DB 히트를 흡수한다.
interface CacheEntry {
  at: number;
  status: number;
  body: ParticipantPortfolio | { message: string };
}
const cache = new Map<string, CacheEntry>();
// ponytail: LRU 대신 상한 초과 시 전체 비움 — 참가자 수 규모에서 충분, 필요해지면 LRU로 교체.
const CACHE_MAX_ENTRIES = 1_000;

async function load(market: Market, userId: string): Promise<Omit<CacheEntry, "at">> {
  const db = getDb();

  // 유저 존재·공개 대상 확인 — 익명(게스트)은 리더보드와 동일하게 노출 대상이 아님 → 404.
  const [user] = await db
    .select({ name: users.name, isBot: users.isBot, isAnonymous: users.isAnonymous })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.isAnonymous) {
    return { status: 404, body: { message: "참가자를 찾을 수 없습니다." } };
  }

  // 리그별 active 시즌(없으면 404 — 시즌 생성은 크론 몫, 여기서 만들지 않음).
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
  if (!season) return { status: 404, body: { message: "시즌 준비 중입니다." } };

  // 계좌·예약·실현손익·보유는 서로 독립 → 병렬 조회. numeric 합산은 Postgres에 위임(정확).
  const [accountRows, reservedRows, realizedRows, positionRows] = await Promise.all([
    db
      .select({ cash: accounts.cash })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, season.id)))
      .limit(1),
    // open 매수 주문 reserved SUM(예약 현금) — 리더보드와 동일 집계, 개별 주문은 노출 안 함.
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
  ]);

  const hasAccount = accountRows.length > 0;

  // 봇(공개 벤치마크, §4.3)만 미체결 주문·거래내역까지 전부 공개. 일반 유저는 빈 배열 → 응답에서 필드 제외(비공개).
  let openOrderRows: OpenOrderRow[] = [];
  let tradeRows: FilledOrderRow[] = [];
  if (user.isBot) {
    [openOrderRows, tradeRows] = await Promise.all([
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
  }

  const p = buildPortfolio(
    season,
    accountRows[0]?.cash ?? null,
    reservedRows[0]?.v ?? null,
    realizedRows[0]?.v ?? null,
    positionRows,
    openOrderRows,
    tradeRows,
  );
  const body: ParticipantPortfolio = {
    user: { name: user.name, isBot: user.isBot },
    hasAccount,
    season: p.season,
    cash: p.cash,
    reserved: p.reserved,
    realizedPnl: p.realizedPnl,
    positions: p.positions,
    // 봇만 전부 공개 — 일반 유저는 undefined(비공개 전략).
    ...(user.isBot ? { openOrders: p.openOrders, trades: p.trades } : {}),
  };
  return { status: 200, body };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ userId: string }> },
): Promise<Response> {
  // DB 미설정(키 없는 로컬 데모)은 500으로 깨지 않게 "시즌 준비 중"으로 강등(리더보드와 동일).
  if (!process.env.DATABASE_URL) {
    console.warn("[users/portfolio] DATABASE_URL 미설정 — 시즌 준비 중 반환");
    return Response.json({ message: "시즌 준비 중입니다." }, { status: 404 });
  }

  const league = new URL(req.url).searchParams.get("league");
  const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) return Response.json({ message: "리그를 지정해 주세요." }, { status: 400 });

  const { userId } = await ctx.params;

  const key = `${market}:${userId}`;
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || !isCacheFresh(now, entry.at)) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    entry = { at: now, ...(await load(market, userId)) };
    cache.set(key, entry);
  }
  return Response.json(entry.body, { status: entry.status });
}
