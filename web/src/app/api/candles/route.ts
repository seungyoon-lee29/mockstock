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
      // 백필은 tf 네이티브 바(US=5Min 등) 또는 tf 롤업(KR도 aggregateIntraday로 5m·15m…) 일 수 있음
      // — 어느 쪽이든 병합 후 롤업이 흡수한다.
      if (bf && bf.length > 0) {
        merged = mergeCandles(dbCandles, bf as IntradayCandle[]);
        // 콜드 요청마다 KIS를 다시 때리지 않도록 백필분을 minute_candles에 영속화 →
        // 다음 요청(및 워커 재기동 후 모든 요청)은 DB에서 즉답. 부팅 시 전 심볼 백필은 KIS 콜 과다로 배제(ADR),
        // 온디맨드 persist + 재시도 창이 확정 범위. **tf==="1m"일 때만** — KR·US 모두 tf≠1m는
        // tf 네이티브/롤업 바라(alpaca NATIVE_TF·backfillRoute aggregateIntraday) 1분 테이블에 넣으면 오염된다.
        // await(fire-and-forget 아님): Vercel 서버리스는 return 직후 함수를 얼려/종료해 void write가
        // 잘리기 일쑤 → persist가 안 남아 fix 무력화. cold 경로(백필 ~10-15s)에만 ~100-300ms 더해질 뿐,
        // persistMinuteBars는 자체 try/catch로 절대 throw 안 하므로 await해도 엔드포인트를 500내지 않는다.
        if (tf === "1m") await persistMinuteBars(market, symbol, bf as IntradayCandle[]);
      }
    }
  }

  const agg = aggregateIntraday(merged, TF_MINUTES[tf]);
  const capped =
    agg.length > CANDLE_LIMITS.intradayCandleCap
      ? agg.slice(-CANDLE_LIMITS.intradayCandleCap)
      : agg;
  // no-store: 라이브 분봉은 콜드 창(백필 진행 중)의 짧은 응답이 브라우저·CDN에 고착되면 안 됨(방어선).
  return Response.json(capped, { headers: { "cache-control": "no-store" } });
}

/**
 * 백필로 받은 **1분** 바를 minute_candles에 upsert(멱등). worker aggregator.toRow와 동일 shape:
 * ts=Date(time*1000), o/h/l/c=numeric(18,2) 문자열(.toFixed(2)), v=numeric(20,0) 정수 문자열.
 * PK(market,symbol,ts) onConflictDoNothing — aggregator 라이브 정본과 충돌 시 기존 유지.
 * fail-soft: write 실패는 로그 후 삼킨다 — 병합 응답은 이미 반환되므로 candles 엔드포인트를 500내면 안 됨.
 *
 * v 단위 불일치(알려진·본질적, 버그 아님): 여기 저장하는 백필 v는 벤더 실거래량이지만, aggregator가
 * 쓰는 라이브 v는 틱 카운트다. 이 혼용은 persist 이전부터 렌더된 차트에 이미 존재했고(서빙형 백필=실거래량,
 * 라이브 꼬리=틱 카운트) persist가 악화시키지 않는다 — 겹치는 ts는 onConflictDoNothing으로 라이브 로우 유지.
 * 이 모델에서 라이브 꼬리 v를 실거래량으로 만들 방법은 없다. 단위를 억지로 맞추려 하지 말 것(v2 확정).
 */
async function persistMinuteBars(
  market: Market,
  symbol: string,
  bars: IntradayCandle[],
): Promise<void> {
  try {
    const rows = bars.map((c) => ({
      market,
      symbol,
      ts: new Date(c.time * 1000),
      o: c.o.toFixed(2),
      h: c.h.toFixed(2),
      l: c.l.toFixed(2),
      c: c.c.toFixed(2),
      v: String(Math.trunc(c.v)),
    }));
    await getDb().insert(minuteCandles).values(rows).onConflictDoNothing();
  } catch (e) {
    console.error("[candles] 백필 분봉 영속화 실패(응답은 정상)", e);
  }
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
