// 캔들 집계 단일 소스 — 워커 영속화 + 클라 표시 공용(순수 함수, DB·IO 없음).
// 일봉→주봉(리플레이 주봉 토글), 스트리밍 틱→1분봉(실시간 분봉 토글·워커 축적)을 한곳에서.
import type { Tick } from "./types";

// 분 버킷 정렬·롤오버 경계의 단일 상수(매직넘버 산재 금지).
const SECONDS_PER_MINUTE = 60;

/** 일/주봉. date=ISO "YYYY-MM-DD"(주봉은 주 첫 거래일). 웹 replay.ts `Candle`의 정본. */
export type DailyCandle = { date: string; o: number; h: number; l: number; c: number; v: number };

/** 분봉. time=epoch **초**(분 버킷 시작). lightweight-charts UTCTimestamp와 호환. */
export type IntradayCandle = { time: number; o: number; h: number; l: number; c: number; v: number };

/** 날짜("YYYY-MM-DD")가 속한 ISO주(월요일) 시작일을 UTC로 계산 → 같은 주 판별 키. */
function isoWeekStart(date: string): string {
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
