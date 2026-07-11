// /api/candles 서빙 순수 헬퍼 (멀티 타임프레임 v2) — 라우트를 얇게 유지하고
// tz 당일 판정·병합·백필 구간 계산을 테스트 가능하게 분리. 서버(route)·클라(useCandles) 공용,
// DB·IO 의존 없음. 정책 값은 전부 shared CANDLE_LIMITS/TF_MINUTES에서 온다.
import {
  CANDLE_LIMITS,
  TF_MINUTES,
  type ChartTimeframe,
  type DailyCandle,
  type IntradayCandle,
  type Market,
} from "@mockstock/shared";
// REGULAR_SESSION 상수만 사용(시장 tz 단일 소스 — 하드코딩 금지). calendar 서브패스지만
// 순수 상수·달력 데이터라 클라 번들에 무해(수십 라인).
import { REGULAR_SESSION } from "@mockstock/shared/calendar";

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
