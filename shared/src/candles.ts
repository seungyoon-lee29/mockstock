// 캔들 집계 단일 소스 — 워커 영속화 + 클라 표시 공용(순수 함수, DB·IO 없음).
// 일봉→주봉(리플레이 주봉 토글), 스트리밍 틱→1분봉(실시간 분봉 토글·워커 축적)을 한곳에서.
import type { Tick } from "./types";

// 분 버킷 정렬·롤오버 경계의 단일 상수(매직넘버 산재 금지).
const SECONDS_PER_MINUTE = 60;

/** 일/주봉. date=ISO "YYYY-MM-DD"(주봉은 주 첫 거래일). 웹 replay.ts `Candle`의 정본. */
export type DailyCandle = { date: string; o: number; h: number; l: number; c: number; v: number };

/** 분봉. time=epoch **초**(분 버킷 시작). lightweight-charts UTCTimestamp와 호환. */
export type IntradayCandle = { time: number; o: number; h: number; l: number; c: number; v: number };

/** 차트 타임프레임 토글 값 — /api/candles `tf` 파라미터와 1:1. */
export type ChartTimeframe = "1m" | "5m" | "10m" | "15m" | "30m" | "60m" | "day" | "week" | "month";

/** 분봉 tf → 버킷 분수. 일·주·월은 daily_candles 경로라 여기 없음. */
export const TF_MINUTES: Record<"1m" | "5m" | "10m" | "15m" | "30m" | "60m", number> = {
  "1m": 1,
  "5m": 5,
  "10m": 10,
  "15m": 15,
  "30m": 30,
  "60m": 60,
};

/**
 * per-tf 캡·룩백 (/api/candles 계약의 단일 소스).
 * 주의: 분봉 tf의 1분 **로우** 조회 한도는 반드시 캔들캡×분수(intradayCandleCap × minutes) —
 * 롤업 전에 캔들캡을 로우에 적용하면 60m가 4개 캔들로 붕괴하는 함정(리뷰 확정, 재론 금지).
 */
export const CANDLE_LIMITS = {
  /**
   * 분봉 tf 응답 캔들 캡(롤업 **후** 캔들 수 기준). 반드시 최장 정규장(KR·US 모두 390분:
   * 09:00~15:30 / 09:30~16:00)보다 커야 1분봉이 개장~마감 전 세션을 다 보여준다 — 240이면
   * 최근 240분만 남아 세션 앞 150분이 잘렸다(버그). 여유 10봉 포함 400. 코스 tf는 더 깊은 이력이 될 뿐 무해.
   */
  intradayCandleCap: 400,
  /** 일봉 룩백 기본(일 수). week/month는 day에서 파생 — 별도 캡 불요(이미 ≤ dayRowCap). */
  dayLookbackDays: 730,
  /** 일봉 로우 캡. */
  dayRowCap: 750,
} as const;

/** 날짜("YYYY-MM-DD")가 속한 ISO주(월요일) 시작일을 UTC로 계산 → 같은 주 판별 키.
 * 주봉 집계·라이브 갱신 가드(web candleServe)가 공유하는 주 귀속 규칙의 단일 소스. */
export function isoWeekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0 … 일=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * 일봉 배열을 ISO주(월~일) 주봉으로 집계. 입력은 날짜 오름차순 가정, 빈 배열 안전.
 * o=주 첫 거래일 시가, h=max, l=min, c=주 마지막 거래일 종가, v=Σ거래량, date=주 첫 거래일 날짜.
 */
