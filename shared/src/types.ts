// 도메인 공통 타입 — web·worker 공용 계약. (구 web/src/lib/market/types.ts)

export type Market = "US" | "KR";
export type Currency = "USD" | "KRW";
export type Side = "buy" | "sell";

export interface SymbolInfo {
  market: Market;
  symbol: string; // "AAPL" | "005930"
  name: string; // "Apple" | "삼성전자"
  currency: Currency;
  /** 검색용 별칭(D5) — US 종목 한국어명("애플" 등). searchUniverse가 부분일치 매칭. */
  aliases?: string[];
}

/** 워커/피드가 보내는 원시 체결 틱 */
export interface Tick {
  market: Market;
  symbol: string;
  price: number;
  ts: number; // epoch ms
  source?: "mock" | "finnhub" | "kis"; // B4: mock 틱은 instruments 영속화에서 제외
}

/** UI가 쓰는 시세 (전일종가 대비 등락 포함) */
export interface Quote {
  market: Market;
  symbol: string;
  price: number;
  prevClose: number;
  change: number; // price - prevClose
  changePct: number; // %
  ts: number;
  /** 원 틱의 피드 출처 — mock 틱을 차트 반영에서 걸러내는 데 사용(B4 확장). */
  source?: Tick["source"];
}

export function toQuote(tick: Tick, prevClose: number): Quote {
  const change = tick.price - prevClose;
  return {
    market: tick.market,
    symbol: tick.symbol,
    price: tick.price,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    ts: tick.ts,
    // source 미상 틱(baseline 합성 등)은 키 자체를 생략 — deepEqual 소비자·직렬화에 잡음 없게.
    ...(tick.source !== undefined ? { source: tick.source } : {}),
  };
}

/** "US:AAPL" 형태의 안정적 키 */
export function keyOf(market: Market, symbol: string): string {
  return `${market}:${symbol}`;
}
