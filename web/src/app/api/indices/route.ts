// GET /api/indices — 홈 인덱스 스트립 프록시. 워커 /indices(메모리 REST 폴 결과)를 그대로 전달.
// 워커 미설정·타임아웃·비200은 조용히 빈 payload로 강등(fail-open) — UI는 "—" 표시.
// 시세는 워커가 KIS/Finnhub REST로 폴링해 보관, web은 순수 프록시(DB·키 미접촉).
import type { IndicesPayload } from "@mockstock/shared";

export const dynamic = "force-dynamic"; // 실시간 폴 결과 → 항상 동적.
export const runtime = "nodejs";

const EMPTY: IndicesPayload = { KR: [], US: [] };
const TIMEOUT_MS = 2_500; // /snapshot과 동일한 짧은 상한 — 느린 워커에 홈이 걸리지 않게.

export async function GET(): Promise<Response> {
  // WORKER_SNAPSHOT_URL(…/snapshot)에서 /indices 파생 — workerClient와 동일한 베이스 URL 관용구.
  const snapshotUrl = process.env.WORKER_SNAPSHOT_URL;
  if (!snapshotUrl) return Response.json(EMPTY); // 미설정(키 없는 로컬) → 빈 payload
  const url = new URL("/indices", snapshotUrl);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return Response.json(EMPTY);
    const payload = (await res.json()) as IndicesPayload;
    // CDN 짧은 캐시 — 폴 주기(기본 20s)보다 짧게 잡아 스트립이 과하게 밀리지 않게.
    return Response.json(payload, { headers: { "cache-control": "s-maxage=10" } });
  } catch {
    return Response.json(EMPTY); // 타임아웃·네트워크 실패 → fail-open
  } finally {
    clearTimeout(timer);
  }
}
