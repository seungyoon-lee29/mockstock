// GET /api/discover/popular?league=us|kr — 당일(KST) 체결(status='filled') 건수 기준
// 인기 종목 순위. 리그의 active 시즌 스코프(봇 포함). 패턴은 /api/leaderboard 준용:
// force-dynamic + 리그별 30s TTL 인메모리 캐시(§7.7 Neon 각성 억제).
// 응답 계약(클라 미러: components/discover/discover.tsx): { items: [{symbol, market, fillCount}], empty }
// DATABASE_URL 미설정(키 없는 로컬)이면 빈 배열 — 클라이언트가 등락률 폴백(키리스 로컬 불변식).
import { and, count, desc, eq, gte } from "drizzle-orm";
import type { Market } from "@mockstock/shared";
import { orders, seasons } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import { isCacheFresh } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PopularItem {
  symbol: string;
  market: Market;
  fillCount: number;
}
interface PopularResponse {
  items: PopularItem[];
  /** 당일 집계 0건 여부 — true면 클라이언트가 등락률 정렬로 폴백. */
  empty: boolean;
}

// 시즌 경계·크론과 동일한 기준 tz(§7.6). Asia/Seoul은 DST 없는 고정 +09:00.
const KST_TZ = "Asia/Seoul";
const kstDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: KST_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 주어진 시각이 속한 KST 달력일의 자정(KST 00:00) 절대시각. */
function kstDayStart(at: Date): Date {
  return new Date(`${kstDateFmt.format(at)}T00:00:00+09:00`);
}

// 리그별 인메모리 TTL 캐시 — leaderboard 라우트와 동일 패턴(30s).
const cache: Record<Market, { at: number; items: PopularItem[] } | undefined> = {
  US: undefined,
  KR: undefined,
};

async function load(market: Market): Promise<PopularItem[]> {
  const db = getDb();

  // 리그별 active 시즌(없으면 집계 없음). 시즌 생성은 크론/lazy 몫 — 여기서 만들지 않음.
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.status, "active"), eq(seasons.market, market)))
    .orderBy(desc(seasons.startsAt))
    .limit(1);
  if (!season) return [];

  return db
    .select({ symbol: orders.symbol, market: orders.market, fillCount: count() })
    .from(orders)
    .where(
      and(
        eq(orders.seasonId, season.id),
        eq(orders.status, "filled"),
        gte(orders.filledAt, kstDayStart(new Date())),
      ),
    )
    .groupBy(orders.symbol, orders.market)
    .orderBy(desc(count()));
}

export async function GET(req: Request): Promise<Response> {
  const league = new URL(req.url).searchParams.get("league");
  const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) return Response.json({ message: "리그를 지정해 주세요." }, { status: 400 });

  if (!process.env.DATABASE_URL) {
    return Response.json({ items: [], empty: true } satisfies PopularResponse);
  }

  const now = Date.now();
  const c = cache[market];
  if (!c || !isCacheFresh(now, c.at)) {
    cache[market] = { at: now, items: await load(market) };
  }
  const { items } = cache[market]!;
  return Response.json({ items, empty: items.length === 0 } satisfies PopularResponse);
}
