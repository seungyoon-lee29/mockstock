// 리플레이(과거장 훈련소) 순수 로직 — 클라이언트 로컬 재생·로컬 체결(PRD §5.3).
// 실계좌 체결(fillOrder/DB)과 분리된 훈련 모드라 여기서는 DB를 쓰지 않는다(성적만 replay_sessions에 기록).
// 정적 JSON은 public/replay/<scenario>/ 아래. 시나리오 v1은 1개(2020 코로나 폭락).
import { SEED_MONEY_KRW } from "@mockstock/shared";

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
export type Candle = { date: string; o: number; h: number; l: number; c: number; v: number };
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
