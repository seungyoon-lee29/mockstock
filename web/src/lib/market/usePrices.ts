"use client";

import { useEffect, useState } from "react";
import {
  keyOf,
  toQuote,
  seedPriceOf,
  type Market,
  type Quote,
  type Tick,
} from "@mockstock/shared";

// mock: 웹앱 자체 SSE(/api/stream). 실 배포: 워커 URL을 env로 주입.
const STREAM_URL = process.env.NEXT_PUBLIC_STREAM_URL || "/api/stream";

/**
 * 주어진 심볼들의 실시간 시세를 구독. key("US:AAPL") → Quote 맵 반환.
 * 심볼 집합이 바뀌면 SSE를 재연결한다.
 */
export function usePrices(
  symbols: { market: Market; symbol: string }[],
): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const keyStr = symbols
    .map((s) => keyOf(s.market, s.symbol))
    .sort()
    .join(",");

  useEffect(() => {
    if (!keyStr) return;
    const es = new EventSource(
      `${STREAM_URL}?symbols=${encodeURIComponent(keyStr)}`,
    );
    // EventSource.onmessage 는 명명 이벤트(event: snapshot/ticks)를 못 받는다.
    // 워커(sse.ts)·mock(/api/stream) 둘 다 명명 이벤트라 addEventListener 필수.
    const toMap = (data: string): Record<string, Quote> => {
      let ticks: Tick[];
      try {
        ticks = JSON.parse(data);
      } catch {
        return {};
      }
      const m: Record<string, Quote> = {};
      for (const t of ticks) {
        m[keyOf(t.market, t.symbol)] = toQuote(
          t,
          seedPriceOf(t.market, t.symbol),
        );
      }
      return m;
    };
    // snapshot: 시세 전체 대체
    es.addEventListener("snapshot", (ev: MessageEvent) => {
      setQuotes(toMap(ev.data));
    });
    // ticks: 델타 병합
    es.addEventListener("ticks", (ev: MessageEvent) => {
      setQuotes((prev) => ({ ...prev, ...toMap(ev.data) }));
    });
    es.onerror = () => {
      // EventSource가 자동 재연결. 로그만.
      // ponytail: 하트비트 워치독·bfcache 재연결은 T05.
    };
    return () => es.close();
  }, [keyStr]);

  return quotes;
}
