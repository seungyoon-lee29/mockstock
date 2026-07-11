// daily_candles 동기화(배치 B) — 크론 upsert(마감 후 슬롯 편승) + 부팅 갭 백필.
// web은 일·주·월 tf를 이 테이블에서만 읽는다(주·월은 shared 롤업).
//  - upsert: PK(market,symbol,date) onConflictDoUpdate — 재실행·수정주가 갱신에 멱등.
//  - 부팅 체크: 심볼별 max(date) → 부족분만 백필(기본 DAILY_BACKFILL_DAYS=730).
//    페이싱은 kisRest 레이트 리미터가 담당(KIS ≈190콜, Alpaca 48콜 — 1분 내).
//  - 키 부재 + 해당 시장 테이블 빈 상태 → **시장별** Discord 1회 경고(조용한 영구 공백 방지).
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { UNIVERSE, type DailyCandle, type Market } from "@mockstock/shared";
import { REGULAR_SESSION } from "@mockstock/shared/calendar";
import { dailyCandles } from "@mockstock/shared/schema";
import { envInt, isKisRestEnabled } from "./kisRest";
import { fetchUsDaily, isAlpacaEnabled } from "./alpaca";
import { krDailyRange } from "./backfillRoute";

type Db = PgDatabase<any, any, any>;

const DAY_MS = 86_400_000;
const SYNC_LOOKBACK_DAYS = 7; // 크론 동기화 창 — 휴장·재시작 며칠 공백도 다음 실행이 자기수정
const KIS_DAILY_PAGE = 100; // 콜당 최대 로우 → 백필 콜 수 산출

/** 시장 로컬 날짜 "YYYY-MM-DD" (en-CA 포맷이 ISO 순서). tz는 shared REGULAR_SESSION 단일 소스. */
function localDate(market: Market, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REGULAR_SESSION[market].tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * 마지막 **확정** 거래일 — 당일 세션이 아직 마감 전(장전·장중)이면 진행 중 일봉을 확정으로
 * upsert하지 않도록 전일로 당긴다. 마감 후·휴장일은 오늘 그대로(휴장일 로우는 벤더가 안 준다).
 */
function lastClosedDate(market: Market, at: Date = new Date()): string {
  const { tz, close } = REGULAR_SESSION[market];
  let hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  if (hm.startsWith("24")) hm = `00${hm.slice(2)}`; // 일부 런타임은 자정을 "24"로 표기 — 정규화
  const today = localDate(market, at);
  return hm >= close ? today : minusDays(today, 1); // "HH:MM" 사전순 = 시각순
}

function minusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}
function plusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function providerEnabled(market: Market): boolean {
  return market === "KR" ? isKisRestEnabled() : isAlpacaEnabled();
}

/** 시장별 일봉 범위 조회 — KR은 100건 페이지 워크, US는 Alpaca 1콜(10k 한도). */
async function fetchDailyRange(market: Market, symbol: string, from: string, to: string): Promise<DailyCandle[]> {
  if (market === "KR") {
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS));
    const budget = Math.ceil(days / KIS_DAILY_PAGE) + 2; // 범위 커버 + 여유 2콜
    return krDailyRange(symbol, from, to, budget);
  }
  return fetchUsDaily(symbol, from, to);
}

/** 심볼 1개 upsert — numeric은 문자열(float 금지, db.md), v는 정수 반올림. */
export async function upsertDailyCandles(db: Db, market: Market, symbol: string, candles: DailyCandle[]): Promise<number> {
  if (candles.length === 0) return 0;
  const rows = candles.map((c) => ({
    market,
    symbol,
    date: c.date,
    o: c.o.toFixed(2),
    h: c.h.toFixed(2),
    l: c.l.toFixed(2),
    c: c.c.toFixed(2),
    v: String(Math.round(c.v)), // numeric(20,0)
  }));
  await db
    .insert(dailyCandles)
    .values(rows)
    .onConflictDoUpdate({
      target: [dailyCandles.market, dailyCandles.symbol, dailyCandles.date],
      set: {
        o: sql`excluded.o`,
        h: sql`excluded.h`,
        l: sql`excluded.l`,
        c: sql`excluded.c`,
        v: sql`excluded.v`,
      },
    });
  return rows.length;
}

