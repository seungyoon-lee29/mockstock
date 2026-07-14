// 홈 대시보드 인덱스 스트립 정의 (코스피·코스닥·S&P500·나스닥). REST 폴링 데이터 계약.
// 시세는 워커가 Yahoo Finance 차트 API로 폴링해 메모리에 보관, /indices로 서빙 → web /api/indices 프록시.
// KR·US 모두 실제 지수(Yahoo, 지연). key는 Yahoo 심볼 스템(^ 접두는 페처가 부여). 인라인 하드코딩 금지.
import type { Market } from "./types";

/** 인덱스 1건 정의 — key는 Yahoo 심볼 스템(^ 접두는 페처가 부여). */
export interface IndexDef {
  key: string;
  label: string; // UI 한국어 라벨
  market: Market;
}

/** 홈 스트립에 노출할 인덱스(시장별). label은 UI 텍스트 한국어. */
export const INDICES: Record<Market, IndexDef[]> = {
  KR: [
    // Yahoo ^KS11(코스피)·^KQ11(코스닥) — 실지수 KRW, 지연. (KIS 업종지수/VTS 아님 — 칩·차트 소스 일치.)
    { key: "KS11", label: "코스피", market: "KR" },
    { key: "KQ11", label: "코스닥", market: "KR" },
  ],
  US: [
    // Yahoo ^GSPC(S&P 500 지수)·^IXIC(나스닥 종합지수) — SPY/QQQ ETF 아님. 지연 시세(실지수).
    { key: "GSPC", label: "S&P 500", market: "US" },
    { key: "IXIC", label: "나스닥", market: "US" },
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
