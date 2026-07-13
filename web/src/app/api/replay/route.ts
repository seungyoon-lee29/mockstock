// 리플레이 성적 영속화(PRD §5.3·§5.4, 결정 #8: 개인 기록만).
// POST  = 세션 시작 insert(finishedAt=null) → 완주율 분모. 게스트(익명)·비로그인은 insert 생략({id:null}).
// PATCH = 완주 시 finishedAt·수익률·MDD 갱신(본인 소유 행만). 게스트는 애초에 id가 없어 호출 안 함.
// 리플레이는 클라 로컬 체결(§5.3)이라 여기서 fillOrder/계좌 로직은 쓰지 않는다 — 결과 지표만 저장.
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { replaySessions } from "@mockstock/shared/schema";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isValidScenarioId, REPLAY_DEFAULT_SCENARIO_ID } from "@/lib/replay";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/** numeric(8,2) 컬럼용 — 유한값만 소수 2자리 문자열로(float 저장 금지). */
function toNumeric(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  // 게스트(익명)·비로그인은 insert 생략 — 결과 저장 시점에만 로그인 유도(§5.4).
  if (!session || session.user.isAnonymous) return json(200, { id: null });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const { scenarioId, id: pendingId, returnPct, mdd } = body as {
    scenarioId?: unknown;
    id?: unknown;
    returnPct?: unknown;
    mdd?: unknown;
  };
  // scenarioId는 레지스트리 검증 후에만 DB에 기록(신뢰 경계). 누락/무효면 기본 시나리오로 폴백.
  const validScenarioId = isValidScenarioId(scenarioId) ? scenarioId : REPLAY_DEFAULT_SCENARIO_ID;

  // 게스트→로그인 복귀 후 보존 결과 재제출(§194): 클라 멱등키(id)+결과를 완주 상태로 저장.
  // id를 PK로 삼아 onConflictDoNothing → 새로고침·중복 트리거의 이중 저장 차단(멱등).
  if (typeof pendingId === "string") {
    await getDb()
      .insert(replaySessions)
      .values({
        id: pendingId,
        userId: session.user.id,
        scenarioId: validScenarioId,
        returnPct: toNumeric(returnPct),
        mdd: toNumeric(mdd),
        finishedAt: new Date(),
      })
      .onConflictDoNothing();
    return json(201, { id: pendingId });
  }

  const id = crypto.randomUUID();
  await getDb()
    .insert(replaySessions)
    .values({ id, userId: session.user.id, scenarioId: validScenarioId });
  return json(201, { id });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!session || session.user.isAnonymous) return json(401, { message: "로그인이 필요합니다." });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { message: "요청 본문이 올바르지 않습니다." });
  }
  const { id, returnPct, mdd } = body as {
    id?: unknown;
    returnPct?: unknown;
    mdd?: unknown;
  };
  if (typeof id !== "string") return json(400, { message: "세션 id가 필요합니다." });

  // 본인 소유 미완료 세션만 완주 처리 — RETURNING으로 영향 행 확인(경합·위조 차단).
  const updated = await getDb()
    .update(replaySessions)
    .set({ returnPct: toNumeric(returnPct), mdd: toNumeric(mdd), finishedAt: new Date() })
    .where(and(eq(replaySessions.id, id), eq(replaySessions.userId, session.user.id)))
    .returning({ id: replaySessions.id });

  if (updated.length === 0) return json(404, { message: "세션을 찾을 수 없습니다." });
  return json(200, { ok: true });
}