/**
 * 크론 일봉 동기화 — 시장별, 최근 SYNC_LOOKBACK_DAYS 창 upsert(멱등).
 * 키 없으면 no-op(빈 결과 반환 — 크론 통지에 skipped로 표기).
 */
export async function syncDailyCandles(db: Db, market: Market): Promise<{ symbols: number; rows: number; errors: number }> {
  const out = { symbols: 0, rows: 0, errors: 0 };
  if (!providerEnabled(market)) return out; // 키 부재 — fail-soft
  const to = localDate(market);
  const from = minusDays(to, SYNC_LOOKBACK_DAYS);
  for (const e of UNIVERSE) {
    if (e.market !== market) continue;
    out.symbols++;
    try {
      out.rows += await upsertDailyCandles(db, market, e.symbol, await fetchDailyRange(market, e.symbol, from, to));
    } catch (err) {
      out.errors++; // 한 심볼 실패가 전체를 막지 않게 — 다음 실행이 자기수정
      console.error(`[dailySync] ${market}:${e.symbol} 동기화 실패`, err);
    }
  }
  return out;
}

/**
 * 부팅 갭 백필 — 심볼별 max(date) 조회 후 부족분만(기본 730일). 크론 부팅 스윕에서 1회 호출.
 * 키 부재 + 해당 시장 테이블 빈 상태면 **시장별** Discord 1회 경고(notify — cron의 웹훅 함수 주입).
 * to = 마지막 확정 거래일 — 세션 마감 전 부팅 시 진행 중 일봉을 확정으로 upsert하지 않는다.
 */
export async function bootBackfillDailyCandles(
  db: Db,
  notify: (text: string) => Promise<void>,
): Promise<{ symbols: number; rows: number; errors: number }> {
  const days = envInt("DAILY_BACKFILL_DAYS", 730);
  const maxRows = (await db
    .select({ market: dailyCandles.market, symbol: dailyCandles.symbol, max: sql<string>`max(${dailyCandles.date})` })
    .from(dailyCandles)
    .groupBy(dailyCandles.market, dailyCandles.symbol)) as { market: Market; symbol: string; max: string }[];

  // 시장별 경고 — 한쪽(예: Alpaca) 키만 없어도 그 시장의 영구 공백은 조용히 지나가지 않는다.
  for (const market of ["KR", "US"] as const) {
    if (!providerEnabled(market) && !maxRows.some((r) => r.market === market)) {
      const provider = market === "KR" ? "KIS" : "Alpaca";
      await notify(`⚠️ ${market} daily_candles 비어 있음 + ${provider} 키 없음 — ${market} 일·주·월 차트가 영구 공백입니다(키 설정 필요)`);
    }
  }

  const maxByKey = new Map(maxRows.map((r) => [`${r.market}:${r.symbol}`, r.max]));
  const out = { symbols: 0, rows: 0, errors: 0 };
  for (const e of UNIVERSE) {
    if (!providerEnabled(e.market)) continue;
    const to = lastClosedDate(e.market);
    const max = maxByKey.get(`${e.market}:${e.symbol}`);
    const from = max ? plusDays(max, 1) : minusDays(to, days);
    if (from > to) continue; // 이미 최신 — DB 미접촉
    out.symbols++;
    try {
      out.rows += await upsertDailyCandles(db, e.market, e.symbol, await fetchDailyRange(e.market, e.symbol, from, to));
    } catch (err) {
      out.errors++;
      console.error(`[dailySync] ${e.market}:${e.symbol} 부팅 백필 실패`, err);
    }
  }
  return out;
}
