// 시장가 주문 순수 검증·판정 로직 (T04). DB·네트워크 없이 단위 테스트 가능하도록
// route.ts에서 분리한다(입력 검증·신선도 판정·mock-open 판정·FillResult→HTTP 매핑).
import { getEntry, SNAPSHOT_MAX_AGE_MS, type Market, type Side } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import type { FillResult } from "@mockstock/shared/fillOrder";

// PRD §6.1·§6.3 신선도 게이트(30초). T08에서 shared/src/rules.ts로 승격(web·worker 공용) — 여기선 재노출만.
export { SNAPSHOT_MAX_AGE_MS };

/** 클라이언트가 보내는 시장가 주문 입력(신뢰 경계 통과분). userId·seasonId는 서버 결정이라 제외(§6.1). */
export interface MarketOrderInput {
  market: Market;
  symbol: string;
  side: Side;
  qty: number;
  idempotencyKey: string;
}

// §6.1: idempotencyKey는 UUIDv4 형식을 서버가 강제한다.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 입력 6필드 중 시장가에 필요한 5개만 검증. 실패 시 한국어 사유 반환(외부 검증 라이브러리 금지). */
export function parseMarketOrderInput(
  raw: unknown,
): { ok: true; value: MarketOrderInput } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "요청 본문이 올바르지 않습니다." };
  }
  const b = raw as Record<string, unknown>;

  if (b.market !== "US" && b.market !== "KR") {
    return { ok: false, message: "시장(market)이 올바르지 않습니다." };
  }
  const market = b.market;

  if (b.side !== "buy" && b.side !== "sell") {
    return { ok: false, message: "주문 방향(side)이 올바르지 않습니다." };
  }
  const side = b.side;

  if (typeof b.symbol !== "string" || !getEntry(market, b.symbol)) {
    return { ok: false, message: "종목(symbol)이 유니버스에 없습니다." };
  }
  const symbol = b.symbol;

  if (typeof b.qty !== "number" || !Number.isInteger(b.qty) || b.qty <= 0) {
    return { ok: false, message: "수량(qty)은 1 이상의 정수여야 합니다." };
  }
  const qty = b.qty;

  if (typeof b.idempotencyKey !== "string" || !UUID_V4.test(b.idempotencyKey)) {
    return { ok: false, message: "idempotencyKey는 UUIDv4 형식이어야 합니다." };
  }

  return { ok: true, value: { market, symbol, side, qty, idempotencyKey: b.idempotencyKey } };
}

/**
 * 주문 입력 파싱 — `limitPrice`가 있으면 지정가(§6.4), 없으면 시장가. 나머지 5필드는 공통 검증.
 * 클라 입력은 6필드뿐(market·symbol·side·qty·limitPrice·idempotencyKey) — type은 서버가 파생(신뢰 경계 §6.1).
 */
export function parseOrderInput(
  raw: unknown,
):
  | { ok: true; type: "market"; value: MarketOrderInput }
  | { ok: true; type: "limit"; value: MarketOrderInput & { limitPrice: number } }
  | { ok: false; message: string } {
  const base = parseMarketOrderInput(raw);
  if (!base.ok) return base;
  const lp = (raw as Record<string, unknown>).limitPrice;
  if (lp === undefined || lp === null) return { ok: true, type: "market", value: base.value };
  if (typeof lp !== "number" || !Number.isFinite(lp) || lp <= 0) {
    return { ok: false, message: "지정가(limitPrice)는 0보다 큰 숫자여야 합니다." };
  }
  return { ok: true, type: "limit", value: { ...base.value, limitPrice: lp } };
}

/** 스냅샷 신선도: now − at ≤ 30초면 신선. 초과·워커 실패(호출부에서 null 처리)는 fail-closed(§6.1). */
export function isSnapshotFresh(nowMs: number, atMs: number, maxAgeMs = SNAPSHOT_MAX_AGE_MS): boolean {
  return nowMs - atMs <= maxAgeMs;
}

/**
 * 시장가 접수 가능 여부. tick.source==='mock'이면 세션 판정과 무관하게 open 간주(PRD §7.5 —
 * FEED env는 워커 소관이라 web은 스냅샷의 source로 판단). 그 외엔 시장 캘린더 정규장만.
 */
export function isMarketTradable(market: Market, source: string | undefined, at: Date): boolean {
  if (source === "mock") return true;
  return isMarketOpen(market, at);
}

/** fillOrder FillResult 전 케이스를 HTTP 상태 + 한국어 메시지로 매핑(§6.1·ticket §8). */
export function fillResultToHttp(r: FillResult): { httpStatus: number; message: string } {
  if (r.ok) return { httpStatus: 200, message: "체결되었습니다." };
  switch (r.reason) {
    case "already-filled":
      return { httpStatus: 200, message: "이미 처리된 주문입니다." };
    case "insufficient-cash":
      return { httpStatus: 422, message: "주문 가능 현금이 부족합니다." };
    case "insufficient-qty":
      return { httpStatus: 422, message: "보유 수량이 부족합니다." };
    case "over-limit":
      return { httpStatus: 422, message: "종목당 매수 상한(시드의 40%)을 초과했습니다." };
  }
}
