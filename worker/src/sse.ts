// HTTP + SSE 서버 (node:http, 무의존성).
//  GET /health            업스트림 상태 (B14 모니터링)
//  GET /snapshot?symbols= 체결가 조회 (B1, WORKER_SECRET 헤더 검증)
//  GET /stream?symbols=   SSE: event:snapshot 1건 → event:ticks 델타(B2)
import http from "node:http";
import type { Market } from "@mockstock/shared";
import type { PriceBook } from "./priceBook";
import { config } from "./config";
import { syncOrder, type SyncOrderInput } from "./matching";
import { kisStats } from "./feeds/kis";

function parseSymbols(param: string | null): { market: Market; symbol: string }[] {
  if (!param) return [];
  return param
    .split(",")
    .map((s) => {
      const [market, symbol] = s.split(":");
      return { market: market as Market, symbol };
    })
    .filter((x) => (x.market === "US" || x.market === "KR") && !!x.symbol);
}

export function createHttpServer(book: PriceBook): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);

    if (url.pathname === "/health") {
      res.setHeader("Content-Type", "application/json");
      // 시장별 마지막 틱 시각 → age(ms). 스테일 감지용.
      // ponytail: T05에서 장중 age>60s → 503 + STALE_KR/US 키워드, /stream 동시 연결 상한.
      const now = Date.now();
      const lastTs: Record<Market, number> = { KR: 0, US: 0 };
      const ticks = book.all();
      for (const t of ticks) {
        if (t.ts > lastTs[t.market]) lastTs[t.market] = t.ts;
      }
      res.end(
        JSON.stringify({
          ok: true,
          feeds: config.feeds,
          symbols: ticks.length,
          age: {
            KR: lastTs.KR ? now - lastTs.KR : null,
            US: lastTs.US ? now - lastTs.US : null,
          },
          kisSubscribeRejects: kisStats.subscribeRejects, // R4: KIS 41한도 초과 실측
        }),
      );
      return;
    }

    if (url.pathname === "/snapshot") {
      // 읽기 경로 — 시크릿 설정 시에만 검증. 프로덕션은 부팅 게이트가 시크릿을 보장하므로 사실상 상시 인증,
      // 로컬 mock(시크릿 미설정)은 무인증 읽기 허용(무해). 상태변경은 /internal/orders/sync에서 무조건 인증.
      if (config.workerSecret && req.headers["x-worker-secret"] !== config.workerSecret) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      const ticks = book.snapshot(parseSymbols(url.searchParams.get("symbols")));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(ticks.map((t) => ({ symbol: t.symbol, market: t.market, price: t.price, at: t.ts, source: t.source }))));
      return;
    }

    if (url.pathname === "/internal/orders/sync") {
      // web→worker 주문 sync push(§7.1). 상태 변경 인입은 예외 없이 인증(worker.md) — fail-closed:
      // 시크릿 미설정이면 무조건 거부(무인증 상태변경 경로 금지). 프로덕션은 부팅 게이트가 시크릿 보장.
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("method not allowed");
        return;
      }
      if (!config.workerSecret || req.headers["x-worker-secret"] !== config.workerSecret) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { op, order } = JSON.parse(body) as { op?: string; order?: SyncOrderInput };
          if ((op === "upsert" || op === "cancel") && order?.id) syncOrder(op, order);
        } catch {
          // 잘못된 페이로드는 무시 — 워커 주기 재동기화가 안전망(§7.1).
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (url.pathname === "/stream") {
      const keys = parseSymbols(url.searchParams.get("symbols"));
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // B2: 연결 직후 전체 스냅샷 1건
      res.write(`event: snapshot\ndata: ${JSON.stringify(book.snapshot(keys))}\n\n`);
      // ponytail: 진짜 델타는 T05. 지금은 1초 간격 현재값 재전송.
      const timer = setInterval(() => {
        res.write(`event: ticks\ndata: ${JSON.stringify(book.snapshot(keys))}\n\n`);
      }, 1000);
      req.on("close", () => clearInterval(timer));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });
}
