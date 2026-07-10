// 리더보드 스냅샷 순수 로직 (PRD §9 데이터 경로) — DB·네트워크 없이 단위 테스트 가능.
// 서버는 평가액을 계산하지 않는다: 원시 {cash, reserved, positions}만 실어 보내고
// 클라이언트가 구독 중인 SSE 가격으로 전원 평가액을 로컬 재계산한다(§9).
import type { Market } from "@mockstock/shared";

/**
 * 리더보드 TTL 캐시 유지 시간(ms). §7.7 Neon 각성 억제 — 폴링(refetchInterval 15~30초)당
 * DB 히트를 이 창으로 흡수한다.
 * ponytail: 체결 시 캐시 무효화는 생략 — 폴링 주기가 15~30초라 30초 TTL이 이미 같은 수준의
 * 지연 상한이다. 실시간성이 더 필요해지면 그때 POST /orders 성공 경로에서 무효화 훅을 건다.
 */
export const LEADERBOARD_CACHE_TTL_MS = 30_000;

/** 캐시 신선도 판정 — now·저장시각(ms) 차이가 TTL 미만이면 재사용. */
export function isCacheFresh(now: number, cachedAt: number, ttlMs = LEADERBOARD_CACHE_TTL_MS): boolean {
  return now - cachedAt < ttlMs;
}

/**
 * 클라이언트 리더보드 폴링 간격(ms). 서버 TTL 캐시(30s)와 맞물려 장외 폴링도 DB를 매번 깨우지
 * 않는다(§7.7). react-query refetchInterval 에 그대로 사용.
 */
export const LEADERBOARD_POLL_MS = 20_000;

// ── DB 로우 입력 형태 (drizzle select 결과와 정합) ──
export interface SeasonMetaRow {
  id: string;
  market: Market;
  startsAt: Date;
  endsAt: Date;
  seedMoney: string;
}
export interface AccountRow {
  userId: string;
  name: string | null;
  isBot: boolean;
  isAnonymous: boolean;
  joinedAt: Date;
  cash: string;
}
export interface ReservedRow {
  userId: string;
  reserved: string | null; // open 매수 주문 reserved SUM (SQL 집계, null=합산 대상 없음)
}
export interface PositionRow {
  userId: string;
  market: Market;
  symbol: string;
  qty: string;
  costBasis: string;
}

// ── 응답 형태 ──
export interface PositionOut {
  market: Market;
  symbol: string;
  qty: string;
  costBasis: string;
}
export interface Participant {
  userId: string;
  name: string | null;
  isBot: boolean;
  joinedAt: string;
  cash: string;
  reserved: string;
  positions: PositionOut[];
}
export interface LeaderboardResponse {
  season: { id: string; market: Market; startsAt: string; endsAt: string; seedMoney: string };
  participants: Participant[];
}

/**
 * DB 로우들을 리더보드 응답 셰이프로 조립한다.
 * - 익명(게스트) 참가자 제외(§5.4 — 지표·순위 대상 아님).
 * - reserved 없으면 "0"(open 매수 주문 없음), positions 없으면 [].
 */
export function buildLeaderboard(
  season: SeasonMetaRow,
  accounts: AccountRow[],
  reserved: ReservedRow[],
  positions: PositionRow[],
): LeaderboardResponse {
  const reservedByUser = new Map(reserved.map((r) => [r.userId, r.reserved ?? "0"]));
  const posByUser = new Map<string, PositionOut[]>();
  for (const p of positions) {
    const out: PositionOut = { market: p.market, symbol: p.symbol, qty: p.qty, costBasis: p.costBasis };
    const arr = posByUser.get(p.userId);
    if (arr) arr.push(out);
    else posByUser.set(p.userId, [out]);
  }

  const participants = accounts
    .filter((a) => !a.isAnonymous)
    .map((a) => ({
      userId: a.userId,
      name: a.name,
      isBot: a.isBot,
      joinedAt: a.joinedAt.toISOString(),
      cash: a.cash,
      reserved: reservedByUser.get(a.userId) ?? "0",
      positions: posByUser.get(a.userId) ?? [],
    }));

  return {
    season: {
      id: season.id,
      market: season.market,
      startsAt: season.startsAt.toISOString(),
      endsAt: season.endsAt.toISOString(),
      seedMoney: season.seedMoney,
    },
    participants,
  };
}

// ── 클라이언트 로컬 평가·순위 (§9) — SSE 현재가로 전원 평가액을 재계산 ──
export interface RankedParticipant {
  rank: number;
  userId: string;
  name: string | null;
  isBot: boolean;
  totalValue: number;
  returnAbs: number;
  returnPct: number;
}

/**
 * 참가자별 평가액·수익률을 계산하고 수익률 내림차순으로 순위를 매긴다(§9 클라 로컬 평가).
 * - 평가액 = 현금 + 예약현금 + Σ(보유수량 × 현재가). 리그별 단일 통화 — 환산 없음.
 * - 현재가 미도착(priceOf → undefined)이면 해당 보유는 취득원가(costBasis)로 평가 → 등락 0.
 *   (전 종목 시세가 도착하기 전 순위가 -100%로 튀는 것을 방지, seasons.ts 마크투마켓과 동일 규약.)
 * - 수익률 = (평가액 − 시드) / 시드 × 100. 동률은 userId 오름차순으로 결정적 정렬(폴링 간 행 흔들림 방지).
 * 평가액은 표시 전용(원장 미기록)이라 float 곱을 그대로 쓴다 — seasons.ts holdingsCents 와 동일 판단.
 */
export function rankParticipants(
  participants: Participant[],
  seedMoney: number,
  priceOf: (market: Market, symbol: string) => number | undefined,
): RankedParticipant[] {
  return participants
    .map((p) => {
      let holdings = 0;
      for (const pos of p.positions) {
        const price = priceOf(pos.market, pos.symbol);
        // ponytail: 리그별 단일 통화 — 환산 없이 qty*price. US 시즌이면 USD, KR 시즌이면 KRW.
        holdings += price == null ? Number(pos.costBasis) : Number(pos.qty) * price;
      }
      const totalValue = Number(p.cash) + Number(p.reserved) + holdings;
      const returnAbs = totalValue - seedMoney;
      return {
        userId: p.userId,
        name: p.name,
        isBot: p.isBot,
        totalValue,
        returnAbs,
        returnPct: seedMoney > 0 ? (returnAbs / seedMoney) * 100 : 0,
      };
    })
    .sort((a, b) => b.returnPct - a.returnPct || a.userId.localeCompare(b.userId))
    .map((r, i) => ({ rank: i + 1, ...r }));
}
