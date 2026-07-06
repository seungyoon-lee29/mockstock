import type { NextRequest } from "next/server";
import { snapshot } from "@/lib/market/priceSource";
import type { Market } from "@mockstock/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseSymbols(param: string | null): { market: Market; symbol: string }[] {
  if (!param) return [];
  return param
    .split(",")
    .map((s) => {
      const [market, symbol] = s.split(":");
      return { market: market as Market, symbol };
    })
    .filter((x) => (x.market === "US" || x.market === "KR") && x.symbol);
}

// mock 시세를 1초 간격 SSE로 스트리밍. (실 배포 시 워커 URL로 대체)
export async function GET(req: NextRequest) {
  const keys = parseSymbols(req.nextUrl.searchParams.get("symbols"));
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 워커 프로토콜(sse.ts)과 동일: 최초 event:snapshot 1건 → 이후 event:ticks.
      const send = (event: "snapshot" | "ticks") => {
        try {
          const ticks = snapshot(keys);
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(ticks)}\n\n`),
          );
        } catch {
          // 컨트롤러가 닫힌 경우 무시
        }
      };
      send("snapshot"); // 즉시 초기 스냅샷
      timer = setInterval(() => send("ticks"), 1000);
      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
