// Alpaca Market Data 클라이언트 (US 과거 캔들 백필·일봉 동기화 — 멀티 타임프레임 v2 배치 B).
//  - GET /v2/stocks/{symbol}/bars — feed=iex(무료), adjustment=split.
//  - Basic 플랜은 최근 15분 SIP 데이터 조회 불가 → end를 now-16분으로 클램프(여유 1분).
//  - next_page_token 페이지네이션, 최대 3페이지(폭주 방지). sort=desc로 최신부터 받아
//    페이지 캡 절단이 **오래된 쪽**에 걸리게 하고(스펙: 오래된 쪽 절단), 수집 후 오름차순 복원.
//  - 키(ALPACA_API_KEY_ID/SECRET) 부재 시 빈 배열(fail-soft) — kisRest와 동일 규약.
import { aggregateIntraday, type DailyCandle, type IntradayCandle } from "@mockstock/shared";

// kis.ts 관용구 — 엔드포인트는 모듈 상수(변경 여지 없는 벤더 고정값).
const DATA_BASE = "https://data.alpaca.markets";
const FEED = "iex"; // 무료 피드 — 저유동 종목 분봉 공백은 정직한 갭(스펙 리스크 잔여)
const ADJUSTMENT = "split";
const END_CLAMP_MS = 16 * 60 * 1_000; // 최근 15분 제한 + 여유 1분
const PAGE_LIMIT = 10_000;
const MAX_PAGES = 3;
const US_TZ = "America/New_York"; // 일봉 date = 거래소 로컬 거래일(schema 계약)

// 네이티브 타임프레임 매핑 — TF_MINUTES 기준. 10m은 Alpaca 네이티브가 없어
// 5Min을 받아 aggregateIntraday(…, 10)로 롤업한다(스펙 확정).
const NATIVE_TF: Record<number, string> = { 1: "1Min", 5: "5Min", 15: "15Min", 30: "30Min", 60: "1Hour" };

function keyId(): string | null {
  return process.env.ALPACA_API_KEY_ID || null;
}
function keySecret(): string | null {
  return process.env.ALPACA_API_SECRET_KEY || null;
}

/** 키 존재 여부 — false면 fetch류가 전부 빈 배열(호출부 fail-soft). */
export function isAlpacaEnabled(): boolean {
  return !!(keyId() && keySecret());
}

type AlpacaBar = { t: string; o: number; h: number; l: number; c: number; v: number };

/** bars 공통 fetch — end는 now-16분으로 클램프, next_page_token 최대 3페이지. */
async function fetchBars(symbol: string, timeframe: string, startSec: number, endSec: number): Promise<AlpacaBar[]> {
  if (!isAlpacaEnabled()) return [];
  const endMs = Math.min(endSec * 1_000, Date.now() - END_CLAMP_MS);
  if (endMs <= startSec * 1_000) return [];
  const bars: AlpacaBar[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", new Date(startSec * 1_000).toISOString());
    url.searchParams.set("end", new Date(endMs).toISOString());
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("feed", FEED);
    url.searchParams.set("adjustment", ADJUSTMENT);
    url.searchParams.set("sort", "desc"); // 최신부터 — MAX_PAGES 캡이 오래된 쪽을 자르게
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": keyId()!, "APCA-API-SECRET-KEY": keySecret()! },
    });
    if (!res.ok) throw new Error(`alpaca bars HTTP ${res.status}`);
    const json = (await res.json()) as { bars?: AlpacaBar[] | null; next_page_token?: string | null };
    bars.push(...(json.bars ?? []));
    pageToken = json.next_page_token ?? null;
    if (!pageToken) break;
  }
  return bars.reverse(); // desc 수집(페이지도 최신→과거) → 오름차순 복원
}

/**
 * US 분봉 — tfMinutes(1·5·10·15·30·60) 캔들, time=epoch 초 오름차순. 키 없으면 [].
 * 60m은 Alpaca 1Hour 네이티브(정시 앵커 — shared 정시 관례와 일치).
 */
export async function fetchUsMinutes(
  symbol: string,
  tfMinutes: number,
  fromSec: number,
  toSec: number,
): Promise<IntradayCandle[]> {
  const native = NATIVE_TF[tfMinutes];
  const bars = await fetchBars(symbol, native ?? NATIVE_TF[5], fromSec, toSec);
  const candles: IntradayCandle[] = bars.map((b) => ({
    time: Math.floor(Date.parse(b.t) / 1_000), // RFC3339 → epoch 초
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
  return native ? candles : aggregateIntraday(candles, tfMinutes); // 10m 등 비네이티브만 롤업
}

/** UTC epoch ms → ET 로컬 날짜 "YYYY-MM-DD" (en-CA 포맷이 ISO 순서). */
function etDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: US_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

/**
 * US 일봉 — from/to는 "YYYY-MM-DD"(ET 로컬 거래일). date 오름차순 DailyCandle[]. 키 없으면 [].
 * 1Day bar의 t는 ET 자정(UTC 04/05시)이라 from T00:00Z 시작으로 경계 정확.
 */
export async function fetchUsDaily(symbol: string, fromDate: string, toDate: string): Promise<DailyCandle[]> {
  const startSec = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1_000);
  const endSec = Math.floor(Date.parse(`${toDate}T23:59:59Z`) / 1_000);
  const bars = await fetchBars(symbol, "1Day", startSec, endSec);
  return bars.map((b) => ({ date: etDate(Date.parse(b.t)), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}
