// GET /api/candles — minute_candles 조회로 실시간 분봉 차트 백필 제공.
// query: market(US|KR)·symbol·from·to(epoch 초 또는 ISO, 둘 다 선택). 응답: IntradayCandle[](time=초, 오름차순).
// day1엔 축적 데이터가 없어 빈 배열이 정상. 클라 입력은 신뢰 경계 — market/symbol 검증 후 조회한다.
import type { NextRequest } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getEntry, type IntradayCandle, type Market } from "@mockstock/shared";
import { minuteCandles } from "@mockstock/shared/schema";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic"; // query 파싱 = 요청시점 데이터 → 항상 동적.
export const runtime = "nodejs";

const MARKETS: readonly Market[] = ["US", "KR"];
const MAX_CANDLES = 240; // useCandles와 동일 상한 — 최근 N개 분봉만 반환.
const DEFAULT_LOOKBACK_SEC = 24 * 60 * 60; // from 미지정 시 to 기준 24시간 소급.

/** epoch 초(숫자문자열) 또는 ISO 문자열 → Date. 파싱 실패는 undefined. */
function parseTime(v: string | null): Date | undefined {
  if (!v) return undefined;
  // 거대 숫자(예: 초 1e26)는 Infinity·Invalid Date가 되므로 숫자 분기도 NaN 검증한다.
  const d = /^\d+$/.test(v) ? new Date(Number(v) * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest): Promise<Response> {
  // DB 미설정(키 없는 로컬 데모)은 getDb() 500 대신 day1 빈 배열 계약으로 강등한다(리더보드 idiom).
  if (!process.env.DATABASE_URL) return Response.json([]);

  const q = req.nextUrl.searchParams;
  const market = q.get("market");
  const symbol = q.get("symbol");
  if (!market || !MARKETS.includes(market as Market)) {
    return Response.json({ message: "잘못된 시장입니다." }, { status: 400 });
  }
  if (!symbol || !getEntry(market as Market, symbol)) {
    return Response.json({ message: "유니버스에 없는 심볼입니다." }, { status: 400 });
  }

  const to = parseTime(q.get("to")) ?? new Date();
  const from = parseTime(q.get("from")) ?? new Date(to.getTime() - DEFAULT_LOOKBACK_SEC * 1000);
  // parseTime이 Invalid Date를 undefined로 걸러 fallback되지만, 신뢰 경계 최후 방어선으로 명시 검증한다.
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return Response.json({ message: "기간이 올바르지 않습니다." }, { status: 400 });
  }
  if (from > to) {
    return Response.json({ message: "기간이 올바르지 않습니다." }, { status: 400 });
  }

  // 최신 MAX_CANDLES개만(desc+limit) 가져와 오름차순으로 뒤집는다 — 큰 테이블 과다 조회 방지.
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
        eq(minuteCandles.market, market as Market),
        eq(minuteCandles.symbol, symbol),
        gte(minuteCandles.ts, from),
        lte(minuteCandles.ts, to),
      ),
    )
    .orderBy(desc(minuteCandles.ts))
    .limit(MAX_CANDLES);

  // numeric 컬럼은 문자열로 오므로 Number 변환. time=분 버킷 시작(초).
  const candles: IntradayCandle[] = rows.reverse().map((r) => ({
    time: Math.floor(r.ts.getTime() / 1000),
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
    v: Number(r.v),
  }));

  return Response.json(candles);
}
