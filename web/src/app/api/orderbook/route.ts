// GET /api/orderbook?market=KR|US&symbol=... — 종목 상세 호가창용 프록시.
// 워커 /orderbook(실 KIS 호가 or synth 합성 + 짧은 캐시)를 그대로 전달. 워커 미설정·타임아웃·비200은
// 조용히 빈 호가로 강등(fail-open) — UI는 "호가 대기 중". 키는 워커 env에만(B6), web은 순수 프록시.
import type { NextRequest } from "next/server";
import type { Orderbook } from "@mockstock/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 3_000;

/** fail-open 시 반환할 빈 호가 형태(source 없이 asks/bids만 — UI는 empty로 강등). */
const EMPTY = { asks: [], bids: [] } as Pick<Orderbook, "asks" | "bids">;

export async function GET(req: NextRequest): Promise<Response> {
  const snapshotUrl = process.env.WORKER_SNAPSHOT_URL;
  if (!snapshotUrl) return Response.json(EMPTY); // 미설정(키 없는 로컬) → 빈 호가

  const src = new URL(req.url);
  const url = new URL("/orderbook", snapshotUrl); // /snapshot 베이스에서 파생(workerClient 관용구)
  url.searchParams.set("market", src.searchParams.get("market") ?? "");
  url.searchParams.set("symbol", src.searchParams.get("symbol") ?? "");

  const secret = process.env.WORKER_SECRET;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: secret ? { "x-worker-secret": secret } : {},
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return Response.json(EMPTY);
    const payload = (await res.json()) as Orderbook;
    // 준실시간 — 최소 CDN 캐시로 반복 폴 완화(2s 폴이라 1s면 충분).
    return Response.json(payload, { headers: { "cache-control": "s-maxage=1" } });
  } catch {
    return Response.json(EMPTY); // 타임아웃·네트워크 실패 → fail-open
  } finally {
    clearTimeout(timer);
  }
}
