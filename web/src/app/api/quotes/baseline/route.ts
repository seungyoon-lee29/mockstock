// GET /api/quotes/baseline?market=us|kr — 종목별 시세 기준선 맵(D12c).
// instruments의 {market, symbol, lastPrice, prevClose, lastPriceAt}를 keyOf 맵으로 반환.
// market 생략 시 전체. 패턴은 /api/leaderboard 준용: force-dynamic + 스코프별 30s TTL
// 인메모리 캐시(§7.7 Neon 각성 억제). DATABASE_URL 미설정(키 없는 로컬)이면
// UNIVERSE seedPrice 폴백 — 키리스 로컬 불변식.
import { eq } from "drizzle-orm";
import type { Market } from "@mockstock/shared";
import { instruments } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import { isCacheFresh } from "@/lib/leaderboard";
import { buildBaselineMap, type BaselineMap } from "@/lib/market/baseline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 캐시 스코프: 리그별 + 전체("ALL"). TTL은 leaderboard와 동일 상수(isCacheFresh 기본값).
type Scope = Market | "ALL";
const cache: Partial<Record<Scope, { at: number; data: BaselineMap }>> = {};

async function load(market: Market | null): Promise<BaselineMap> {
  if (!process.env.DATABASE_URL) return buildBaselineMap([], market);

  const db = getDb();
  const cols = {
    market: instruments.market,
    symbol: instruments.symbol,
    lastPrice: instruments.lastPrice,
    prevClose: instruments.prevClose,
    lastPriceAt: instruments.lastPriceAt,
  };
  const rows = market
    ? await db.select(cols).from(instruments).where(eq(instruments.market, market))
    : await db.select(cols).from(instruments);
  return buildBaselineMap(rows, market);
}

export async function GET(req: Request): Promise<Response> {
  const param = new URL(req.url).searchParams.get("market");
  const market: Market | null = param === "us" ? "US" : param === "kr" ? "KR" : null;
  if (param !== null && market === null) {
    return Response.json({ message: "market은 us·kr 또는 생략만 허용합니다." }, { status: 400 });
  }

  const scope: Scope = market ?? "ALL";
  const now = Date.now();
  const c = cache[scope];
  if (!c || !isCacheFresh(now, c.at)) {
    cache[scope] = { at: now, data: await load(market) };
  }
  return Response.json(cache[scope]!.data);
}
