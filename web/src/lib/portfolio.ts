// 포트폴리오 조회 순수 로직 (GET /api/portfolio) — DB·네트워크 없이 단위 테스트 가능.
// 서버는 평가액을 계산하지 않는다: 원시 {cash, reserved, positions}만 실어 보내고
// 클라이언트가 구독 중인 SSE 가격으로 평가액을 로컬 재계산한다(§9, 리더보드와 동일 원칙).
// 금액은 전부 numeric 문자열 그대로 전달(float 금지) — 합산은 SQL(Postgres)에 위임해 정확.
import type { Market, Side } from "@mockstock/shared";

// ── DB 로우 입력 형태 (drizzle select 결과와 정합) ──
export interface SeasonMetaRow {
  id: string;
  market: Market;
  startsAt: Date;
  endsAt: Date;
  seedMoney: string;
}
export interface PositionRow {
  market: Market;
  symbol: string;
  qty: string;
  costBasis: string;
  realizedPnl: string;
}
export interface OpenOrderRow {
  id: string;
  market: Market;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  qty: string;
  limitPrice: string | null;
  reserved: string | null;
  createdAt: Date;
}

// ── 응답 형태 (클라이언트가 type import) ──
export interface PortfolioPosition {
  market: Market;
  symbol: string;
  qty: string;
  costBasis: string; // 총 취득원가(네이티브 통화). 주당 평단은 costBasis/qty로 파생.
  realizedPnl: string;
}
export interface PortfolioOrder {
  id: string;
  market: Market;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  qty: string;
  limitPrice: string | null;
  reserved: string | null;
  createdAt: string; // ISO
}
export interface PortfolioResponse {
  season: { id: string; market: Market; startsAt: string; endsAt: string; seedMoney: string };
  cash: string; // 예약분 차감 후 순 현금(네이티브 통화).
  reserved: string; // open 매수 주문 reserved SUM(네이티브 통화).
  realizedPnl: string; // 시즌 누적 실현손익 SUM(네이티브 통화).
  positions: PortfolioPosition[]; // qty>0만.
  openOrders: PortfolioOrder[];
}

/**
 * DB 로우들을 포트폴리오 응답 셰이프로 조립한다.
 * - cash 없음(계좌 미조인) → 시드머니 폴백: lazy upsert(§5.3) 전에도 시드 현금을 노출한다.
 *   GET은 부수효과 금지라 계좌를 만들지 않고 값만 반영한다.
 * - reserved / realizedPnl 없음(SQL 집계 null) → "0".
 */
export function buildPortfolio(
  season: SeasonMetaRow,
  cash: string | null,
  reserved: string | null,
  realizedPnl: string | null,
  positions: PositionRow[],
  openOrders: OpenOrderRow[],
): PortfolioResponse {
  return {
    season: {
      id: season.id,
      market: season.market,
      startsAt: season.startsAt.toISOString(),
      endsAt: season.endsAt.toISOString(),
      seedMoney: season.seedMoney,
    },
    cash: cash ?? season.seedMoney,
    reserved: reserved ?? "0",
    realizedPnl: realizedPnl ?? "0",
    positions: positions.map((p) => ({
      market: p.market,
      symbol: p.symbol,
      qty: p.qty,
      costBasis: p.costBasis,
      realizedPnl: p.realizedPnl,
    })),
    openOrders: openOrders.map((o) => ({
      id: o.id,
      market: o.market,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      qty: o.qty,
      limitPrice: o.limitPrice,
      reserved: o.reserved,
      createdAt: o.createdAt.toISOString(),
    })),
  };
}
