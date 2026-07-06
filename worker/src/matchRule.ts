// 지정가 체결 판정 — 순수 함수(DB·시세북·시각 부수효과 없음). matching 루프가 호출, 단위 테스트 대상.
// 판정 3관문(§6.3): ① 시장 open(mock 소스면 open 간주 §7.5, 아니면 캘린더) ② 틱 신선도(SNAPSHOT_MAX_AGE_MS)
//   ③ 가격 도달(매수 tick≤limit / 매도 tick≥limit). 도달 시 체결가 = 갭 통과해도 유리한 실제 틱가.
import { SNAPSHOT_MAX_AGE_MS, type Market, type Side, type Tick } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";

export type MatchDecision = { fill: false } | { fill: true; price: number };

/**
 * 도달 판정. `tick`이 없거나(시세 미수신) 시장 마감·스테일·미도달이면 `{ fill:false }`.
 * 체결가는 매수 min(limit, tick)·매도 max(limit, tick) — 갭 통과 시 사용자에게 유리한 틱가(§6.3).
 */
export function matchDecision(
  side: Side,
  limitPrice: number,
  market: Market,
  tick: Tick | undefined,
  now: number,
): MatchDecision {
  if (!tick) return { fill: false };

  // ① 시장 open: mock 소스는 세션과 무관하게 open 간주(§7.5, 데모/로컬). 그 외는 캘린더 정규장.
  const open = tick.source === "mock" ? true : isMarketOpen(market, new Date(now));
  if (!open) return { fill: false };

  // ② 신선도: now − ts > 30초면 스테일 → 해당 심볼 스킵(스테일가 체결 금지, §6.3).
  if (now - tick.ts > SNAPSHOT_MAX_AGE_MS) return { fill: false };

  // ③ 도달 + 유리한 체결가.
  if (side === "buy") {
    if (tick.price <= limitPrice) return { fill: true, price: Math.min(limitPrice, tick.price) };
  } else {
    if (tick.price >= limitPrice) return { fill: true, price: Math.max(limitPrice, tick.price) };
  }
  return { fill: false };
}
