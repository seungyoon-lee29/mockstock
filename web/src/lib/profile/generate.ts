// AI 투자 성향 요약 생성 파이프라인(§D8) — lease·남용 가드 4종·LLM 호출·규칙 폴백.
//
// 동시성(lease): 프로필 로우 자체가 잠금이다.
//   - 로우 없음 → INSERT … ON CONFLICT DO NOTHING RETURNING — 반환 로우를 받은 요청만 승자.
//   - pending → generation_started_at이 PROFILE_LEASE_MS보다 오래된 경우에만 조건부 UPDATE로
//     takeover(pending 영구 정체 방지). 그 외에는 pending 응답만 반환.
//   - ok/insufficient/failed 재생성 → UPDATE … WHERE status=<관측값> CAS. 한 요청만 성공.
//
// 남용 가드 4종:
//   ① 익명(isAnonymous) 유저는 LLM 금지 — 규칙 폴백.
//   ② 체결 PROFILE_MIN_FILLED_ORDERS 미만 → status='insufficient' (LLM 호출 없음).
//   ③ 재생성은 input_hash 불일치 AND (최소간격 경과 OR 직전 insufficient/failed의 retry_after 경과)일 때만.
//   ④ 전역 일일 생성 상한(DB 카운트: 당일 KST·model 비NULL 로우 수) 초과 → LLM 없이 규칙 폴백.
//
// 실패 시 placeholder를 지우지 않는다 — status='failed' + retry_after 기록(즉시 재시도 폭주 차단).
// input_hash는 실패 시 갱신하지 않아 retry_after 경과 후 같은 통계로도 재시도가 열린다.
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, count, eq, isNotNull, or, isNull, lt, sql } from "drizzle-orm";
import {
  getEntry,
  PROFILE_DAILY_GENERATION_CAP,
  PROFILE_DEFAULT_MODEL,
  PROFILE_LEASE_MS,
  PROFILE_LLM_MAX_RETRIES,
  PROFILE_LLM_TIMEOUT_MS,
  PROFILE_MIN_FILLED_ORDERS,
  PROFILE_REGEN_MIN_INTERVAL_MS,
  PROFILE_RETRY_AFTER_MS,
  type Market,
} from "@mockstock/shared";
import {
  accounts,
  investmentProfiles,
  orders,
  portfolioSnapshots,
  positions,
} from "@mockstock/shared/schema";
import type { getDb } from "@/lib/db";
import { buildRuleProfile, type ProfileText } from "./fallback";
import { computeProfileStats, hashProfileInput, type ProfileStats } from "./stats";

export type ProfileStatus = "pending" | "ok" | "insufficient" | "failed";

/** GET /api/users/[userId]/profile 응답 셰이프. */
export interface ProfileResponse {
  status: ProfileStatus;
  summary: string | null;
  traits: string[] | null;
  /** model 비NULL = LLM 생성. 규칙 폴백이면 false → UI가 "간이 분석" 표기. */
  aiGenerated: boolean;
  updatedAt: string | null;
}

type Db = ReturnType<typeof getDb>;
type ProfileRow = typeof investmentProfiles.$inferSelect;

const PENDING_RESPONSE: ProfileResponse = {
  status: "pending",
  summary: null,
  traits: null,
  aiGenerated: false,
  updatedAt: null,
};

