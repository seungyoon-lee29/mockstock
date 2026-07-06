// 워커 엔트리 — 시장별 피드 → 시세북 → HTTP/SSE. mock 기본이라 키 없이 구동.
import type { Market } from "@mockstock/shared";
import { config } from "./config";
import { PriceBook } from "./priceBook";
import { createFeed, type Feed } from "./feeds";
import { createHttpServer } from "./sse";
import { startMatching } from "./matching";
import { startCron } from "./cron";
import { startBots } from "./bots";

const book = new PriceBook();
const feeds: Feed[] = [];

for (const market of ["KR", "US"] as Market[]) {
  const kind = config.feeds[market];
  const feed = createFeed(market, kind);
  feed.start((tick) => book.set(tick));
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

function shutdown() {
  console.log("[worker] shutting down");
  for (const f of feeds) f.stop();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
