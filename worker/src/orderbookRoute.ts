// GET /orderbook?market=KR|US&symbol=... — 종목 호가창(depth) 프록시(표시 전용, 체결·정산 무관).
// 현재가는 PriceBook에서 읽고, 실 호가는 KR·kis 피드일 때만 KIS에서 받아온다(가격이 실데이터라
// 실 호가와 일관). 그 외(mock KR·모든 US — "US 무료까지만": 무료 US 호가 소스 없음)는 현재가
// 주변으로 synthOrderbook 합성. 인증은 /snapshot·/index-candles 관용구(시크릿 설정 시에만 검증).
// 미지 심볼·현재가 부재·KIS 실패는 빈/synth 호가 200(fail-soft) — web /api/orderbook가 그대로 프록시.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getEntry, synthOrderbook, type Market } from "@mockstock/shared";
import { config } from "./config";
import { fetchKrOrderbook } from "./candles/kisRest";
import { TtlCache } from "./candles/backfillRoute";
import type { PriceBook } from "./priceBook";

const TTL_MS = 1_500; // 짧은 캐시 — KIS 난타 방지 + 폴 스무딩(2s 폴 간격과 정합)
const cache = new TtlCache<unknown>(128); // 종목 상세 동시 조회분 — 작게

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function handleOrderbook(book: PriceBook, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (config.workerSecret && req.headers["x-worker-secret"] !== config.workerSecret) {
    res.statusCode = 401;
    res.end("unauthorized");
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const market = url.searchParams.get("market") as Market | null;
  const symbol = url.searchParams.get("symbol") ?? "";

  // 유니버스 검증 — 임의 심볼 조회 차단. 미지 심볼은 빈 호가(synth 형태).
  if ((market !== "KR" && market !== "US") || !getEntry(market, symbol)) {
    return respondJson(res, 200, { market, symbol, asks: [], bids: [], ts: Date.now(), source: "synth" });
  }

  const cacheKey = `${market}:${symbol}`;
  const hit = cache.get(cacheKey);
  if (hit) return respondJson(res, 200, hit);

  // 현재가 — 없으면(체결 대기) 빈 호가. synth·KIS 둘 다 현재가 기준이라 없으면 그릴 게 없다.
  const price = book.snapshot([{ market, symbol }])[0]?.price;
  if (price == null) {
    return respondJson(res, 200, { market, symbol, asks: [], bids: [], ts: Date.now(), source: "synth" });
  }

  // 실 KIS 호가는 KR·kis 피드일 때만 — 표시 현재가가 실데이터라 실 호가와 일관.
  if (market === "KR" && config.feeds.KR === "kis") {
    try {
      const ob = await fetchKrOrderbook(symbol);
      if (ob) {
        const body = { market, symbol, ...ob, ts: Date.now(), source: "kis" as const };
        cache.set(cacheKey, body, TTL_MS);
        return respondJson(res, 200, body);
      }
    } catch (e) {
      console.error("[orderbook] KIS 호가 실패, synth 폴백", e);
    }
    // ob 없음(빈 호가)·에러 → synth 폴백(아래로)
  }

  const body = synthOrderbook(market, symbol, price, Date.now());
  cache.set(cacheKey, body, TTL_MS);
  return respondJson(res, 200, body);
}
