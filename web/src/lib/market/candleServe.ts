// /api/candles 서빙 순수 헬퍼 (멀티 타임프레임 v2) — 라우트를 얇게 유지하고
// tz 당일 판정·병합·백필 구간 계산을 테스트 가능하게 분리. 서버(route)·클라(useCandles) 공용,
// DB·IO 의존 없음. 정책 값은 전부 shared CANDLE_LIMITS/TF_MINUTES에서 온다.
import {
  CANDLE_LIMITS,
  TF_MINUTES,
  isoWeekStart,
  type ChartTimeframe,
  type DailyCandle,
  type IntradayCandle,
  type Market,
  type Tick,
} from "@mockstock/shared";
// REGULAR_SESSION·toMinutes만 사용(시장 tz·세션 경계 단일 소스 — 하드코딩 금지).
// calendar 서브패스지만 순수 상수·달력 데이터라 클라 번들에 무해(수십 라인).
import { REGULAR_SESSION, toMinutes } from "@mockstock/shared/calendar";

/** 분봉 계열 tf ("1m"…"60m"). */
export type MinuteTf = keyof typeof TF_MINUTES;

// 일봉 계열 tf — daily_candles 경로.
const DAILY_TFS = ["day", "week", "month"] as const;

export function isMinuteTf(tf: string): tf is MinuteTf {
  return tf in TF_MINUTES;
}

/** tf 쿼리 파라미터 런타임 검증 — 계약 밖 값은 400 처리용. */
export function isChartTimeframe(tf: string): tf is ChartTimeframe {
  return isMinuteTf(tf) || (DAILY_TFS as readonly string[]).includes(tf);
}

/**
 * 분봉 tf의 1분 **로우** 조회 한도 = 캔들캡 × 분수.
 * 롤업 전에 캔들캡(240)을 로우에 적용하면 60m가 4개 캔들로 붕괴하는 함정 — shared CANDLE_LIMITS 주석 참조.
 */
export function minuteRowLimit(tf: MinuteTf): number {
  return CANDLE_LIMITS.intradayCandleCap * TF_MINUTES[tf];
}

// Intl 포매터는 생성 비용이 커 시장별 캐시(당일 분봉 수백 건 순회 시 필수).
const dayFmt: Partial<Record<Market, Intl.DateTimeFormat>> = {};

/**
 * 주어진 시각의 **시장 로컬 거래일**("YYYY-MM-DD"). US 세션은 KST로 이틀에 걸치므로
 * 당일 판정에 KST date 사용 금지(daily_candles.date 계약과 동일 규칙).
 */
export function marketDayOf(market: Market, at: Date): string {
  const fmt = (dayFmt[market] ??= new Intl.DateTimeFormat("en-CA", {
    timeZone: REGULAR_SESSION[market].tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }));
  return fmt.format(at); // en-CA 로케일 = "YYYY-MM-DD"
}

// 분봉 X축 라벨 — lightweight-charts는 tz 개념이 없어 UTCTimestamp를 UTC로 포맷한다.
// 시장 tz(REGULAR_SESSION 단일 소스)로 직접 포맷해 KST/ET 장시간이 그대로 보이게 한다.
// Intl 인스턴스는 시장별 캐시(marketDayOf와 동일 관용구 — 눈금마다 생성 금지).
const timeLabelFmt: Partial<Record<Market, Intl.DateTimeFormat>> = {};
const dateLabelFmt: Partial<Record<Market, Intl.DateTimeFormat>> = {};

/** epoch 초 → 시장 로컬 "HH:mm" (분봉 눈금·크로스헤어). */
export function formatMarketTime(market: Market, timeSec: number): string {
  const fmt = (timeLabelFmt[market] ??= new Intl.DateTimeFormat("ko-KR", {
    timeZone: REGULAR_SESSION[market].tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // "24:00" 표기 방지 — 자정은 00:00
  }));
  return fmt.format(new Date(timeSec * 1000));
}

