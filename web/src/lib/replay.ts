// 리플레이(과거장 훈련소) 순수 로직 — 클라이언트 로컬 재생·로컬 체결(PRD §5.3).
// 실계좌 체결(fillOrder/DB)과 분리된 훈련 모드라 여기서는 DB를 쓰지 않는다(성적만 replay_sessions에 기록).
// 정적 JSON은 public/replay/<scenario>/ 아래. 시나리오 v1은 1개(2020 코로나 폭락).
import {
  SEED_MONEY_KRW,
  aggregateDailyToWeekly,
  aggregateDailyToMonthly,
  type DailyCandle,
} from "@mockstock/shared";

// ── 시나리오·데이터 위치 (단일 소스, 경로 리터럴 산재 금지) ──────────────────────
export const REPLAY_SCENARIO_ID = "covid-2020";
export const manifestUrl = (scenario: string) => `/replay/${scenario}/manifest.json`;
export const candleUrl = (scenario: string, symbol: string) =>
  `/replay/${scenario}/${symbol}.json`;

// ── 재생 속도 정책(§5.3 x1/x10/x30). 간격 = base/speed → 배속이 클수록 하루 간격이 짧다. ──
export const REPLAY_SPEEDS = [1, 10, 30] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const REPLAY_DEFAULT_SPEED: ReplaySpeed = 30;
// ponytail: x30에서 재생 구간 ≈ 2분(PRD §12). 체감 조정 시 이 상수만 손대면 된다.
export const REPLAY_BASE_STEP_MS = 24_000;
export const stepIntervalMs = (speed: number) => REPLAY_BASE_STEP_MS / speed;

// ── 데이터 타입 ──────────────────────────────────────────────────────────────
// 정본은 shared `DailyCandle`(일→주봉 집계와 계약 공유). 기존 importer 호환 위해 별칭 유지.
export type Candle = DailyCandle;
export type ReplayManifest = {
  id: string;
  name: string;
  description: string;
  dataPeriod: { start: string; end: string; note?: string };
  playPeriod: { start: string; end: string };
  reportTailPeriod?: { start: string; end: string };
  symbols: { US: string[]; KR?: unknown };
};

// ── 재생 구간 인덱스 (ISO yyyy-mm-dd는 사전식 비교로 날짜 비교 가능) ───────────────
export function firstIndexOnOrAfter(candles: Candle[], date: string): number {
  const i = candles.findIndex((c) => c.date >= date);
  return i === -1 ? candles.length - 1 : i;
}
export function lastIndexOnOrBefore(candles: Candle[], date: string): number {
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].date <= date) return i;
  return 0;
}

// ── 차트 표시 시리즈 (일/주/월 토글). 재생·매매·성적은 일봉 인덱스 기준, 주·월봉은 표시에만. ──
export type Timeframe = "day" | "week" | "month";

// 미래 누설 금지 불변식: 커서까지(완주+"이후 보기" 시에만 tail) 자른 **뒤** 집계한다.
// 집계 후 주(週)/월(月) 필터는 금지 — 부분 주·월의 h/c에 커서 이후 캔들 OHLC가 새어든다.
export function visibleSeries(
  candles: Candle[],
  cursor: number,
  timeframe: Timeframe,
  opts: { finished: boolean; revealTail: boolean },
): Candle[] {
  const end = opts.finished && opts.revealTail ? candles.length : cursor + 1;
  const visible = candles.slice(0, end);
  if (timeframe === "week") return aggregateDailyToWeekly(visible);
  if (timeframe === "month") return aggregateDailyToMonthly(visible);
  return visible;
}

