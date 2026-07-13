// 시세 기준선(D12c·d) 순수 로직 — DB·네트워크 없이 단위 테스트 가능.
// 서버(route)는 instruments 로우를 buildBaselineMap 으로 맵핑하고,
// 클라(usePrices)는 applyBaseline/applyTicks 로 키별 ts 병합만 한다.
import {
  UNIVERSE,
  keyOf,
  seedPriceOf,
  toQuote,
  type Market,
  type Quote,
  type Tick,
} from "@mockstock/shared";

/** GET /api/quotes/baseline 응답 항목. 금액은 numeric 문자열 관행(db.md). */
export interface BaselineQuote {
  market: Market;
  symbol: string;
  lastPrice: string;
  prevClose: string;
  /** ISO 8601. NULL(실틱 무경험)이면 병합 시 최저 우선순위(ts=0). */
  lastPriceAt: string | null;
  /**
   * 상장주식수(numeric 정수 문자열) 또는 미상 시 null. 정적 펀더멘털이라 틱 파이프라인(Quote)과
   * 분리 — UI는 이 값과 라이브 quote.price로 시총 = computeMarketCap(shares, price)를 계산한다.
   * NULL(키리스 로컬·미적재)이면 시총 null → "—".
   */
  sharesOutstanding: string | null;
}
/** keyOf(market, symbol) → BaselineQuote */
export type BaselineMap = Record<string, BaselineQuote>;

/** instruments select 결과 셰이프(route 전용 — drizzle numeric은 string). */
export interface InstrumentBaselineRow {
  market: Market;
  symbol: string;
  lastPrice: string | null;
  prevClose: string | null;
  lastPriceAt: Date | null;
  sharesOutstanding: string | null;
}

/**
 * UNIVERSE seedPrice 기저 위에 instruments 로우를 덮어 baseline 맵을 만든다.
 * - rows가 비어도(DATABASE_URL 미설정 등) 전 종목이 seedPrice로 채워진다 — 키리스 로컬 불변식.
 * - 로우의 NULL 컬럼(시드 직후 prevClose 등)은 seedPrice 기저를 유지한다.
 */
export function buildBaselineMap(
  rows: InstrumentBaselineRow[],
  market: Market | null,
): BaselineMap {
  const map: BaselineMap = {};
  for (const e of UNIVERSE) {
    if (market && e.market !== market) continue;
    map[keyOf(e.market, e.symbol)] = {
      market: e.market,
      symbol: e.symbol,
      lastPrice: String(e.seedPrice),
      prevClose: String(e.seedPrice),
      lastPriceAt: null,
      sharesOutstanding: null, // 미적재(키리스 로컬 등) — 시총 "—"
    };
  }
  for (const r of rows) {
    if (market && r.market !== market) continue;
    const k = keyOf(r.market, r.symbol);
    const seed = map[k]?.lastPrice ?? String(seedPriceOf(r.market, r.symbol));
    map[k] = {
      market: r.market,
      symbol: r.symbol,
      lastPrice: r.lastPrice ?? seed,
      prevClose: r.prevClose ?? map[k]?.prevClose ?? seed,
      lastPriceAt: r.lastPriceAt ? r.lastPriceAt.toISOString() : null,
      sharesOutstanding: r.sharesOutstanding ?? null,
    };
  }
  return map;
}

/** baseline 항목의 병합 우선순위 ts — lastPriceAt, 없으면 최저(0: 어떤 실틱에도 진다). */
export function baselineTs(b: BaselineQuote): number {
  return b.lastPriceAt ? Date.parse(b.lastPriceAt) : 0;
}

/**
 * baseline을 quotes 맵에 키별 병합(D12d — 전체 교체 금지).
 * - 기존 quote가 없거나 baseline ts가 더 최신 → baseline으로 채택(price=lastPrice,
 *   change=lastPrice−prevClose).
 * - 기존 틱이 더 최신 → 가격·ts는 유지하고 등락 기준선(prevClose)만 baseline으로 교정
 *   (SSE가 먼저 도착한 경합에서도 change가 seedPrice 기준으로 남지 않게).
 * 변경이 없으면 prev 참조를 그대로 반환(불필요 리렌더 방지).
 */
export function applyBaseline(
  prev: Record<string, Quote>,
  base: BaselineMap,
): Record<string, Quote> {
  let changed = false;
  const next = { ...prev };
  for (const [k, b] of Object.entries(base)) {
    const ts = baselineTs(b);
    const prevClose = Number(b.prevClose);
    const cur = next[k];
    if (!cur || ts > cur.ts) {
      next[k] = toQuote(
        { market: b.market, symbol: b.symbol, price: Number(b.lastPrice), ts },
        prevClose,
      );
      changed = true;
    } else if (cur.prevClose !== prevClose) {
      // source 보존 필수 — 유실되면 mock 틱이 source 세탁으로 차트 가드를 통과하고,
      // source 변동이 useCandles effect 재실행(실피드 v 이중 계상)을 유발한다.
      next[k] = toQuote(
        { market: cur.market, symbol: cur.symbol, price: cur.price, ts: cur.ts, source: cur.source },
        prevClose,
      );
      changed = true;
    }
  }
  return changed ? next : prev;
}

/**
 * SSE snapshot/ticks를 키별 병합 — 기존 quote보다 ts가 최신인 틱만 채택(역행·중복 차단).
 * change 기준선은 prevCloses(baseline) → 기존 quote prevClose → seedPrice 순 폴백.
 * 변경이 없으면 prev 참조를 그대로 반환.
 */
export function applyTicks(
  prev: Record<string, Quote>,
  ticks: Tick[],
  prevCloses: Record<string, number>,
): Record<string, Quote> {
  let changed = false;
  const next = { ...prev };
  for (const t of ticks) {
    const k = keyOf(t.market, t.symbol);
    const cur = next[k]; // 같은 배치 내 동일 심볼 중복 틱도 순서대로 비교
    if (cur && t.ts <= cur.ts) continue;
    next[k] = toQuote(t, prevCloses[k] ?? cur?.prevClose ?? seedPriceOf(t.market, t.symbol));
    changed = true;
  }
  return changed ? next : prev;
}
