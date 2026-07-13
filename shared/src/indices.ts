// 홈 대시보드 인덱스 스트립 정의 (코스피·코스닥·S&P500·나스닥). REST 폴링 데이터 계약.
// 시세는 워커가 KIS/Finnhub REST로 폴링해 메모리에 보관, /indices로 서빙 → web /api/indices 프록시.
// KR = KIS 업종지수(0001/1001), US = ETF 프록시(SPY/QQQ). 여기 정의를 워커가 소비 — 인라인 하드코딩 금지.
import type { Market } from "./types";

/** 인덱스 1건 정의 — key는 KIS 업종코드(KR) 또는 Finnhub 심볼(US). */
export interface IndexDef {
  key: string;
  label: string; // UI 한국어 라벨
  market: Market;
}

/** 홈 스트립에 노출할 인덱스(시장별). label은 UI 텍스트 한국어. */
export const INDICES: Record<Market, IndexDef[]> = {
  KR: [
    { key: "0001", label: "코스피", market: "KR" },
    { key: "1001", label: "코스닥", market: "KR" },
  ],
  US: [
    { key: "SPY", label: "S&P 500", market: "US" },
    { key: "QQQ", label: "나스닥", market: "US" },
  ],
};

/** 폴링 1회의 인덱스 시세 스냅샷. value/change/changePct는 소수, ts = epoch ms. */
export interface IndexQuote {
  key: string;
  label: string;
  market: Market;
  value: number;
  change: number;
  changePct: number;
  ts: number;
}

/** /indices 응답 계약 — 시장별 IndexQuote 배열(키 없으면 빈 배열). */
export interface IndicesPayload {
  KR: IndexQuote[];
  US: IndexQuote[];
}
