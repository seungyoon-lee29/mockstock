// 시장 휴장일 · 세션 오버라이드 데이터 (KRX · NYSE 2026).
//
// 정례가 아니므로 연 1회 + 발표 시 수동 패치로 갱신한다(PRD §7.5). 날짜는 전부
// 해당 시장의 현지 날짜("YYYY-MM-DD"), 시각은 현지 "HH:MM"(24h).
//
// 출처(공식·확정):
//  - NYSE: https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx
//  - KRX 신정~성탄절: https://www.calendarlabs.com/krx-market-holidays-2026/ (KRX 공식 일정 반영)
//  - KRX 6/3 지방선거·7/17 제헌절 휴장: https://www.sedaily.com/article/20046212 (제헌절 대통령령 제36290호로 공휴일 재지정)
//  - KRX 12/31 연말 휴장 · 1/2 10:00 지연 개장: https://corp.tossinvest.com/en/post?type=notice&id=18534&category=52
//  - 수능일(2026-11-19) 지연 개폐장: 2027학년도 수능 https://www.korea.kr/briefing/pressReleaseView.do?newsId=156646031
//    (KRX는 매년 수능일 정규장을 1시간 지연 개폐장 — 공식 공지 시 시각 재확인)
import type { Market } from "../types";

/** 날짜별 세션 오버라이드. 지정 시 해당 날짜의 정규장 시각/휴장을 대체한다. */
export interface SessionOverride {
  open?: string; // "HH:MM" 현지 — 개장 지연(수능일·연초 등)
  close?: string; // "HH:MM" 현지 — 조기 마감(US 반일장 등)
  closed?: boolean; // 임시 휴장
}

// KRX 2026 정규 휴장일
const KR_HOLIDAYS_2026 = [
  "2026-01-01", // 신정
  "2026-02-16", // 설날 연휴
  "2026-02-17", // 설날
  "2026-02-18", // 설날 연휴
  "2026-03-02", // 삼일절 대체공휴일(3/1 일요일)
  "2026-05-01", // 근로자의 날
  "2026-05-05", // 어린이날
  "2026-05-25", // 부처님오신날 대체공휴일(5/24 일요일)
  "2026-06-03", // 제9회 전국동시지방선거
  "2026-07-17", // 제헌절(2026년 공휴일 재지정)
  "2026-08-17", // 광복절 대체공휴일(8/15 토요일)
  "2026-09-24", // 추석 연휴
  "2026-09-25", // 추석
  "2026-10-05", // 개천절 대체공휴일(10/3 토요일)
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
  "2026-12-31", // 연말 휴장일
];

// NYSE 2026 정규 휴장일
const US_HOLIDAYS_2026 = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King, Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day(관측일, 7/4 토요일)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
];

export const HOLIDAYS: Record<Market, Set<string>> = {
  KR: new Set(KR_HOLIDAYS_2026),
  US: new Set(US_HOLIDAYS_2026),
};

export const OVERRIDES: Record<Market, Map<string, SessionOverride>> = {
  KR: new Map([
    ["2026-01-02", { open: "10:00" }], // 연초 개장 1시간 지연(마감 15:30 유지)
    ["2026-11-19", { open: "10:00", close: "16:30" }], // 수능일 1시간 지연 개폐장
  ]),
  US: new Map([
    ["2026-11-27", { close: "13:00" }], // 추수감사절 다음날 반일장(13:00 ET 조기 마감)
    ["2026-12-24", { close: "13:00" }], // 크리스마스 이브 반일장
  ]),
};
