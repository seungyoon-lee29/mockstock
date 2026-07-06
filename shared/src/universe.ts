import type { Market, SymbolInfo } from "./types";
import { keyOf } from "./types";

export interface UniverseEntry extends SymbolInfo {
  /** mock 시세 기준가 & 전일종가 근사. 실 배포에선 instruments.prevClose가 진실. */
  seedPrice: number;
}

// v1 큐레이션 유니버스. (실제 종목명/코드, 가격은 근사치 — mock 및 등락 기준)
// instruments 테이블 seed 소스이기도 하다 (T02).
const US: UniverseEntry[] = [
  ["AAPL", "Apple", 230],
  ["MSFT", "Microsoft", 480],
  ["NVDA", "NVIDIA", 178],
  ["GOOGL", "Alphabet", 205],
  ["AMZN", "Amazon", 222],
  ["META", "Meta Platforms", 705],
  ["TSLA", "Tesla", 348],
  ["AVGO", "Broadcom", 225],
  ["AMD", "AMD", 168],
  ["NFLX", "Netflix", 905],
  ["JPM", "JPMorgan Chase", 285],
  ["V", "Visa", 352],
  ["DIS", "Disney", 118],
  ["KO", "Coca-Cola", 71],
  ["PLTR", "Palantir", 82],
  ["COIN", "Coinbase", 305],
  ["UBER", "Uber", 92],
  ["SBUX", "Starbucks", 101],
].map(([symbol, name, seedPrice]) => ({
  market: "US" as Market,
  symbol: symbol as string,
  name: name as string,
  currency: "USD" as const,
  seedPrice: seedPrice as number,
}));

const KR: UniverseEntry[] = [
  ["005930", "삼성전자", 75000],
  ["000660", "SK하이닉스", 210000],
  ["373220", "LG에너지솔루션", 380000],
  ["207940", "삼성바이오로직스", 1050000],
  ["005380", "현대차", 250000],
  ["000270", "기아", 110000],
  ["068270", "셀트리온", 190000],
  ["035420", "NAVER", 220000],
  ["035720", "카카오", 45000],
  ["005490", "POSCO홀딩스", 400000],
  ["051910", "LG화학", 350000],
  ["006400", "삼성SDI", 350000],
  ["105560", "KB금융", 95000],
  ["055550", "신한지주", 55000],
  ["012330", "현대모비스", 260000],
  ["066570", "LG전자", 95000],
  ["015760", "한국전력", 24000],
  ["034730", "SK", 170000],
].map(([symbol, name, seedPrice]) => ({
  market: "KR" as Market,
  symbol: symbol as string,
  name: name as string,
  currency: "KRW" as const,
  seedPrice: seedPrice as number,
}));

export const UNIVERSE: UniverseEntry[] = [...KR, ...US];

const BY_KEY = new Map(UNIVERSE.map((e) => [keyOf(e.market, e.symbol), e]));

export function getEntry(market: Market, symbol: string): UniverseEntry | undefined {
  return BY_KEY.get(keyOf(market, symbol));
}

export function seedPriceOf(market: Market, symbol: string): number {
  return getEntry(market, symbol)?.seedPrice ?? 100;
}

/** 검색: 심볼/종목명 부분일치 */
export function searchUniverse(q: string, limit = 20): UniverseEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return UNIVERSE.slice(0, limit);
  return UNIVERSE.filter(
    (e) =>
      e.symbol.toLowerCase().includes(s) || e.name.toLowerCase().includes(s),
  ).slice(0, limit);
}
