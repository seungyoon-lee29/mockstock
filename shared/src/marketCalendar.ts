// 시장 세션 판정 — 시장가 차단·지정가 매칭·lastPrice 갱신 3곳이 모두 경유(B5).
//
// 핵심 규칙:
//  - KST 절대시각 하드코딩 금지. US는 DST로 정규장이 22:30/23:30 KST로 이동하므로
//    IANA tz(America/New_York, Asia/Seoul)를 Intl.DateTimeFormat으로 계산한다.
//  - 정규장 외(프리/애프터마켓) 틱은 폐기 → lastPrice 오염 방지.
//  - 휴장일·오버라이드는 shared/src/data/marketHolidays.ts. 날짜별 오버라이드
//    { open?, close?, closed? } 는 임시공휴일·개폐장 지연·반일장을 덮어쓴다.
//    엔트리 없는 날은 시장 기본 정규장 시간을 따른다.
//  - 이 판정기는 순수 캘린더(달력·tz만 본다). FEED가 mock인 시장은 실제 개장 여부와
//    무관하게 호출부(worker/web)에서 open으로 간주 — 여기서 mock 여부를 판단하지 않는다.
import type { Market } from "./types";
import { HOLIDAYS, OVERRIDES } from "./data/marketHolidays";

export type MarketSession = "open" | "closed";

// 정규장 시각(현지 tz 기준, 24h). 세션 경계는 [open, close) — 마감 시각은 closed.
// export: 세션 경계·tz의 단일 소스(하드코딩 금지) — worker 백필/일봉 동기화, web candleServe가 소비.
export const REGULAR_SESSION: Record<Market, { tz: string; open: string; close: string }> = {
  KR: { tz: "Asia/Seoul", open: "09:00", close: "15:30" },
  US: { tz: "America/New_York", open: "09:30", close: "16:00" },
};

/** "HH:MM"(현지) → 자정 기준 분. export: 세션 길이 파생(web candleServe 분봉 룩백)용. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** 시장 tz로 환산한 현지 날짜("YYYY-MM-DD")·요일("Mon"~"Sun")·자정 기준 분. */
function localParts(tz: string, at: Date): { date: string; weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // 일부 런타임은 자정을 "24"로 표기 — 정규화
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: hour * 60 + Number(p.minute),
  };
}

/**
 * 주어진 시각에 해당 시장이 정규장 중인지 판정. 오버라이드 > 휴장일 > 주말 > 정규장 순.
 */
export function marketSession(market: Market, at: Date): MarketSession {
  const cfg = REGULAR_SESSION[market];
  const { date, weekday, minutes } = localParts(cfg.tz, at);
  const override = OVERRIDES[market].get(date);

  if (override?.closed) return "closed";
  if (!override) {
    if (HOLIDAYS[market].has(date)) return "closed";
    if (weekday === "Sat" || weekday === "Sun") return "closed";
  }

  const open = toMinutes(override?.open ?? cfg.open);
  const close = toMinutes(override?.close ?? cfg.close);
  return minutes >= open && minutes < close ? "open" : "closed";
}

export function isMarketOpen(market: Market, at: Date): boolean {
  return marketSession(market, at) === "open";
}
