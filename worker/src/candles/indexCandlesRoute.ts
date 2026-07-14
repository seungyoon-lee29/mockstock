// GET /index-candles?market=KR|US&key=KS11|GSPC — 지수 일봉(홈 지수 라인차트).
// DB 무접촉 + 인메모리 TTL 캐시(1h — 하루 1회 갱신). KR·US 모두 Yahoo 실제 지수 일봉(^KS11/^KQ11/^GSPC/^IXIC, 지연).
// 인증은 /snapshot·/candles/backfill 관용구(x-worker-secret 설정 시에만 검증). 미지 심볼·실패는
// 빈 배열 200(fail-soft) — web /api/index-candles가 그대로 프록시, UI는 빈 차트로 강등.
import type { IncomingMessage, ServerResponse } from "node:http";
import { INDICES, type DailyCandle, type Market } from "@mockstock/shared";
import { config } from "../config";
import { fetchYahooIndexDaily } from "../feeds/yahoo";
import { TtlCache } from "./backfillRoute";

const TTL_MS = 3_600_000; // 1h — 지수 일봉은 하루 1회 갱신
const cache = new TtlCache<DailyCandle[]>(16); // 지수 4종 — 작게

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function handleIndexCandles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (config.workerSecret && req.headers["x-worker-secret"] !== config.workerSecret) {
    res.statusCode = 401;
    res.end("unauthorized");
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const market = url.searchParams.get("market") as Market | null;
  const key = url.searchParams.get("key") ?? "";

  // 유니버스(INDICES) 검증 — 임의 심볼 조회 차단.
  if ((market !== "KR" && market !== "US") || !INDICES[market].some((d) => d.key === key)) {
    return respondJson(res, 200, []); // fail-soft(미지 market·키는 빈 차트)
  }

  const cacheKey = `${market}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit) return respondJson(res, 200, hit);

  try {
    const candles = await fetchYahooIndexDaily(`^${key}`); // ^KS11/^KQ11/^GSPC/^IXIC (range 기본 1y)
    cache.set(cacheKey, candles, TTL_MS);
    return respondJson(res, 200, candles);
  } catch (e) {
    console.error("[index-candles] 지수 일봉 조회 실패", e);
    return respondJson(res, 502, { error: "upstream" });
  }
}
