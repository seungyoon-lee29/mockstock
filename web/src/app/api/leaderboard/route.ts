// GET /api/leaderboard?league=us|kr — 리그별 리더보드 스냅샷(PRD §9·§5.4).
// 전 참가자 {cash, reserved, positions}를 원시로 실어 보내고, 클라이언트가
// 구독 중인 SSE 가격으로 전원 평가액을 로컬 재계산한다 — 서버는 가격을 계산하지 않는다(§9).
import { and, desc, eq, gt, sum } from "drizzle-orm";
import type { Market } from "@mockstock/shared";
import { accounts, orders, positions, seasons, users } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import {
  buildLeaderboard,
  isCacheFresh,
  type LeaderboardResponse,
} from "@/lib/leaderboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 리그별 인메모리 TTL 캐시 — us·kr 각각(§7.7 Neon 각성 억제).
const cache: Record<Market, { at: number; data: LeaderboardResponse | null } | undefined> = { US: undefined, KR: undefined };

function seasonNotReady(): Response {
  return Response.json({ message: "시즌 준비 중입니다." }, { status: 404 });
}

async function load(market: Market): Promise<LeaderboardResponse | null> {
  const db = getDb();

  // 리그별 active 시즌(없으면 null → 404). 시즌 생성은 크론/lazy 몫(여기서 만들지 않음).
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
  if (!season) return null;

  const accountRows = await db
    .select({
      userId: accounts.userId,
      name: users.name,
      isBot: users.isBot,
      isAnonymous: users.isAnonymous,
      joinedAt: accounts.joinedAt,
      cash: accounts.cash,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(eq(accounts.seasonId, season.id));

  // reserved = open 매수 주문 reserved SUM(유저별). numeric 합산은 Postgres에 위임(정확).
  const reservedRows = await db
    .select({ userId: orders.userId, reserved: sum(orders.reserved) })
    .from(orders)
    .where(and(eq(orders.seasonId, season.id), eq(orders.status, "open"), eq(orders.side, "buy")))
    .groupBy(orders.userId);

  const positionRows = await db
    .select({
      userId: positions.userId,
      market: positions.market,
      symbol: positions.symbol,
      qty: positions.qty,
      costBasis: positions.costBasis,
    })
    .from(positions)
    .where(and(eq(positions.seasonId, season.id), gt(positions.qty, "0"))); // 전량 매도한 0-수량 잔여 로우 제외

  return buildLeaderboard(season, accountRows, reservedRows, positionRows);
}

export async function GET(req: Request): Promise<Response> {
  // DB 미설정(키 없는 로컬 데모)은 게스트 홈을 500으로 깨지 않게 "시즌 준비 중"으로 강등한다.
  if (!process.env.DATABASE_URL) {
    console.warn("[leaderboard] DATABASE_URL 미설정 — 시즌 준비 중 반환");
    return seasonNotReady();
  }
  const league = new URL(req.url).searchParams.get("league");
  const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) return Response.json({ message: "리그를 지정해 주세요." }, { status: 400 });

  const now = Date.now();
  const c = cache[market];
  if (!c || !isCacheFresh(now, c.at)) { cache[market] = { at: now, data: await load(market) }; }
  const fresh = cache[market]!;
  if (!fresh.data) return seasonNotReady();
  return Response.json(fresh.data);
}
