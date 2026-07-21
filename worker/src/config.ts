// 워커 설정 — env에서 읽고 기본값은 mock(키 없이 로컬 구동).
import type { Market } from "@mockstock/shared";

export type FeedKind = "mock" | "finnhub" | "kis";

// KIS REST 도메인 — 이 두 상수가 유일한 정의처(feeds/kis.ts·candles/kisRest.ts는 config.kisRestBase만 사용).
export const KIS_REST_BASE_VTS = "https://openapivts.koreainvestment.com:29443"; // 모의(VTS) 도메인 — 기본값
export const KIS_REST_BASE_PROD = "https://openapi.koreainvestment.com:9443"; // 실전 도메인

export interface WorkerConfig {
  port: number;
  feeds: Record<Market, FeedKind>;
  finnhubApiKey: string | null; // US 실시세 토큰. 없으면 finnhub→mock 폴백(B6/B14: 워커 env 전용).
  kisAppKey: string | null; // KR 실시세 앱키(모의/VTS). 없으면 kis→mock 폴백(B6/B14: 워커 env 전용).
  kisAppSecret: string | null; // KR 실시세 시크릿. 로그 노출 금지.
  kisRestBase: string; // KIS REST/WS 도메인(캔들 백필 + WS approval 공용). 기본 VTS(모의) — 실전 앱키면 KIS_REST_BASE_PROD로 설정.
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
  kisAppKey: process.env.KIS_APP_KEY || null,
  kisAppSecret: process.env.KIS_APP_SECRET || null,
  kisRestBase: process.env.KIS_REST_BASE || KIS_REST_BASE_VTS,
  workerSecret: process.env.WORKER_SECRET || null,
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  databaseUrl: process.env.DATABASE_URL || null,
};

/**
 * 프로덕션 fail-closed 부팅 게이트(worker.md). NODE_ENV=production에선 WORKER_SECRET(실값)과
 * CORS_ORIGIN(실오리진, '*' 불가)이 둘 다 있어야 기동한다. 하나라도 없으면 무인증 상태변경·
 * 전체 오리진 개방을 막기 위해 부팅을 거부(process.exit(1))한다. 비프로덕션(로컬 mock)은 통과.
 */
export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return; // 로컬 mock 무해 — 게이트 미발동
  const missing: string[] = [];
  if (!config.workerSecret) missing.push("WORKER_SECRET");
  if (!config.corsOrigin || config.corsOrigin === "*") missing.push("CORS_ORIGIN(실오리진, '*' 불가)");
  if (missing.length) {
    console.error(
      `[worker] 프로덕션 부팅 거부 — 필수 보안 env 누락: ${missing.join(", ")}. ` +
        `무인증 상태변경/전체 오리진 개방을 막기 위해 기동하지 않습니다.`,
    );
    process.exit(1);
  }
}
