// GET /api/index-candles?market=KR&key=0001 — 홈 지수 라인차트용 프록시.
// 워커 /index-candles(KIS 기간별 지수 일봉 + TTL 캐시)를 그대로 전달. 워커 미설정·타임아웃·비200은
// 조용히 빈 배열로 강등(fail-open) — UI는 빈 차트. 키는 워커 env에만(B6), web은 순수 프록시.
import type { NextRequest } from "next/server";
import type { DailyCandle } from "@mockstock/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 4_000; // KIS 경유라 /indices(2.5s)보다 여유.

export async function GET(req: NextRequest): Promise<Response> {
  const snapshotUrl = process.env.WORKER_SNAPSHOT_URL;
  if (!snapshotUrl) return Response.json([] as DailyCandle[]); // 미설정(키 없는 로컬) → 빈 차트

  const src = new URL(req.url);
  const url = new URL("/index-candles", snapshotUrl); // /snapshot 베이스에서 파생(workerClient 관용구)
  url.searchParams.set("market", src.searchParams.get("market") ?? "");
  url.searchParams.set("key", src.searchParams.get("key") ?? "");

  const secret = process.env.WORKER_SECRET;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: secret ? { "x-worker-secret": secret } : {},
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return Response.json([] as DailyCandle[]);
    const payload = (await res.json()) as DailyCandle[];
    // 지수 일봉은 하루 1회 갱신 — CDN 짧은 캐시로 반복 조회 완화.
    return Response.json(payload, { headers: { "cache-control": "s-maxage=300" } });
  } catch {
    return Response.json([] as DailyCandle[]); // 타임아웃·네트워크 실패 → fail-open
  } finally {
    clearTimeout(timer);
  }
}
