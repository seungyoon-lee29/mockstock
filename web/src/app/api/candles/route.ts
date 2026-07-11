// GET /api/candles — tf별 캔들 조회 (멀티 타임프레임 v2).
// query: market(US|KR)·symbol·tf(1m|5m|10m|15m|30m|60m|day|week|month, 기본 1m 하위호환)·from·to(분봉만).
// 분봉 tf: minute_candles 롤업(로우 한도 = 캔들캡×분수) + 부족 과거 구간만 워커 백필(실패 시 DB-only 강등)
//          → IntradayCandle[](time=초, 오름차순).
// 일·주·월: daily_candles 룩백 + 당일 봉 합성(시장 tz, v=0) → DailyCandle[](date=거래소 로컬, 오름차순).
// 클라 입력은 신뢰 경계 — market/symbol/tf 검증 후 조회. DB 미설정은 빈 배열(키 없는 로컬 데모 계약).
import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import {
  aggregateDailyToMonthly,
  aggregateDailyToWeekly,
  aggregateIntraday,
  CANDLE_LIMITS,
  getEntry,
  TF_MINUTES,
  type DailyCandle,
  type IntradayCandle,
  type Market,
} from "@mockstock/shared";
import { dailyCandles, minuteCandles } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";
import { fetchBackfillCandles } from "@/lib/market/workerClient";
import {
  isChartTimeframe,
  isMinuteTf,
  lookbackStartDate,
  marketDayOf,
  mergeCandles,
  minuteLookbackFromSec,
  minuteRowLimit,
  missingOlderRange,
  synthesizeTodayBar,
  type MinuteTf,
} from "@/lib/market/candleServe";

export const dynamic = "force-dynamic"; // query 파싱 = 요청시점 데이터 → 항상 동적.
export const runtime = "nodejs";

const MARKETS: readonly Market[] = ["US", "KR"];
const DEFAULT_LOOKBACK_SEC = 24 * 60 * 60; // 당일 봉 합성용 분봉 소급(시장 tz "오늘"은 최대 24h 전 시작).

/** epoch 초(숫자문자열) 또는 ISO 문자열 → Date. 파싱 실패는 undefined. */
function parseTime(v: string | null): Date | undefined {
  if (!v) return undefined;
  // 거대 숫자(예: 초 1e26)는 Infinity·Invalid Date가 되므로 숫자 분기도 NaN 검증한다.
  const d = /^\d+$/.test(v) ? new Date(Number(v) * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest): Promise<Response> {
  const q = req.nextUrl.searchParams;
  const market = q.get("market");
  const symbol = q.get("symbol");
  if (!market || !MARKETS.includes(market as Market)) {
    return Response.json({ message: "잘못된 시장입니다." }, { status: 400 });
  }
  if (!symbol || !getEntry(market as Market, symbol)) {
    return Response.json({ message: "유니버스에 없는 심볼입니다." }, { status: 400 });
  }
  const tf = q.get("tf") ?? "1m"; // 기본 1m — tf 없는 기존 호출 하위호환.
  if (!isChartTimeframe(tf)) {
    return Response.json({ message: "지원하지 않는 타임프레임입니다." }, { status: 400 });
  }

  // DB 미설정(키 없는 로컬 데모)은 getDb() 500 대신 빈 배열 계약으로 강등한다(리더보드 idiom).
  // 검증 **뒤**에 둔다 — 불량 입력은 키 없는 로컬에서도 400이어야 한다(신뢰 경계).
  if (!process.env.DATABASE_URL) return Response.json([]);

  if (isMinuteTf(tf)) return serveMinutes(market as Market, symbol, tf, q);
  return serveDaily(market as Market, symbol, tf);
}

/** 분봉 계열: 1분 로우 → tf 롤업(+부족 과거 구간 워커 백필). 응답 IntradayCandle[]. */
async function serveMinutes(
  market: Market,
  symbol: string,
  tf: MinuteTf,
  q: URLSearchParams,
): Promise<Response> {
  const to = parseTime(q.get("to")) ?? new Date();
  // 기본 룩백: **거래 세션 기준**(minuteLookbackFromSec) — 벽시계 소급은 주말에 금요일장이
  // 창 밖으로 밀려 0봉이 되는 버그. 항상 2세션+ 소급이라 기존 1m 24h 계약보다 깊다(대체).
  const from =
    parseTime(q.get("from")) ?? new Date(minuteLookbackFromSec(market, tf, to) * 1000);
  // parseTime이 Invalid Date를 undefined로 걸러 fallback되지만, 신뢰 경계 최후 방어선으로 명시 검증한다.
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return Response.json({ message: "기간이 올바르지 않습니다." }, { status: 400 });
  }

  // 최신 로우 한도(캡×분수)만 desc+limit로 가져와 오름차순으로 뒤집는다 — 큰 테이블 과다 조회 방지.
  const limit = minuteRowLimit(tf);
  const rows = await getDb()
    .select({
      ts: minuteCandles.ts,
      o: minuteCandles.o,
      h: minuteCandles.h,
      l: minuteCandles.l,
      c: minuteCandles.c,
      v: minuteCandles.v,
    })
    .from(minuteCandles)
    .where(
      and(
        eq(minuteCandles.market, market),
        eq(minuteCandles.symbol, symbol),
        gte(minuteCandles.ts, from),
        lte(minuteCandles.ts, to),
      ),
    )
    .orderBy(desc(minuteCandles.ts))
    .limit(limit);

  // numeric 컬럼은 문자열로 오므로 Number 변환. time=분 버킷 시작(초).
  const dbCandles: IntradayCandle[] = rows.reverse().map((r) => ({
    time: Math.floor(r.ts.getTime() / 1000),
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
    v: Number(r.v),
  }));

  // 요청 시작이 DB 최고(最古) 로우보다 앞서면 그 **부족 과거 구간만** 워커 백필.
  // 로우 한도를 다 채웠으면 캡 도달 — 더 과거는 어차피 잘리므로 생략. 실패는 조용히 DB-only 강등.
  let merged = dbCandles;
  if (rows.length < limit) {
    const range = missingOlderRange(
      dbCandles[0]?.time ?? null,
      Math.floor(from.getTime() / 1000),
      Math.floor(to.getTime() / 1000),
    );
    if (range) {
      const bf = await fetchBackfillCandles(market, symbol, tf, range.from, range.to);
      // 백필은 tf 네이티브 바(US) 또는 1분(KR)일 수 있음 — 어느 쪽이든 병합 후 롤업이 흡수한다.
      if (bf && bf.length > 0) merged = mergeCandles(dbCandles, bf as IntradayCandle[]);
    }
  }

  const agg = aggregateIntraday(merged, TF_MINUTES[tf]);
  const capped =
    agg.length > CANDLE_LIMITS.intradayCandleCap
      ? agg.slice(-CANDLE_LIMITS.intradayCandleCap)
      : agg;
  return Response.json(capped);
}

