// 워커 엔트리 — 시장별 피드 → 시세북 → HTTP/SSE. mock 기본이라 키 없이 구동.
import type { Market, Tick } from "@mockstock/shared";
import { config, assertProductionConfig } from "./config";
import { PriceBook } from "./priceBook";
import { CandleAggregator } from "./aggregator";
import { createFeed, type Feed } from "./feeds";
import { createHttpServer } from "./sse";
import { startMatching } from "./matching";
import { startCron } from "./cron";
import { startBots } from "./bots";
import { getDb, closeDb } from "./db";
import { seedInstruments, tapTick, startLastPriceFlush, flushLastPrices, loadAnchors } from "./instruments";
import { handleBackfill } from "./candles/backfillRoute";

assertProductionConfig(); // 프로덕션 fail-closed 부팅 게이트 (worker.md) — 시크릿/CORS 없으면 기동 거부

// D12a: 부팅 멱등 시드 — instruments 로우 부재로 시즌 평가가 0원 되는 P1 차단.
// DB 없으면(키리스 mock 로컬) 조용히 스킵. 부팅 1회 버스트라 B13(유휴 미접촉)과 양립.
const bootDb = getDb();
if (bootDb) {
  seedInstruments(bootDb)
    .then((n) => console.log(`[instruments] 부팅 시드 완료 — 유니버스 ${n}종목 (멱등)`))
    .catch((e) => console.error("[instruments] 부팅 시드 실패", e));
}

const book = new PriceBook();
const aggregator = new CandleAggregator(); // P3-① 분봉 수집·저장(장중 실틱만 영속화)
aggregator.start();
const lastPriceBuf = new Map<string, Tick>(); // D12b: 실피드 lastPrice 영속화 버퍼(mock 제외)
const stopLastPriceFlush = startLastPriceFlush(lastPriceBuf);
const feeds: Feed[] = [];

// mock 앵커(실 종가) 공유 맵 — 부팅 백필 브리지 후 instruments.lastPrice로 채워진다.
// 실피드엔 무관하고, mock 폴백 워크만 이 앵커로 실가 근방에 고정된다(스테일 seedPrice 궤도 제거).
const anchors = new Map<string, number>();

for (const market of ["KR", "US"] as Market[]) {
  const kind = config.feeds[market];
  const feed = createFeed(market, kind, anchors);
  feed.start((tick) => {
    book.set(tick);
    aggregator.add(tick);
    tapTick(lastPriceBuf, tick);
  });
  feeds.push(feed);
  console.log(`[feed] ${market} = ${kind}`);
}

// 앵커 로드 — startCron의 부팅 백필(비동기)이 daily_candles→instruments 브리지를 끝낸 뒤 값이 생긴다.
// 짧게 폴링(최대 ANCHOR_LOAD_TRIES회 · ANCHOR_LOAD_MS 간격)해 채워지면 종료. DB 없으면(키리스) 스킵.
if (bootDb) {
  // 창(tries×intervalMs)은 콜드 KR 백필(≈95초, dailySync 주석)보다 커야 브리지 착지 전에 폴러가 소진되지 않는다.
  // 기본 24×5s=120초로 여유 확보. env-tunable.
  const tries = Number(process.env.ANCHOR_LOAD_TRIES ?? 24);
  const intervalMs = Number(process.env.ANCHOR_LOAD_MS ?? 5_000);
  let left = tries;
  const poll = setInterval(() => {
    left--;
    loadAnchors(bootDb, anchors)
      .then((n) => {
        if (n > 0 || left <= 0) clearInterval(poll);
        if (n > 0) console.log(`[anchors] 실 종가 앵커 ${n}종목 로드 (mock 재시딩 근거)`);
      })
      .catch((e) => console.error("[anchors] 로드 실패", e));
  }, intervalMs);
  poll.unref?.();
}

startMatching(book); // T08
startCron(); // T06
startBots(book); // T07 — 공개 벤치마크 봇(DATABASE_URL 없으면 자동 비활성)

const server = createHttpServer(book);
// /candles/backfill 배선(멀티 타임프레임 v2 배치 B) — sse.ts 라우터는 배치 파일 경계상 불변,
// request 리스너 앞단에서 경로만 가로챈다(그 외 경로는 기존 핸들러 그대로).
const baseListeners = server.listeners("request") as Array<
  (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
>;
server.removeAllListeners("request");
server.on("request", (req, res) => {
  if ((req.url ?? "").startsWith("/candles/backfill")) {
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
    void handleBackfill(req, res);
    return;
  }
  for (const l of baseListeners) l.call(server, req, res);
});
server.listen(config.port, () => {
  console.log(`[worker] http://localhost:${config.port} (health/snapshot/stream)`);
});

async function shutdown() {
  console.log("[worker] shutting down");
  for (const f of feeds) f.stop();
  stopLastPriceFlush();
  await flushLastPrices(lastPriceBuf); // 마지막 lastPrice 배치 — 장중 배포 시 최신가 유실 방지(마감이면 no-op)
  await aggregator.stop(); // 완성 분봉 flush 완료까지 대기 — 배포(SIGTERM) 시 유실 방지
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
