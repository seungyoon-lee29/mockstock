// 워커 /snapshot 클라이언트 (T04). 시장가 체결가는 오직 여기서 온다 — 클라이언트가 보낸
// 가격은 절대 신뢰하지 않는다(§6.1). 타임아웃·연결 실패는 호출부에서 스테일과 동일하게
// fail-closed 처리하도록 null을 반환한다. env는 런타임 lazy 접근(빌드 타임 미평가).
import type {
  ChartTimeframe,
  DailyCandle,
  IntradayCandle,
  Market,
} from "@mockstock/shared";

// PRD §6.1: 워커 /snapshot 호출 2~3초 타임아웃. 초과 시 abort → null(fail-closed).
const SNAPSHOT_TIMEOUT_MS = 2_500;
// §7.1: 주문 sync push는 베스트에포트 — 짧은 타임아웃, 실패는 조용히 무시.
const SYNC_TIMEOUT_MS = 2_000;

/** 워커 /snapshot 응답 1건 (PRD §7.3 스키마). at = epoch ms. */
export interface SnapshotTick {
  market: Market;
  symbol: string;
  price: number;
  at: number;
  source?: string;
}

/**
 * 워커 GET /snapshot 에서 단일 심볼 체결가를 조회한다.
 * 미설정·연결 실패·타임아웃·비200·심볼 부재는 모두 null → 호출부에서 fail-closed.
 */
export async function fetchSnapshot(market: Market, symbol: string): Promise<SnapshotTick | null> {
  const baseUrl = process.env.WORKER_SNAPSHOT_URL;
  const secret = process.env.WORKER_SECRET;
  if (!baseUrl) return null; // URL 미설정 → 시세 없음 → fail-closed

  const url = `${baseUrl}?symbols=${encodeURIComponent(`${market}:${symbol}`)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SNAPSHOT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: secret ? { "x-worker-secret": secret } : {},
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as SnapshotTick[];
    return arr.find((t) => t.market === market && t.symbol === symbol) ?? null;
  } catch {
    return null; // 타임아웃·네트워크 실패 → fail-closed(§6.1)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 워커 GET /candles/backfill 에서 과거 캔들을 조회한다(멀티 타임프레임 v2 — 부족 과거 구간 보강).
 * from/to = epoch **초**. 분봉 tf → IntradayCandle[], 일봉 계열 → DailyCandle[](워커 계약).
 * 백필은 장식이라 **fail-open**: 미설정·연결 실패·타임아웃·비200·비배열 응답 전부 null →
 * 호출부(/api/candles)는 조용히 DB-only로 강등한다.
 * 타임아웃은 외부 API(KIS/Alpaca) 경유라 스냅샷(2.5s)과 별개 env — BACKFILL_TIMEOUT_MS(기본 8000).
 */
export async function fetchBackfillCandles(
  market: Market,
  symbol: string,
  tf: ChartTimeframe,
  from: number,
  to: number,
): Promise<IntradayCandle[] | DailyCandle[] | null> {
  const snapshotUrl = process.env.WORKER_SNAPSHOT_URL;
  const secret = process.env.WORKER_SECRET;
  if (!snapshotUrl) return null; // 미설정(키 없는 로컬) → 백필 없음, DB-only

  const url = new URL("/candles/backfill", snapshotUrl); // /snapshot → /candles/backfill (sync와 동일 파생)
  url.searchParams.set("market", market);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("tf", tf);
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));

  const timeoutMs = Number(process.env.BACKFILL_TIMEOUT_MS) || 8_000; // env 런타임 lazy 접근
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: secret ? { "x-worker-secret": secret } : {},
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const arr: unknown = await res.json();
    return Array.isArray(arr) ? (arr as IntradayCandle[] | DailyCandle[]) : null;
  } catch {
    return null; // 타임아웃·네트워크 실패 → fail-open(백필 없이 서빙)
  } finally {
    clearTimeout(timer);
  }
}

/** 워커 매칭 캐시로 보낼 주문 요약(§7.1 payload.order). 숫자는 numeric 문자열로 보낸다. */
export interface SyncOrderPayload {
  id: string;
  userId?: string;
  seasonId?: string;
  market?: Market;
  symbol?: string;
  side?: "buy" | "sell";
  qty?: string;
  limitPrice?: string | null;
  reserved?: string | null;
}

/**
 * 지정가 접수/취소 시 워커 매칭 캐시를 동기화한다(§7.1: POST /internal/orders/sync).
 * URL은 WORKER_SNAPSHOT_URL 베이스에서 파생, x-worker-secret 필수. **워커 무응답·미설정은
 * 조용히 무시** — 워커 주기 재동기화 + §6.3 CAS가 안전망이라 push 유실이 정합성을 깨지 않는다.
 */
export async function pushOrderSync(op: "upsert" | "cancel", order: SyncOrderPayload): Promise<void> {
  const snapshotUrl = process.env.WORKER_SNAPSHOT_URL;
  const secret = process.env.WORKER_SECRET;
  if (!snapshotUrl || !secret) return; // 로컬 mock(미설정) → push 생략
  const url = new URL("/internal/orders/sync", snapshotUrl); // /snapshot → /internal/orders/sync
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": secret },
      body: JSON.stringify({ op, order }),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch {
    // 무응답·타임아웃·비200 전부 무시(§7.1)
  } finally {
    clearTimeout(timer);
  }
}