// ── 로컬 계좌·체결 (시드·현금·포지션). 매수/매도는 현금/보유의 비중(0~1)으로 조작. ──
// 단위 정합: qty = spend(시드단위) / price(USD) 이므로 qty*price·costBasis 모두 시드단위,
// avgCost = costBasis/qty 는 USD로 환원돼 현재가와 비교 가능(환율 상수 없이 자기정합).
export type ReplayAccount = { cash: number; qty: number; costBasis: number; trades: number };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function initAccount(seed = SEED_MONEY_KRW): ReplayAccount {
  return { cash: seed, qty: 0, costBasis: 0, trades: 0 };
}
export function equityOf(a: ReplayAccount, price: number): number {
  return a.cash + a.qty * price;
}
/** 보유 현금의 fraction(0~1)을 현재가로 매수. */
export function buy(a: ReplayAccount, price: number, fraction: number): ReplayAccount {
  const spend = a.cash * clamp01(fraction);
  if (spend <= 0 || price <= 0) return a;
  return {
    cash: a.cash - spend,
    qty: a.qty + spend / price,
    costBasis: a.costBasis + spend,
    trades: a.trades + 1,
  };
}
/** 보유 수량의 fraction(0~1)을 현재가로 매도. */
export function sell(a: ReplayAccount, price: number, fraction: number): ReplayAccount {
  const f = clamp01(fraction);
  const sellQty = a.qty * f;
  if (sellQty <= 0) return a;
  return {
    cash: a.cash + sellQty * price,
    qty: a.qty - sellQty,
    costBasis: a.costBasis * (1 - f),
    trades: a.trades + 1,
  };
}
export function returnPct(equity: number, seed = SEED_MONEY_KRW): number {
  return (equity / seed - 1) * 100;
}

// ── 최대 낙폭(MDD): 자산곡선의 고점 대비 최대 하락률(음수 %). 낙폭 없으면 0. ──
export function maxDrawdown(equityCurve: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak; // ≤ 0
      if (dd < mdd) mdd = dd;
    }
  }
  return mdd * 100;
}

/** 그냥 시작부터 끝까지 보유했을 때 수익률(%) — "실제 역사 vs 나" 비교용. */
export function buyAndHoldReturnPct(candles: Candle[], startIdx: number, endIdx: number): number {
  const base = candles[startIdx]?.c;
  const last = candles[endIdx]?.c;
  if (!base || !last) return 0;
  return (last / base - 1) * 100;
}

// ── 게스트 결과 보존(§194) ─────────────────────────────────────────────────────
// 게스트가 완주 후 로그인하러 떠나면 결과가 로컬 상태와 함께 사라진다. 로그인 왕복(OAuth
// 리다이렉트) 동안 sessionStorage에 결과+멱등키를 보존 → 복귀 시 POST /api/replay 로 한 번만
// 재제출. 멱등키 `id`는 재제출 시 replay_sessions PK로 그대로 쓰여 서버 onConflictDoNothing 이
// 새로고침·중복 트리거의 이중 저장을 차단한다(결과 정확성).
export const REPLAY_PENDING_KEY = "mockstock.replay.pending";

export type PendingReplayResult = {
  id: string; // 멱등키 = 재제출 시 PK
  scenarioId: string;
  returnPct: number;
  mdd: number;
};

export function savePendingReplay(r: PendingReplayResult): void {
  try {
    sessionStorage.setItem(REPLAY_PENDING_KEY, JSON.stringify(r));
  } catch {
    /* 저장 불가(프라이빗 모드 등) — 보존 못 하면 기존 게스트 CTA로 폴백 */
  }
}

export function loadPendingReplay(): PendingReplayResult | null {
  try {
    const raw = sessionStorage.getItem(REPLAY_PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingReplayResult>;
    // 손상·구버전 데이터 방어(신뢰 경계 아님 — 서버가 최종 검증·정규화).
    if (
      typeof p.id === "string" &&
      typeof p.scenarioId === "string" &&
      typeof p.returnPct === "number" &&
      typeof p.mdd === "number"
    ) {
      return p as PendingReplayResult;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPendingReplay(): void {
  try {
    sessionStorage.removeItem(REPLAY_PENDING_KEY);
  } catch {
    /* no-op */
  }
}
