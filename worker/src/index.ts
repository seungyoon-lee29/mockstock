// 워커 엔트리 — 시장별 피드 → 시세북 → HTTP/SSE. mock 기본이라 키 없이 구동.
import type { Market } from "@mockstock/shared";
import { config, assertProductionConfig } from "./config";
import { PriceBook } from "./priceBook";
import { CandleAggregator } from "./aggregator";
import { createFeed, type Feed } from "./feeds";
import { createHttpServer } from "./sse";
import { startMatching } from "./matching";
import { startCron } from "./cron";
import { startBots } from "./bots";
import { closeDb } from "./db";

assertProductionConfig(); // 프로덕션 fail-closed 부팅 게이트 (worker.md) — 시크릿/CORS 없으면 기동 거부

const book = new PriceBook();
const aggregator = new CandleAggregator(); // P3-① 분봉 수집·저장(장중 실틱만 영속화)
aggregator.start();
const feeds: Feed[] = [];

for (const market of ["KR", "US"] as Market[]) {
  const kind = config.feeds[market];
  const feed = createFeed(market, kind);
  feed.start((tick) => {
    book.set(tick);
    aggregator.add(tick);
  });
  feeds.push(feed);
  console.log(`[feed] ${market} = ${kind}`);
}

startMatching(book); // T08
startCron(); // T06
startBots(book); // T07 — 공개 벤치마크 봇(DATABASE_URL 없으면 자동 비활성)

const server = createHttpServer(book);
server.listen(config.port, () => {
  console.log(`[worker] http://localhost:${config.port} (health/snapshot/stream)`);
});

async function shutdown() {
  console.log("[worker] shutting down");
  for (const f of feeds) f.stop();
  await aggregator.stop(); // 완성 분봉 flush 완료까지 대기 — 배포(SIGTERM) 시 유실 방지
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
