// GET /api/leaderboard — 게스트 포함 전면 공개 리더보드 스냅샷(PRD §9·§5.4).
// 전 참가자 {cashKrw, reservedKrw, positions, fxRate}를 원시로 실어 보내고, 클라이언트가
// 구독 중인 SSE 가격으로 전원 평가액을 로컬 재계산한다 — 서버는 가격을 계산하지 않는다(§9).
import { and, desc, eq, gt, sum } from "drizzle-orm";
import { FX_PAIR_USDKRW } from "@mockstock/shared";
import { accounts, fxRates, orders, positions, seasons, users } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import {
  buildLeaderboard,
  isCacheFresh,
  type LeaderboardResponse,
} from "@/lib/leaderboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// §7.7 Neon 각성 억제 — 모듈 스코프 인메모리 TTL 캐시. 폴링당 DB 히트를 흡수한다.
// data=null 은 "active 시즌 없음"(404)도 캐시해 장외 폴링이 매번 DB를 깨우지 않게 한다.
let cache: { at: number; data: LeaderboardResponse | null } | undefined;

function seasonNotReady(): Response {
  return Response.json({ message: "시즌 준비 중입니다." }, { status: 404 });
}

async function load(): Promise<LeaderboardResponse | null> {
  const db = getDb();

  // active 시즌(없으면 null → 404). 시즌 생성은 크론/lazy 몫(여기서 만들지 않음).
  const [season] = await db
    .select({
      id: seasons.id,
      startsAt: seasons.startsAt,
      endsAt: seasons.endsAt,
      seedMoney: seasons.seedMoney,
    })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .orderBy(desc(seasons.startsAt))
    .limit(1);
  if (!season) return null;

  // USDKRW — 없으면 0(클라 US 평가는 0으로 강등, §6.6 로우 없으면 US 평가 0과 동일).
  const [fx] = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(eq(fxRates.pair, FX_PAIR_USDKRW))
    .limit(1);
  const fxRate = fx ? Number(fx.rate) : 0;

  const accountRows = await db
    .select({
      userId: accounts.userId,
      name: users.name,
      isBot: users.isBot,
      isAnonymous: users.isAnonymous,
      joinedAt: accounts.joinedAt,
      cashKrw: accounts.cashKrw,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(eq(accounts.seasonId, season.id));

  // reservedKrw = open 매수 주문 reservedKrw SUM(유저별). numeric 합산은 Postgres에 위임(정확).
  const reservedRows = await db
    .select({ userId: orders.userId, reservedKrw: sum(orders.reservedKrw) })
    .from(orders)
    .where(and(eq(orders.seasonId, season.id), eq(orders.status, "open"), eq(orders.side, "buy")))
    .groupBy(orders.userId);

  const positionRows = await db
    .select({
      userId: positions.userId,
      market: positions.market,
      symbol: positions.symbol,
      qty: positions.qty,
      costBasisKrw: positions.costBasisKrw,
    })
    .from(positions)
    .where(and(eq(positions.seasonId, season.id), gt(positions.qty, "0"))); // 전량 매도한 0-수량 잔여 로우 제외

  return buildLeaderboard(season, fxRate, accountRows, reservedRows, positionRows);
}

export async function GET(): Promise<Response> {
  // DB 미설정(키 없는 로컬 데모)은 게스트 홈을 500으로 깨지 않게 "시즌 준비 중"으로 강등한다.
  if (!process.env.DATABASE_URL) {
    console.warn("[leaderboard] DATABASE_URL 미설정 — 시즌 준비 중 반환");
    return seasonNotReady();
  }

  const now = Date.now();
  if (!cache || !isCacheFresh(now, cache.at)) {
    cache = { at: now, data: await load() };
  }
  if (!cache.data) return seasonNotReady();
  return Response.json(cache.data);
}
