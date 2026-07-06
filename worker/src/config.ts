// 워커 설정 — env에서 읽고 기본값은 mock(키 없이 로컬 구동).
import type { Market } from "@mockstock/shared";

export type FeedKind = "mock" | "finnhub" | "kis";

export interface WorkerConfig {
  port: number;
  feeds: Record<Market, FeedKind>;
  finnhubApiKey: string | null; // US 실시세 토큰. 없으면 finnhub→mock 폴백(B6/B14: 워커 env 전용).
  workerSecret: string | null;
  corsOrigin: string;
  databaseUrl: string | null;
}

function feedKind(v: string | undefined, fallback: FeedKind): FeedKind {
  return v === "finnhub" || v === "kis" || v === "mock" ? v : fallback;
}

export const config: WorkerConfig = {
  port: Number(process.env.PORT ?? 8787),
  feeds: {
    KR: feedKind(process.env.FEED_KR, "mock"),
    US: feedKind(process.env.FEED_US, "mock"),
  },
  finnhubApiKey: process.env.FINNHUB_API_KEY || null,
  workerSecret: process.env.WORKER_SECRET || null,
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  databaseUrl: process.env.DATABASE_URL || null,
};