/** epoch 초 → 시장 로컬 "M. D." (분봉 날짜 경계 눈금 — ko-KR 숫자 날짜). */
export function formatMarketDate(market: Market, timeSec: number): string {
  const fmt = (dateLabelFmt[market] ??= new Intl.DateTimeFormat("ko-KR", {
    timeZone: REGULAR_SESSION[market].tz,
    month: "numeric",
    day: "numeric",
  }));
  return fmt.format(new Date(timeSec * 1000));
}

const DAY_SEC = 24 * 60 * 60;

/**
 * 분봉 기본 조회창 시작(epoch 초) — 벽시계 소급이 아니라 **거래 세션 기준**.
 * 요구 의미는 "최근 캡×tf분의 벽시계"가 아니라 "최근 캡개의 캔들 데이터" — 벽시계 창은
 * 주말에 금요일장(33h 전)이 창 밖으로 밀려 0봉이 되는 버그의 근본 원인.
 * 필요 세션 수 = ceil(캡×tf분 / 세션분(REGULAR_SESSION open/close 파생)) + 1(여유).
 * 공휴일은 캘린더 미반영이라 무시 — 창이 다소 넓어질 뿐이고, 조회는 desc+limit,
 * 워커 백필(krMinuteRange)이 빈 날을 데이터 기반으로 건너뛰므로 넓은 창은 무해(알려진 한계).
 */
export function minuteLookbackFromSec(market: Market, tf: MinuteTf, now: Date): number {
  const { open, close } = REGULAR_SESSION[market];
  const sessionMinutes = toMinutes(close) - toMinutes(open);
  let need = Math.ceil((CANDLE_LIMITS.intradayCandleCap * TF_MINUTES[tf]) / sessionMinutes) + 1;
  let t = Math.floor(now.getTime() / 1000);
  while (need > 0) {
    t -= DAY_SEC; // 하루씩 소급 — DST(±1h)로는 시장 로컬 날짜가 하루 단위를 벗어나지 않는다.
    const day = marketDayOf(market, new Date(t * 1000));
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) need--; // 토·일 제외한 시장 로컬 날짜만 세션으로 카운트
  }
  // 하루 더 소급해 마지막 카운트 세션의 개장 **이전**을 보장 — from은 하한일 뿐, 초과분은 limit이 흡수.
  return t - DAY_SEC;
}

/**
 * 지금까지 오늘 세션이 만들어냈어야 할 1분봉 수의 대략값(retry 임계용).
 * 개장 전/휴장/주말 → 0(직전 세션 데이터는 이미 DB에 있어 retry 불필요). 장중 → 개장 후 경과분,
 * 마감 후 → 세션 전체 길이로 클램프. 시장 로컬 시각은 formatMarketTime(HH:mm)으로 뽑아 tz 수식 회피.
 * 근사면 충분 — retry는 "실패 강등(~2봉)"과 "정상(수십·수백봉)"만 구분하면 된다.
 */
export function expectedMinuteBars(market: Market, now: Date): number {
  const { open, close } = REGULAR_SESSION[market];
  const day = marketDayOf(market, now);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return 0; // 주말 — 직전 금요일장은 이미 축적됨
  const [h, m] = formatMarketTime(market, Math.floor(now.getTime() / 1000)).split(":").map(Number);
  const nowMin = h * 60 + m;
  const elapsed = nowMin - toMinutes(open);
  const sessionMinutes = toMinutes(close) - toMinutes(open);
  return Math.max(0, Math.min(elapsed, sessionMinutes));
}

