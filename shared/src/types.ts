// 도메인 공통 타입 — web·worker 공용 계약. (구 web/src/lib/market/types.ts)

export type Market = "US" | "KR";
export type Currency = "USD" | "KRW";
export type Side = "buy" | "sell";

export interface SymbolInfo {
  market: Market;
  symbol: string; // "AAPL" | "005930"
  name: string; // "Apple" | "삼성전자"
  currency: Currency;
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
  };
}

/** "US:AAPL" 형태의 안정적 키 */
export function keyOf(market: Market, symbol: string): string {
  return `${market}:${symbol}`;
}