function toResponse(row: ProfileRow): ProfileResponse {
  return {
    status: row.status,
    summary: row.summary,
    traits: row.traits,
    aiGenerated: row.model != null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrGenerateProfile(
  db: Db,
  params: {
    userId: string;
    seasonId: string;
    market: Market;
    seedMoney: string;
    isAnonymous: boolean;
  },
): Promise<ProfileResponse> {
  const { userId, seasonId } = params;
  const pk = and(
    eq(investmentProfiles.userId, userId),
    eq(investmentProfiles.seasonId, seasonId),
  );

  // ── 통계 수집(§D9) — 프로필 존재 여부와 무관하게 input_hash 비교에 필요 ──
  const [orderRows, positionRows, accountRows, snapshotRows] = await Promise.all([
    db
      .select({
        symbol: orders.symbol,
        side: orders.side,
        type: orders.type,
        qty: orders.qty,
        filledPrice: orders.filledPrice,
      })
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.seasonId, seasonId), eq(orders.status, "filled"))),
    db
      .select({
        symbol: positions.symbol,
        qty: positions.qty,
        costBasis: positions.costBasis,
        realizedPnl: positions.realizedPnl,
      })
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.seasonId, seasonId))),
    db
      .select({ cash: accounts.cash })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.seasonId, seasonId)))
      .limit(1),
    db
      .select({ totalValue: portfolioSnapshots.totalValue })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.userId, userId), eq(portfolioSnapshots.seasonId, seasonId)))
      .orderBy(asc(portfolioSnapshots.date)),
  ]);

  const stats = computeProfileStats({
    seedMoney: params.seedMoney,
    cash: accountRows[0]?.cash ?? null,
    orders: orderRows,
    positions: positionRows,
    snapshots: snapshotRows,
  });
  const heldSymbols = positionRows.filter((p) => Number(p.qty) > 0).map((p) => p.symbol);
  const inputHash = hashProfileInput(stats, heldSymbols);

  // ── lease: 승자 결정 ──
  const [existing] = await db.select().from(investmentProfiles).where(pk).limit(1);
  const now = Date.now();

  if (!existing) {
    // INSERT … ON CONFLICT DO NOTHING RETURNING — 로우를 돌려받은 요청만 생성 소유권을 가진다.
    const inserted = await db
      .insert(investmentProfiles)
      .values({ userId, seasonId, status: "pending", generationStartedAt: new Date(now) })
      .onConflictDoNothing()
      .returning({ userId: investmentProfiles.userId });
    if (inserted.length === 0) return PENDING_RESPONSE; // 동시 요청이 승자
  } else if (existing.status === "pending") {
    // lease 만료 takeover — 만료 전이면 진행 중 응답만.
    const leaseCutoff = new Date(now - PROFILE_LEASE_MS);
    const takeover = await db
      .update(investmentProfiles)
      .set({ generationStartedAt: new Date(now) })
      .where(
        and(
          pk,
          eq(investmentProfiles.status, "pending"),
          or(
            isNull(investmentProfiles.generationStartedAt),
            lt(investmentProfiles.generationStartedAt, leaseCutoff),
          ),
        ),
      )
      .returning({ userId: investmentProfiles.userId });
    if (takeover.length === 0) return PENDING_RESPONSE;
  } else {
    // 가드 ③ 재생성 규칙: input_hash 불일치 AND (최소간격 경과 OR insufficient/failed retry_after 경과).
    const hashChanged = existing.inputHash !== inputHash;
    const intervalPassed = now - existing.updatedAt.getTime() >= PROFILE_REGEN_MIN_INTERVAL_MS;
    const retryPassed =
      existing.status !== "ok" &&
      (existing.retryAfter == null || existing.retryAfter.getTime() <= now);
    if (!hashChanged || !(intervalPassed || retryPassed)) return toResponse(existing);

    // status CAS — 관측한 상태 그대로일 때만 pending 전환. 동시 요청 중 하나만 성공.
    const takeover = await db
      .update(investmentProfiles)
      .set({ status: "pending", generationStartedAt: new Date(now) })
      .where(and(pk, eq(investmentProfiles.status, existing.status)))
      .returning({ userId: investmentProfiles.userId });
    if (takeover.length === 0) return toResponse(existing);
  }

  // ── 승자 경로: 생성 ──
  try {
    // 가드 ②: 체결 부족 → insufficient (LLM 호출 없음). input_hash를 기록해 같은 통계 재계산을 스킵.
    if (stats.tradeCount < PROFILE_MIN_FILLED_ORDERS) {
      const [row] = await db
        .update(investmentProfiles)
        .set({
          status: "insufficient",
          summary: null,
          traits: null,
          model: null,
          inputHash,
          generationStartedAt: null,
          retryAfter: new Date(now + PROFILE_RETRY_AFTER_MS),
        })
        .where(pk)
        .returning();
      return toResponse(row);
    }

    // 가드 ①(익명)·④(일일 상한)·키 부재 → 규칙 폴백. 그 외 LLM.
    const useLlm =
      !!process.env.ANTHROPIC_API_KEY &&
      !params.isAnonymous &&
      !(await dailyCapReached(db));
    let text: ProfileText;
    let model: string | null = null;
    if (useLlm) {
      model = process.env.ANTHROPIC_MODEL || PROFILE_DEFAULT_MODEL;
      text = await generateWithClaude(model, stats, params.market, heldSymbols);
    } else {
      text = buildRuleProfile(stats);
    }

    const [row] = await db
      .update(investmentProfiles)
      .set({
        status: "ok",
        summary: text.summary,
        traits: text.traits,
        model,
        inputHash,
        generationStartedAt: null,
        retryAfter: null,
      })
      .where(pk)
      .returning();
    return toResponse(row);
  } catch (e) {
    // 실패해도 placeholder 삭제 금지 — failed + retry_after. input_hash 미갱신 → 재시도 가능.
    console.error("[profile] 생성 실패:", e);
    const [row] = await db
      .update(investmentProfiles)
      .set({
        status: "failed",
        generationStartedAt: null,
        retryAfter: new Date(Date.now() + PROFILE_RETRY_AFTER_MS),
      })
      .where(pk)
      .returning();
    return toResponse(row);
  }
}

