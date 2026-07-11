// GET /candles/backfill?market&symbol&tf&from&to — 과거 캔들 serve-through 백필(배치 B).
// DB **무접촉**(스펙 확정): 외부 API(KIS·Alpaca) + 인메모리 TTL 캐시만. web이 DB로 못 채운
// 과거 구간만 server-to-server로 호출한다(x-worker-secret — /snapshot과 동일 관용구).
//  - from/to: epoch 초 또는 "YYYY-MM-DD"(둘 다 허용 — 분봉은 초, 일봉은 날짜가 자연스럽다).
//  - 응답: 분봉 tf → IntradayCandle[], day → DailyCandle[]. 키 부재 시 빈 배열 200(fail-soft).
//  - TTL 캐시: 분봉 tf초×60, 일봉 1h. 키는 (market,symbol,tf,격자 셀 끝)만 — 이동하는 to=now도
//    캐시 적중. 값에 coveredFromSec(커버 시작)를 실어, 더 깊은 from 요청은 미커버 과거 구간만
//    추가 조회해 누적한다(부분·예산 절단 응답이 가짜 []로 굳지 않게).
//  - KIS 콜 예산: KIS_BACKFILL_CALL_BUDGET(기본 10) — 소진 시 부분 응답(오래된 쪽 절단).
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  TF_MINUTES,
  getEntry,
  aggregateIntraday,
  type ChartTimeframe,
  type DailyCandle,
  type IntradayCandle,
  type Market,
} from "@mockstock/shared";
import { REGULAR_SESSION } from "@mockstock/shared/calendar";
import { config } from "../config";
import { envInt, fetchKrDaily, fetchKrMinutes } from "./kisRest";
import { fetchUsDaily, fetchUsMinutes } from "./alpaca";

const DAY_TTL_MS = 3_600_000; // 일봉 캐시 1h(하루 1회 갱신 데이터)
const CACHE_MAX = 500; // ponytail: 전역 캐시 상한 — 38+48심볼×9tf 커버, 부족하면 env로 승격
const DAY_SEC = 86_400;
// KR 정규장 경계 — shared marketCalendar REGULAR_SESSION 단일 소스(하드코딩 금지).
const KR_SESSION_OPEN_HMS = REGULAR_SESSION.KR.open.replace(":", "") + "00"; // "090000"(이전이면 전 영업일로 점프)
const [krCloseH, krCloseM] = REGULAR_SESSION.KR.close.split(":").map(Number);
const KR_CLOSE_SEC_OF_DAY = (krCloseH * 60 + krCloseM) * 60; // 정규장 마감(전일 커서 시각)

/** LRU-ish TTL 캐시 — Map 삽입 순서 활용(get 시 재삽입), 상한 초과 시 가장 오래된 키 축출. */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // 재삽입 → 최근 사용으로 갱신(LRU-ish)
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.map.size >= this.max && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

/** 캐시 값 — 캔들 + 커버 시작(epoch 초). 예산 절단 등 부분 응답의 실제 커버를 기록한다. */
export type CacheEntry = { candles: IntradayCandle[] | DailyCandle[]; coveredFromSec: number };

const cache = new TtlCache<CacheEntry>(CACHE_MAX);

/** epoch 초 → KST YYYYMMDD/HHMMSS (KST=UTC+9 고정). */
function kstParts(sec: number): { ymd: string; hms: string } {
  const iso = new Date((sec + 9 * 3_600) * 1_000).toISOString(); // "YYYY-MM-DDTHH:MM:SS…"
  return { ymd: iso.slice(0, 10).replaceAll("-", ""), hms: iso.slice(11, 19).replaceAll(":", "") };
}

/** KST 기준 전일 15:30(정규장 마감)의 epoch 초 — 분봉 역방향 워크의 날짜 점프. */
function prevDayCloseSec(sec: number): number {
  const { ymd } = kstParts(sec);
  const midnightUtc = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1_000;
  // KST 자정 = UTC 자정 - 9h. 전일 마감 KST = KST 자정 - 24h + 마감 초(REGULAR_SESSION.KR.close).
  return midnightUtc - 9 * 3_600 - DAY_SEC + KR_CLOSE_SEC_OF_DAY;
}

/**
 * KR 분봉 역방향 워크 — to에서 시작해 FHKST03010230(120건/콜)을 과거로 이어붙인다.
 * budget 소진 시 부분 응답(오래된 쪽 절단 — 스펙 확정). 반환은 [from,to] 범위 오름차순.
 * 테스트를 위해 export(콜 예산 컷오프 검증).
 */