/** today("YYYY-MM-DD") 기준 days일 전 날짜 — 일봉 룩백 컷오프(dayLookbackDays). */
export function lookbackStartDate(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 당일 분봉 → 당일 봉 1개 합성(크론 upsert 전 장중 공백 메움).
 * "오늘"은 시장 tz로 판정, 다른 날짜 분봉은 무시. 당일 분봉이 없으면 null(정직한 공백).
 * v=0 고정 — 분봉 v는 틱 카운트라 벤더 주수와 단위 불일치(v2 확정, 재론 금지).
 */
export function synthesizeTodayBar(
  minutes: IntradayCandle[],
  market: Market,
  now: Date,
): DailyCandle | null {
  const today = marketDayOf(market, now);
  let bar: DailyCandle | null = null;
  for (const m of minutes) {
    if (marketDayOf(market, new Date(m.time * 1000)) !== today) continue;
    if (bar === null) {
      bar = { date: today, o: m.o, h: m.h, l: m.l, c: m.c, v: 0 };
    } else {
      if (m.h > bar.h) bar.h = m.h;
      if (m.l < bar.l) bar.l = m.l;
      bar.c = m.c; // 당일 마지막 분봉 종가
    }
  }
  return bar;
}

/**
 * **확인된 실피드 틱만** 캔들 라이브 반영 허용 — worker.md B4 "mock 틱은 instruments 영속화에서
 * 제외"의 차트 확장. mock은 실데이터 캔들 오염, source 미상(undefined)은 baseline 합성 quote
 * (seedPrice·ts=0/lastPriceAt)라 캔들 집계 대상이 아니다 — 분봉 경로엔 기간 가드가 없어
 * ts=0이 1970 캔들·개장 전 스테일 forming 버킷을 만든다(리뷰 실증). 둘 다 불허.
 */
export function isChartLiveSource(source: Tick["source"] | undefined): boolean {
  return source != null && source !== "mock";
}

/**
 * 일·주·월 라이브 갱신 가드 — 마지막 봉이 today(시장 로컬 "YYYY-MM-DD")가 속한 기간일 때만 갱신.
 * week는 shared isoWeekStart(주봉 집계와 동일한 월요일 시작 규칙), month는 "YYYY-MM" 일치.
 */
export function isCurrentDailyPeriod(
  tf: "day" | "week" | "month",
  lastDate: string,
  today: string,
): boolean {
  if (tf === "day") return lastDate === today;
  if (tf === "week") return isoWeekStart(lastDate) === isoWeekStart(today);
  return lastDate.slice(0, 7) === today.slice(0, 7);
}

/**
 * 두 분봉 시리즈를 time 기준 병합 — 같은 time은 **primary 채택**, 결과는 오름차순.
 * route 전용: primary=DB(자체 축적 정본) vs 워커 백필. (훅의 라이브 병합은 mergeLiveCandles.)
 */
export function mergeCandles(
  primary: IntradayCandle[],
  secondary: IntradayCandle[],
): IntradayCandle[] {
  const byTime = new Map<number, IntradayCandle>();
  for (const c of secondary) byTime.set(c.time, c);
  for (const c of primary) byTime.set(c.time, c); // primary를 나중에 써 충돌 time을 정본으로 덮음
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * 백필(서버 정본)과 라이브 버킷 병합 — useCandles 전용 규칙:
 *  - 백필 마지막 버킷과 같은 time의 라이브 버킷은 **결합**: o·v=백필, h/l=양쪽 확장, c=라이브 최신.
 *    (백필 우선으로 덮으면 fetch 이후 도착한 라이브 틱의 h/l/c가 유실된다 — 결합이 정본.)
 *  - 백필 마지막보다 최신 라이브 버킷은 그대로 이어붙이고, 더 과거 라이브 버킷은 폐기(백필이 정본).
 */
export function mergeLiveCandles(
  backfill: IntradayCandle[],
  live: IntradayCandle[],
): IntradayCandle[] {
  const last = backfill[backfill.length - 1];
  if (!last) return live;
  const out = backfill.slice();
  for (const c of live) {
    if (c.time < last.time) continue;
    if (c.time === last.time) {
      out[out.length - 1] = {
        time: last.time,
        o: last.o,
        h: Math.max(last.h, c.h),
        l: Math.min(last.l, c.l),
        c: c.c,
        v: last.v,
      };
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * DB 최고(最古) 로우보다 앞서는 요청 구간 = 워커 백필이 필요한 [from, oldest-1](epoch 초).
 * DB가 비었으면 요청 구간 전체, 요청 시작이 DB 범위 안이면 null(백필 불필요).
 */
export function missingOlderRange(
  oldest: number | null,
  from: number,
  to: number,
): { from: number; to: number } | null {
  if (from > to) return null;
  if (oldest === null) return { from, to };
  if (from >= oldest) return null;
  return { from, to: Math.min(to, oldest - 1) };
}
