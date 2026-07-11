// GET /api/users/[userId]/profile?league=us|kr — AI 투자 성향 요약(§D8).
//
// GET 부수효과 예외: 이 라우트는 조회 시점에 프로필을 lazy 생성한다(investment_profiles upsert).
// 프로필은 체결 통계에서 결정적으로 파생되는 캐시 데이터라 같은 입력에 같은 결과 — 의미상
// 멱등하며, 생성 소유권은 lease(§D8)가 직렬화해 중복 LLM 호출을 차단한다.
//
// 404/400 규약은 이웃 라우트(portfolio/route.ts)와 동일. 단, 익명 유저는 404가 아니라
// 규칙 폴백 경로(가드 ①)로 처리 — 게스트 본인 포트폴리오 화면에서도 카드가 뜨도록.
import { and, desc, eq } from "drizzle-orm";
import type { Market } from "@mockstock/shared";
import { seasons, users } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import { getOrGenerateProfile } from "@/lib/profile/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// LLM 최악 케이스: PROFILE_LLM_TIMEOUT_MS(15s) × (1 + PROFILE_LLM_MAX_RETRIES) = 30s + DB 왕복 여유.
export const maxDuration = 60;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ userId: string }> },
): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    console.warn("[users/profile] DATABASE_URL 미설정 — 시즌 준비 중 반환");
    return Response.json({ message: "시즌 준비 중입니다." }, { status: 404 });
  }

  const league = new URL(req.url).searchParams.get("league");
  const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) return Response.json({ message: "리그를 지정해 주세요." }, { status: 400 });

  const { userId } = await ctx.params;
  const db = getDb();

  const [user] = await db
    .select({ isAnonymous: users.isAnonymous })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return Response.json({ message: "참가자를 찾을 수 없습니다." }, { status: 404 });

  const [season] = await db
    .select({ id: seasons.id, seedMoney: seasons.seedMoney })
    .from(seasons)
    .where(and(eq(seasons.status, "active"), eq(seasons.market, market)))
    .orderBy(desc(seasons.startsAt))
    .limit(1);
  if (!season) return Response.json({ message: "시즌 준비 중입니다." }, { status: 404 });

  const profile = await getOrGenerateProfile(db, {
    userId,
    seasonId: season.id,
    market,
    seedMoney: season.seedMoney,
    isAnonymous: user.isAnonymous,
  });
  return Response.json(profile);
}