/** 가드 ④: 당일(KST) LLM 생성 로우 수(updated_at 당일 AND model 비NULL)가 상한 이상인가. */
async function dailyCapReached(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(investmentProfiles)
    .where(
      and(
        isNotNull(investmentProfiles.model),
        sql`(${investmentProfiles.updatedAt} AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
      ),
    );
  return (row?.n ?? 0) >= PROFILE_DAILY_GENERATION_CAP;
}

// ── LLM 호출 ──────────────────────────────────────────────────────────────────

let client: Anthropic | undefined;
function getClient(): Anthropic {
  // API 키는 SDK가 ANTHROPIC_API_KEY env에서 읽는다. timeout은 ms 단위(TS SDK).
  client ??= new Anthropic({
    timeout: PROFILE_LLM_TIMEOUT_MS,
    maxRetries: PROFILE_LLM_MAX_RETRIES,
  });
  return client;
}

const SYSTEM_PROMPT = [
  "너는 모의 주식게임의 투자 성향 분석가다.",
  "입력으로 참가자의 수치 통계(JSON)만 받는다. 통계에 없는 사실을 지어내지 마라.",
  "출력은 JSON 객체 하나만, 다른 텍스트 없이:",
  '{"summary": "한국어 3~5문장, 친근한 ~해요체, 참가자를 2인칭 없이 서술", "traits": ["2~6자 한국어 태그 3~5개"]}',
].join("\n");

/**
 * 인젝션 차단(§D8): 프롬프트 입력은 수치 통계 + 유니버스 심볼(+ shared/universe.ts의
 * 정적 종목명)만. users.name 등 사용자 제어 자유 텍스트는 절대 넣지 않는다.
 */
async function generateWithClaude(
  model: string,
  stats: ProfileStats,
  market: Market,
  heldSymbols: string[],
): Promise<ProfileText> {
  const holdings = heldSymbols.map((symbol) => ({
    symbol,
    name: getEntry(market, symbol)?.name ?? symbol, // 유니버스 정적 상수 — 유저 입력 아님
  }));
  const response = await getClient().messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          league: market,
          stats,
          holdings,
          statsGuide: {
            tradeCount: "시즌 체결 횟수",
            buyRatio: "매수 비율(0~1)",
            limitRatio: "지정가 주문 비율(0~1)",
            turnover: "시드머니 대비 회전율(배)",
            holdingCount: "보유 종목 수",
            maxConcentrationPct: "최대 단일 종목 비중(%)",
            realizedPnlPct: "시드 대비 실현손익(%)",
            cashRatioPct: "현금 비중(%)",
            mddPct: "최대 낙폭(%)",
          },
        }),
      },
    ],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error(`LLM 응답에 텍스트 없음 (stop_reason=${response.stop_reason})`);
  }
  return parseProfileText(textBlock.text);
}

/** LLM 출력 파싱·검증 — 코드펜스 허용, 셰이프 불일치는 throw(→ failed 경로). */
export function parseProfileText(raw: string): ProfileText {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(stripped);
  if (typeof parsed !== "object" || parsed === null) throw new Error("LLM 출력이 객체가 아님");
  const { summary, traits } = parsed as { summary?: unknown; traits?: unknown };
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new Error("LLM 출력 summary 누락");
  }
  if (!Array.isArray(traits) || traits.some((t) => typeof t !== "string")) {
    throw new Error("LLM 출력 traits 누락");
  }
  const tags = (traits as string[]).map((t) => t.trim()).filter(Boolean).slice(0, 5);
  if (tags.length < 1) throw new Error("LLM 출력 traits 비어 있음");
  return { summary: summary.trim(), traits: tags };
}
