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

// ── 시즌 수명주기 상수 (§4.1·§7.6) — 주간 시즌 경계. 단축 시즌은 env로 파라미터화. ──

/** 주간 시즌 시작 요일(월요일). 0=일 … 6=토 (KST 기준). */
export const SEASON_START_WEEKDAY = 1;
/** 주간 시즌 확정 요일·시각(금 15:30 KST, §4.1). endsAt 계산에 사용. */
export const SEASON_END_WEEKDAY = 5;
export const SEASON_END_HOUR_KST = 15;
export const SEASON_END_MINUTE_KST = 30;