export function aggregateDailyToWeekly(daily: DailyCandle[]): DailyCandle[] {
  const weeks: DailyCandle[] = [];
  let key = "";
  for (const d of daily) {
    const wk = isoWeekStart(d.date);
    if (wk !== key) {
      // 새 주 — 주 첫 거래일 기준으로 open. 이후 같은 주 캔들이 h/l/c/v를 갱신.
      weeks.push({ date: d.date, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
      key = wk;
    } else {
      const w = weeks[weeks.length - 1];
      if (d.h > w.h) w.h = d.h;
      if (d.l < w.l) w.l = d.l;
      w.c = d.c; // 주 마지막 거래일 종가로 계속 갱신
      w.v += d.v;
    }
  }
  return weeks;
}

/**
 * 1분봉 → N분봉 롤업. 버킷 = epoch floor(time - time % (minutes×60)) — **정시(top-of-hour) 관례**:
 * US 09:30 개장의 60분 첫 봉은 09:00 앵커 스텁(09:30~09:59 실데이터)이 된다(v2 확정 결정).
 * 입력 오름차순 가정, 출력 오름차순. o=버킷 첫 시가, h=max, l=min, c=마지막 종가, v=Σ.
 */
export function aggregateIntraday(candles: IntradayCandle[], minutes: number): IntradayCandle[] {
  if (minutes <= 1) return candles; // 1분은 이미 그 해상도 — 그대로 반환
  const size = minutes * SECONDS_PER_MINUTE;
  const out: IntradayCandle[] = [];
  for (const c of candles) {
    const bucket = c.time - (c.time % size);
    const last = out[out.length - 1];
    if (last === undefined || last.time !== bucket) {
      // 새 버킷 — 첫 분봉 기준으로 open. 이후 같은 버킷 분봉이 h/l/c/v를 갱신.
      out.push({ time: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    } else {
      if (c.h > last.h) last.h = c.h;
      if (c.l < last.l) last.l = c.l;
      last.c = c.c; // 버킷 마지막 분봉 종가로 계속 갱신
      last.v += c.v;
    }
  }
  return out;
}

/**
 * 일봉 배열을 월봉(YYYY-MM 그룹)으로 집계. 주봉(aggregateDailyToWeekly)과 동일 관례 —
 * date=월 첫 거래일. 입력은 날짜 오름차순 가정, 빈 배열 안전.
 */
export function aggregateDailyToMonthly(daily: DailyCandle[]): DailyCandle[] {
  const months: DailyCandle[] = [];
  let key = "";
  for (const d of daily) {
    const mo = d.date.slice(0, 7); // "YYYY-MM"
    if (mo !== key) {
      // 새 달 — 월 첫 거래일 기준으로 open. 이후 같은 달 캔들이 h/l/c/v를 갱신.
      months.push({ date: d.date, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
      key = mo;
    } else {
      const m = months[months.length - 1];
      if (d.h > m.h) m.h = d.h;
      if (d.l < m.l) m.l = d.l;
      m.c = d.c; // 월 마지막 거래일 종가로 계속 갱신
      m.v += d.v;
    }
  }
  return months;
}

/**
 * 스트리밍 틱 → 1분 캔들. 워커 축적·클라 라이브 버킷팅 공용.
 * v = 집계 틱 수(체결 건수) — 피드가 체결 거래량을 주지 않아 건수로 대용.
 */
export class MinuteAggregator {
  private cur: IntradayCandle | null = null;

  /**
   * 새 틱을 현재 분 버킷에 반영.
   * - 분 경계를 넘어가면 직전 완성 캔들을 반환하고 새 버킷 시작.
   * - 같은 버킷이거나 첫 틱이면 null.
   * - 역행 ts(현재 버킷보다 과거)는 무시하고 null.
   */
  add(tick: Tick): IntradayCandle | null {
    const bucket = Math.floor(tick.ts / 1000 / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
    if (this.cur === null) {
      this.cur = openBucket(bucket, tick.price);
      return null;
    }
    if (bucket < this.cur.time) return null; // 역행 틱 무시
    if (bucket > this.cur.time) {
      const done = this.cur;
      this.cur = openBucket(bucket, tick.price);
      return done;
    }
    // 같은 버킷 누적
    const b = this.cur;
    if (tick.price > b.h) b.h = tick.price;
    if (tick.price < b.l) b.l = tick.price;
    b.c = tick.price;
    b.v += 1;
    return null;
  }

  /** 미완성 현재 버킷을 캔들로 방출(장 마감/종료 시). 없으면 null. */
  flush(): IntradayCandle | null {
    const done = this.cur;
    this.cur = null;
    return done;
  }
}

function openBucket(time: number, price: number): IntradayCandle {
  return { time, o: price, h: price, l: price, c: price, v: 1 };
}
