// 게임 규칙 상수 — 매직 넘버 인라인 금지(PRD §4.2·§5.3). web·worker·정산 공용.

import type { Market } from "./types";

/** 시즌 시작 시드 현금 — 리그별 네이티브 통화. KR ₩10,000,000 / US $10,000. */
export const SEED_MONEY_KRW = 10_000_000;
export const SEED_MONEY_USD = 10_000;
/** 리그 → 시드 맵. 시즌 생성·봇 예산이 market으로 조회. */
export const SEED_MONEY: Record<Market, number> = { KR: SEED_MONEY_KRW, US: SEED_MONEY_USD };

/** 종목당 매수 상한 = 시드의 40%(§4.2 몰빵 방지 → 최소 3종목 분산 강제). */
export const POSITION_LIMIT_PCT = 0.4;

/** 시드머니 기준 종목당 매수 상한(네이티브 통화, currency-agnostic). 40% 상한 재검증(§6.4). */
export function positionLimit(seedMoney: number): number {
  return seedMoney * POSITION_LIMIT_PCT;
}

/**
 * 시세 신선도 게이트(ms). now − at > 이 값이면 fail-closed(§6.1) — 스테일가 체결 금지.
 * web 주문 API(시장가)와 worker 지정가 매칭 루프(§6.3)가 동일 값을 공유한다.
 */
export const SNAPSHOT_MAX_AGE_MS = 30_000;

// ── AI 투자 성향 요약 (§D8) — 남용 가드·lease·LLM 정책 값. web 프로필 파이프라인 전용. ──

/** 가드 ②: 이 체결 건수 미만이면 LLM 없이 status='insufficient'. */
export const PROFILE_MIN_FILLED_ORDERS = 5;
/** lease 만료(ms) — pending placeholder의 generation_started_at이 이보다 오래되면 takeover 허용. */
export const PROFILE_LEASE_MS = 2 * 60_000;
/** insufficient/failed 후 재시도 허용까지의 간격(ms) — retry_after 계산(즉시 재시도 폭주 차단). */
export const PROFILE_RETRY_AFTER_MS = 5 * 60_000;
/** 가드 ③: ok 프로필 재생성 최소 간격(ms) — input_hash 불일치여도 이 간격 전엔 유지. */
export const PROFILE_REGEN_MIN_INTERVAL_MS = 60 * 60_000;
/** 가드 ④: 전역 일일 LLM 생성 상한(KST 기준, model 비NULL 로우 수). 초과 시 규칙 폴백. */
export const PROFILE_DAILY_GENERATION_CAP = 200;
/** LLM 호출 타임아웃(ms)·재시도 횟수 — 라우트 maxDuration 산정의 근거. */
export const PROFILE_LLM_TIMEOUT_MS = 15_000;
export const PROFILE_LLM_MAX_RETRIES = 1;
/** env ANTHROPIC_MODEL 미설정 시 기본 모델. */
export const PROFILE_DEFAULT_MODEL = "claude-haiku-4-5";

// ── 시즌 수명주기 상수 (§4.1·§7.6) — 단축 시즌은 env로 파라미터화. ──
// 월간(달력월)이 기본 시즌 경계다. 주간(아래 WEEKDAY 상수 + weeklyPeriod)은 레거시/테스트용으로만 남긴다.

/** 주간 시즌 시작 요일(월요일). 0=일 … 6=토 (KST 기준). 레거시 weeklyPeriod 전용. */
export const SEASON_START_WEEKDAY = 1;
/** 주간 시즌 확정 요일(금, 레거시 weeklyPeriod 전용). */
export const SEASON_END_WEEKDAY = 5;
/** 장 마감 시각(KR 15:30 KST). 주간·월간 KR 마감 endsAt 계산에 공용. */
export const SEASON_END_HOUR_KST = 15;
export const SEASON_END_MINUTE_KST = 30;