export async function krMinuteRange(
  symbol: string,
  fromSec: number,
  toSec: number,
  budget: number,
): Promise<IntradayCandle[]> {
  const byTime = new Map<number, IntradayCandle>();
  let cursor = toSec;
  for (let calls = 0; calls < budget && cursor >= fromSec; calls++) {
    const { ymd, hms } = kstParts(cursor);
    const bars = await fetchKrMinutes(symbol, ymd, hms);
    if (bars.length === 0) {
      cursor = prevDayCloseSec(cursor); // 휴장·데이터 없는 날 — 전 캘린더일 마감으로 점프
      continue;
    }
    for (const b of bars) byTime.set(b.time, b);
    const earliest = bars[0]; // fetchKrMinutes는 오름차순
    if (earliest.time <= fromSec) break;
    // 그날 09:00까지 왔으면 빈 콜 낭비 없이 바로 전일 마감으로 점프.
    cursor = kstParts(earliest.time).hms <= KR_SESSION_OPEN_HMS ? prevDayCloseSec(earliest.time) : earliest.time - 60;
  }
  return [...byTime.values()].filter((b) => b.time >= fromSec && b.time <= toSec).sort((a, b) => a.time - b.time);
}

/** "YYYY-MM-DD" 하루 감산(UTC 산술 — 날짜 문자열 전용이라 tz 무관). */
function minusOneDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_SEC * 1_000).toISOString().slice(0, 10);
}

/**
 * KR 일봉 역방향 워크 — FHKST03010100은 범위 내 최신 100건만 주므로 to를 당겨가며 반복.
 * budget 소진 시 부분 응답. 반환은 날짜 오름차순.
 */
export async function krDailyRange(
  symbol: string,
  fromDate: string,
  toDate: string,
  budget: number,
): Promise<DailyCandle[]> {
  const byDate = new Map<string, DailyCandle>();
  let to = toDate;
  let prevEarliest = ""; // 직전 콜의 최고(最古) 날짜 — 진전 없음 감지
  for (let calls = 0; calls < budget; calls++) {
    const rows = await fetchKrDaily(symbol, fromDate.replaceAll("-", ""), to.replaceAll("-", ""));
    if (rows.length === 0) break;
    for (const r of rows) byDate.set(r.date, r);
    const earliest = rows[0]; // 오름차순
    // KIS는 빈 로우 패딩으로 100건 미만을 줄 수 있어 rows.length 조기 종료는 금물 —
    // 범위 시작 도달 또는 진전 없음(earliest 불변)일 때만 멈춘다.
    if (earliest.date <= fromDate || earliest.date === prevEarliest) break;
    prevEarliest = earliest.date;
    to = minusOneDay(earliest.date);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** "YYYY-MM-DD" 또는 epoch 초 문자열 → epoch 초. 파싱 불가면 NaN. */
function toEpochSec(v: string, endOfDay: boolean): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return Math.floor(Date.parse(`${v}T${endOfDay ? "23:59:59" : "00:00:00"}Z`) / 1_000);
  }
  return Math.floor(Number(v));
}

/** epoch 초 → 시장 로컬 날짜 "YYYY-MM-DD" (일봉 date = 거래소 로컬 거래일, schema 계약). */
function marketLocalDate(market: Market, sec: number): string {
  const tz = market === "KR" ? "Asia/Seoul" : "America/New_York";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(sec * 1_000),
  );
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * 라우트 핸들러 — index.ts에서 배선. 인증은 /snapshot 관용구(시크릿 설정 시에만 검증 —
 * 프로덕션은 부팅 게이트가 시크릿을 보장, 로컬 mock은 무인증 읽기 허용).
 */
export async function handleBackfill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (config.workerSecret && req.headers["x-worker-secret"] !== config.workerSecret) {
    res.statusCode = 401;
    res.end("unauthorized");
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const market = url.searchParams.get("market") as Market | null;
  const symbol = url.searchParams.get("symbol") ?? "";
  const tf = (url.searchParams.get("tf") ?? "") as ChartTimeframe;
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  if (market !== "KR" && market !== "US") return respondJson(res, 400, { error: "market" });
  if (!getEntry(market, symbol)) return respondJson(res, 400, { error: "unknown symbol" }); // 유니버스 검증
  const minutes: number | undefined = (TF_MINUTES as Record<string, number | undefined>)[tf];
  if (minutes === undefined && tf !== "day") return respondJson(res, 400, { error: "tf" }); // week/month는 web이 day에서 파생
  if (!fromRaw || !toRaw) return respondJson(res, 400, { error: "from/to" });
  const fromSec = toEpochSec(fromRaw, false);
  const toSec = toEpochSec(toRaw, true);
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || fromSec >= toSec) {
    return respondJson(res, 400, { error: "range" });
  }

  // TTL 격자 버킷팅 — 키는 순수 격자 셀 끝(bucketTo)만 사용. **now 클램프를 키에 넣지 말 것**:
  // 넣으면 키가 초 단위로 갈려 캐시가 사실상 무력화된다. now 클램프는 fetch 범위에만 적용.
  const ttlMs = tf === "day" ? DAY_TTL_MS : minutes! * 60 * 60 * 1_000; // 분봉 = tf초×60
  const ttlSec = ttlMs / 1_000;
  const bucketFrom = Math.floor(fromSec / ttlSec) * ttlSec;
  const bucketTo = (Math.floor(toSec / ttlSec) + 1) * ttlSec; // 순수 격자 셀 끝
  const key = `${market}:${symbol}:${tf}:${bucketTo}`;

  try {
    let entry = cache.get(key);
    if (!entry) {
      entry = await loadEntry(market, symbol, tf, minutes, bucketFrom, Math.min(bucketTo, Math.floor(Date.now() / 1_000)));
      cache.set(key, entry, ttlMs);
    } else if (bucketFrom < entry.coveredFromSec) {
      // 캐시 적중이지만 요청이 커버 범위보다 과거 — 미커버 과거 구간만 추가 조회해 누적(부분 miss).
      const older = await loadEntry(market, symbol, tf, minutes, bucketFrom, entry.coveredFromSec - 1);
      entry = mergeEntries(older, entry, tf);
      cache.set(key, entry, ttlMs);
    }
    if (tf === "day") {
      const from = marketLocalDate(market, fromSec);
      const to = marketLocalDate(market, toSec);
      return respondJson(res, 200, (entry.candles as DailyCandle[]).filter((d) => d.date >= from && d.date <= to));
    }
    return respondJson(res, 200, (entry.candles as IntradayCandle[]).filter((c) => c.time >= fromSec && c.time <= toSec));
  } catch (e) {
    console.error("[backfill] 외부 캔들 조회 실패", e);
    return respondJson(res, 502, { error: "upstream" });
  }
}

