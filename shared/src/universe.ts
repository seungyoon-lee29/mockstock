import type { Market, SymbolInfo } from "./types";
import { keyOf } from "./types";

export interface UniverseEntry extends SymbolInfo {
  /** mock 시세 기준가 & 전일종가 근사. 실 배포에선 instruments.prevClose가 진실. */
  seedPrice: number;
}

// v1 큐레이션 유니버스. (실제 종목명/코드, 가격은 근사치 — mock 및 등락 기준)
// instruments 테이블 seed 소스이기도 하다 (T02).
//
// ⚠️ 배열 순서 = 시총 순 근사 — 봇 TOPCAP이 시장별 앞 5개를 홀딩 대상으로 가정(worker/bots.ts).
//    기존 종목의 순서는 절대 변경 금지, 신규 종목은 각 시장 배열 "뒤에만" 추가한다(D6).
// 피드 한도: KIS 세션당 41(KR 38 ≤ 41) / Finnhub 커넥션당 50(US 48 ≤ 50).

type UsRow = [symbol: string, name: string, seedPrice: number, aliases: string[]];
type KrRow = [symbol: string, name: string, seedPrice: number];

const US_ROWS: UsRow[] = [
  // ── 기존 18 (순서 불변) ──────────────────────────────────────────────
  ["AAPL", "Apple", 230, ["애플"]],
  ["MSFT", "Microsoft", 480, ["마이크로소프트"]],
  ["NVDA", "NVIDIA", 178, ["엔비디아"]],
  ["GOOGL", "Alphabet", 205, ["알파벳", "구글"]],
  ["AMZN", "Amazon", 222, ["아마존"]],
  ["META", "Meta Platforms", 705, ["메타", "페이스북"]],
  ["TSLA", "Tesla", 348, ["테슬라"]],
  ["AVGO", "Broadcom", 225, ["브로드컴"]],
  ["AMD", "AMD", 168, ["에이엠디"]],
  ["NFLX", "Netflix", 905, ["넷플릭스"]],
  ["JPM", "JPMorgan Chase", 285, ["제이피모건", "JP모건"]],
  ["V", "Visa", 352, ["비자"]],
  ["DIS", "Disney", 118, ["디즈니"]],
  ["KO", "Coca-Cola", 71, ["코카콜라"]],
  ["PLTR", "Palantir", 82, ["팔란티어"]],
  ["COIN", "Coinbase", 305, ["코인베이스"]],
  ["UBER", "Uber", 92, ["우버"]],
  ["SBUX", "Starbucks", 101, ["스타벅스"]],
  // ── D6 확대분 30 (대형주, 뒤에만 추가) ────────────────────────────────
  ["LLY", "Eli Lilly", 780, ["일라이릴리", "릴리"]],
  ["WMT", "Walmart", 100, ["월마트"]],
  ["JNJ", "Johnson & Johnson", 155, ["존슨앤드존슨", "존슨앤존슨"]],
  ["XOM", "Exxon Mobil", 112, ["엑슨모빌"]],
  ["PG", "Procter & Gamble", 160, ["피앤지", "프록터앤드갬블"]],
  ["MA", "Mastercard", 560, ["마스터카드"]],
  ["HD", "Home Depot", 365, ["홈디포"]],
  ["COST", "Costco", 980, ["코스트코"]],
  ["ORCL", "Oracle", 230, ["오라클"]],
  ["MRK", "Merck", 85, ["머크"]],
  ["CVX", "Chevron", 150, ["셰브론", "쉐브론"]],
  ["ABBV", "AbbVie", 190, ["애브비"]],
  ["CRM", "Salesforce", 270, ["세일즈포스"]],
  ["BAC", "Bank of America", 47, ["뱅크오브아메리카"]],
  ["PEP", "PepsiCo", 135, ["펩시코", "펩시"]],
  ["MCD", "McDonald's", 295, ["맥도날드"]],
  ["CSCO", "Cisco", 68, ["시스코"]],
  ["ADBE", "Adobe", 390, ["어도비"]],
  ["TMO", "Thermo Fisher Scientific", 420, ["써모피셔", "서모피셔"]],
  ["INTC", "Intel", 23, ["인텔"]],
  ["QCOM", "Qualcomm", 160, ["퀄컴"]],
  ["TXN", "Texas Instruments", 195, ["텍사스인스트루먼트"]],
  ["AMAT", "Applied Materials", 185, ["어플라이드머티리얼즈"]],
  ["BA", "Boeing", 210, ["보잉"]],
  ["GS", "Goldman Sachs", 700, ["골드만삭스"]],
  ["PYPL", "PayPal", 75, ["페이팔"]],
  ["ABNB", "Airbnb", 135, ["에어비앤비"]],
  ["SNOW", "Snowflake", 220, ["스노우플레이크"]],
  ["SHOP", "Shopify", 115, ["쇼피파이"]],
  ["GE", "GE Aerospace", 250, ["제너럴일렉트릭", "GE에어로스페이스"]],
];

const US: UniverseEntry[] = US_ROWS.map(([symbol, name, seedPrice, aliases]) => ({
  market: "US" as Market,
  symbol,
  name,
  currency: "USD" as const,
  seedPrice,
  aliases,
}));

const KR_ROWS: KrRow[] = [
  // ── 기존 18 (순서 불변) ──────────────────────────────────────────────
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
  // ── D6 확대분 20 (KOSPI 시총 상위권, 뒤에만 추가) ─────────────────────
  ["012450", "한화에어로스페이스", 900000],
  ["329180", "HD현대중공업", 420000],
  ["259960", "크래프톤", 380000],
  ["017670", "SK텔레콤", 55000],
  ["033780", "KT&G", 120000],
  ["323410", "카카오뱅크", 22000],
  ["028260", "삼성물산", 140000],
  ["086790", "하나금융지주", 65000],
  ["032830", "삼성생명", 110000],
  ["000810", "삼성화재", 400000],
  ["316140", "우리금융지주", 17000],
  ["024110", "기업은행", 15000],
  ["003670", "포스코퓨처엠", 150000],
  ["009150", "삼성전기", 140000],
  ["096770", "SK이노베이션", 110000],
  ["003550", "LG", 80000],
  ["030200", "KT", 50000],
  ["010130", "고려아연", 800000],
  ["011200", "HMM", 20000],
  ["034020", "두산에너빌리티", 55000],
];

const KR: UniverseEntry[] = KR_ROWS.map(([symbol, name, seedPrice]) => ({
  market: "KR" as Market,
  symbol,
  name,
  currency: "KRW" as const,
  seedPrice,
}));

export const UNIVERSE: UniverseEntry[] = [...KR, ...US];

const BY_KEY = new Map(UNIVERSE.map((e) => [keyOf(e.market, e.symbol), e]));

export function getEntry(market: Market, symbol: string): UniverseEntry | undefined {
  return BY_KEY.get(keyOf(market, symbol));
}

export function seedPriceOf(market: Market, symbol: string): number {
  return getEntry(market, symbol)?.seedPrice ?? 100;
}

/** 검색: 심볼/종목명/한국어 alias(D5) 부분일치 */
export function searchUniverse(q: string, limit = 20): UniverseEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return UNIVERSE.slice(0, limit);
  return UNIVERSE.filter(
    (e) =>
      e.symbol.toLowerCase().includes(s) ||
      e.name.toLowerCase().includes(s) ||
      e.aliases?.some((a) => a.toLowerCase().includes(s)),
  ).slice(0, limit);
}
