// AI 투자 성향 통계(§D9) — DB·네트워크 없는 순수 계산. 단위 테스트 대상.
// 금액은 numeric 문자열 → 정수 센트로 계산(fillOrder.ts와 동일 관행, float 오차 금지).
// 여기서 산출한 수치 통계 + 유니버스 심볼만 프롬프트에 들어간다(인젝션 차단, §D8).
import { createHash } from "node:crypto";

// ── 입력 로우 (drizzle select 결과와 정합) ──
export interface FilledOrderRow {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: string;
  filledPrice: string | null;
}
export interface ProfilePositionRow {
  symbol: string;
  qty: string;
  costBasis: string;
  realizedPnl: string;
}
export interface SnapshotRow {
  /** date 오름차순 정렬 전제 */
  totalValue: string;
}

/** §D9의 9개 수치. 비율은 소수 3자리, %·배수는 소수 2자리로 라운딩(해시 안정성). */
export interface ProfileStats {
  /** ① 체결 거래 횟수 */
  tradeCount: number;
  /** ② 매수 비율(0~1) — 매수/매도 비율의 정규화 표현 */
  buyRatio: number;
  /** ③ 지정가 사용률(0~1) */
  limitRatio: number;
  /** ④ 회전율 — 총 체결대금 / 시드머니(배) */
  turnover: number;
  /** ⑤ 보유 종목 수(qty>0) */
  holdingCount: number;
  /** ⑥ 최대 집중도 — 최대 단일 종목 원가 / (현금+총원가) % */
  maxConcentrationPct: number;
  /** ⑦ 실현손익 — 시드머니 대비 % */
  realizedPnlPct: number;
  /** ⑧ 현금 비중 — 현금 / (현금+총원가) % */
  cashRatioPct: number;
  /** ⑨ 최대낙폭(MDD) — 스냅샷 totalValue 피크 대비 최대 하락 % */
  mddPct: number;
}

// numeric 문자열 ↔ 정수 센트 (fillOrder.ts 관행 복제 — 해당 함수는 모듈 프라이빗)
function toCents(v: string): number {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const cents = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -cents : cents;
}

const round = (v: number, digits: number): number => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

export function computeProfileStats(input: {
  seedMoney: string;
  cash: string | null;
  orders: FilledOrderRow[];
  positions: ProfilePositionRow[];
  snapshots: SnapshotRow[];
}): ProfileStats {
  const seedCents = toCents(input.seedMoney);
  const cashCents = toCents(input.cash ?? input.seedMoney); // 계좌 미생성 = 시드 전액 현금

  // ①②③④ — filled 주문 집계
  const tradeCount = input.orders.length;
  let buyCount = 0;
  let limitCount = 0;
  let notionalCents = 0; // 총 체결대금(매수+매도)
  for (const o of input.orders) {
    if (o.side === "buy") buyCount += 1;
    if (o.type === "limit") limitCount += 1;
    if (o.filledPrice != null) {
      notionalCents += Math.round(toCents(o.filledPrice) * Number(o.qty));
    }
  }
  const buyRatio = tradeCount > 0 ? round(buyCount / tradeCount, 3) : 0;
  const limitRatio = tradeCount > 0 ? round(limitCount / tradeCount, 3) : 0;
  const turnover = seedCents > 0 ? round(notionalCents / seedCents, 2) : 0;

  // ⑤⑥⑦⑧ — 포지션·현금. realizedPnl은 전량 매도(qty=0) 잔여 로우 포함 전체 합산.
  let holdingCount = 0;
  let costSumCents = 0;
  let maxCostCents = 0;
  let realizedCents = 0;
  for (const p of input.positions) {
    realizedCents += toCents(p.realizedPnl);
    if (Number(p.qty) > 0) {
      holdingCount += 1;
      const cost = toCents(p.costBasis);
      costSumCents += cost;
      if (cost > maxCostCents) maxCostCents = cost;
    }
  }
  const baseCents = cashCents + costSumCents; // 원가 기준 총자산(평가액은 시세 의존이라 제외)
  const maxConcentrationPct = baseCents > 0 ? round((maxCostCents / baseCents) * 100, 2) : 0;
  const cashRatioPct = baseCents > 0 ? round((cashCents / baseCents) * 100, 2) : 0;
  const realizedPnlPct = seedCents > 0 ? round((realizedCents / seedCents) * 100, 2) : 0;

  // ⑨ MDD — 피크 대비 최대 하락률(스냅샷 date 오름차순 전제)
  let peak = 0;
  let mdd = 0;
  for (const s of input.snapshots) {
    const v = toCents(s.totalValue);
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > mdd) mdd = dd;
    }
  }
  const mddPct = round(mdd * 100, 2);

  return {
    tradeCount,
    buyRatio,
    limitRatio,
    turnover,
    holdingCount,
    maxConcentrationPct,
    realizedPnlPct,
    cashRatioPct,
    mddPct,
  };
}

/**
 * input_hash — 통계 + 보유 심볼(정렬)의 직렬화 해시.
 * 같은 입력이면 같은 해시 → 재생성 스킵(가드 ③). 키 순서는 객체 리터럴로 고정.
 */
export function hashProfileInput(stats: ProfileStats, symbols: string[]): string {
  const payload = JSON.stringify({ stats, symbols: [...symbols].sort() });
  return createHash("sha256").update(payload).digest("hex");
}