/** Postgres undefined_table(42P01) 판별 — 드라이버에 따라 code가 에러 본체 또는 cause에 실린다. */
function isUndefinedTable(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "42P01" || err?.cause?.code === "42P01";
}

/** 일·주·월: daily_candles 룩백 + 당일 봉 합성(시장 tz) → 필요 시 주·월 롤업. */
async function serveDaily(
  market: Market,
  symbol: string,
  tf: "day" | "week" | "month",
): Promise<Response> {
  const now = new Date();
  const today = marketDayOf(market, now); // "오늘"은 시장 tz — US 세션은 KST 이틀에 걸침.
  const cutoff = lookbackStartDate(today, CANDLE_LIMITS.dayLookbackDays);

  // 최신 dayRowCap개만 desc+limit → 오름차순 뒤집기(분봉 경로와 동일 관용구).
  // 마이그레이션 전 테이블 부재(42P01)는 "데이터 없음"과 동치 — DB 미설정 빈 배열 강등과 같은 계약.
  // (web이 마이그레이션보다 먼저 배포되는 순서 하자로 500을 내지 않는다. 그 외 에러는 그대로 던진다.)
  let rows: { date: string; o: string; h: string; l: string; c: string; v: string }[] = [];
  try {
    rows = await getDb()
      .select({
        date: dailyCandles.date,
        o: dailyCandles.o,
        h: dailyCandles.h,
        l: dailyCandles.l,
        c: dailyCandles.c,
        v: dailyCandles.v,
      })
      .from(dailyCandles)
      .where(
        and(
          eq(dailyCandles.market, market),
          eq(dailyCandles.symbol, symbol),
          gte(dailyCandles.date, cutoff),
        ),
      )
      .orderBy(desc(dailyCandles.date))
      .limit(CANDLE_LIMITS.dayRowCap);
  } catch (e) {
    if (!isUndefinedTable(e)) throw e;
  }

  const daily: DailyCandle[] = rows.reverse().map((r) => ({
    date: r.date,
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
    v: Number(r.v),
  }));

  // 당일 봉 합성 — 크론 upsert 전 장중 공백 메움. 오늘 로우가 이미 있으면 DB(정본) 우선.
  // 시장 tz의 "오늘"은 실시간 기준 최대 24h 전에 시작 → 24h 소급 조회로 충분.
  if (daily[daily.length - 1]?.date !== today) {
    const minuteRows = await getDb()
      .select({
        ts: minuteCandles.ts,
        o: minuteCandles.o,
        h: minuteCandles.h,
        l: minuteCandles.l,
        c: minuteCandles.c,
      })
      .from(minuteCandles)
      .where(
        and(
          eq(minuteCandles.market, market),
          eq(minuteCandles.symbol, symbol),
          gte(minuteCandles.ts, new Date(now.getTime() - DEFAULT_LOOKBACK_SEC * 1000)),
        ),
      )
      .orderBy(asc(minuteCandles.ts));
    const minutes: IntradayCandle[] = minuteRows.map((r) => ({
      time: Math.floor(r.ts.getTime() / 1000),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: 0, // 합성 봉 v=0 고정 계약 — 분봉 v(틱 카운트)는 집계에 쓰지 않는다.
    }));
    const todayBar = synthesizeTodayBar(minutes, market, now);
    if (todayBar) daily.push(todayBar); // 당일 분봉 없으면 생략(정직한 공백).
  }

  const out =
    tf === "week"
      ? aggregateDailyToWeekly(daily)
      : tf === "month"
        ? aggregateDailyToMonthly(daily)
        : daily;
  // 하루 1회 갱신 데이터 — CDN 5분 캐시(당일 봉 합성만 최대 5분 지연, 허용).
  return Response.json(out, { headers: { "cache-control": "s-maxage=300" } });
}
