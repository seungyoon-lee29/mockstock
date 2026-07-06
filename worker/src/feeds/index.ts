// 피드 팩토리 — config의 시장별 소스로 Feed 조립(B4).
import type { Market } from "@mockstock/shared";
import { config, type FeedKind } from "../config";
import type { Feed } from "./types";
import { MockFeed } from "./mock";
import { FinnhubFeed } from "./finnhub";
import { KisFeed } from "./kis";

export function createFeed(market: Market, kind: FeedKind): Feed {
  if (kind === "mock") return new MockFeed(market);
  if (kind === "finnhub") {
    // fail-safe: 키 없으면 부팅 실패 대신 mock 폴백(로컬·프리뷰 무키 구동 보장).
    if (!config.finnhubApiKey) {
      console.warn(`[feed] ${market}=finnhub 이나 FINNHUB_API_KEY 없음 — mock 폴백`);
      return new MockFeed(market);
    }
    return new FinnhubFeed(config.finnhubApiKey);
  }
  if (kind === "kis") {
    // fail-safe: 키 없으면 부팅 실패 대신 mock 폴백(로컬·프리뷰 무키 구동 보장).
    if (!config.kisAppKey || !config.kisAppSecret) {
      console.warn(`[feed] ${market}=kis 이나 KIS_APP_KEY/SECRET 없음 — mock 폴백`);
      return new MockFeed(market);
    }
    return new KisFeed(config.kisAppKey, config.kisAppSecret);
  }
  return new MockFeed(market);
}

export type { Feed };