/**
 * 범위 로드 + 커버 시작 산출. coveredFromSec = 수신 최고(最古) 캔들 시각(부분·예산 절단 응답도
 * 실제 커버를 기록 — 이후 더 깊은 from 요청이 가짜 []가 아니라 미커버 연장 조회를 타게 한다).
 * 빈 응답은 "요청 시작까지 커버"로 기록(같은 범위 재탐색 방지).
 * ponytail: 완주/절단 신호를 소스별로 배관하지 않은 근사 — 데이터 시작 경계(주말 갭 등)에서
 * TTL 셀당 한 번의 추가 탐색(빈 결과)이 생길 수 있는 상한, 문제되면 절단 신호 배관.
 */
async function loadEntry(
  market: Market,
  symbol: string,
  tf: ChartTimeframe,
  minutes: number | undefined,
  fromSec: number,
  toSec: number,
): Promise<CacheEntry> {
  if (fromSec >= toSec) return { candles: [], coveredFromSec: fromSec };
  const candles = await loadRange(market, symbol, tf, minutes, fromSec, toSec);
  const first = candles[0];
  const coveredFromSec =
    first === undefined
      ? fromSec
      : "time" in first
        ? first.time
        : Math.floor(Date.parse(`${first.date}T00:00:00Z`) / 1_000);
  return { candles, coveredFromSec };
}

/** 커버 연장 병합 — time/date 중복 제거(기존 캐시 우선), 오름차순. 테스트를 위해 export. */
export function mergeEntries(older: CacheEntry, cur: CacheEntry, tf: ChartTimeframe): CacheEntry {
  const coveredFromSec = Math.min(older.coveredFromSec, cur.coveredFromSec);
  if (tf === "day") {
    const byDate = new Map<string, DailyCandle>();
    for (const c of older.candles as DailyCandle[]) byDate.set(c.date, c);
    for (const c of cur.candles as DailyCandle[]) byDate.set(c.date, c);
    return { candles: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), coveredFromSec };
  }
  const byTime = new Map<number, IntradayCandle>();
  for (const c of older.candles as IntradayCandle[]) byTime.set(c.time, c);
  for (const c of cur.candles as IntradayCandle[]) byTime.set(c.time, c);
  return { candles: [...byTime.values()].sort((a, b) => a.time - b.time), coveredFromSec };
}

/** 소스 분기 — 키 부재 시 각 클라이언트가 빈 배열 반환(fail-soft, 200 유지). */
async function loadRange(
  market: Market,
  symbol: string,
  tf: ChartTimeframe,
  minutes: number | undefined,
  fromSec: number,
  toSec: number,
): Promise<IntradayCandle[] | DailyCandle[]> {
  const budget = envInt("KIS_BACKFILL_CALL_BUDGET", 10);
  if (tf === "day") {
    const from = marketLocalDate(market, fromSec);
    const to = marketLocalDate(market, toSec);
    return market === "KR" ? krDailyRange(symbol, from, to, budget) : fetchUsDaily(symbol, from, to);
  }
  if (market === "US") return fetchUsMinutes(symbol, minutes!, fromSec, toSec);
  // KR 분봉: 1분을 예산 내에서 모아 tf로 롤업(깊은 과거는 부분 응답 — 스펙 명시 한계).
  const oneMin = await krMinuteRange(symbol, fromSec, toSec, budget);
  return aggregateIntraday(oneMin, minutes!);
}
