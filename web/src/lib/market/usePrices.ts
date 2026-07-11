"use client";

import { useEffect, useRef, useState } from "react";
import { keyOf, type Market, type Quote, type Tick } from "@mockstock/shared";
import { applyBaseline, applyTicks, type BaselineMap } from "./baseline";

// mock: 웹앱 자체 SSE(/api/stream). 실 배포: 워커 URL을 env로 주입.
const STREAM_URL = process.env.NEXT_PUBLIC_STREAM_URL || "/api/stream";
// 초기 시드용 기준선 API(D12c) — instruments 영속값(없으면 서버가 seedPrice 폴백).
const BASELINE_URL = "/api/quotes/baseline";

/**
 * 주어진 심볼들의 실시간 시세를 구독. key("US:AAPL") → Quote 맵 반환.
 * 심볼 집합이 바뀌면 SSE를 재연결한다.
 * D12d: 마운트 시 baseline으로 quotes를 시드(price=lastPrice, change=lastPrice−prevClose)하고,
 * baseline·SSE snapshot·ticks 전부 키별로 ts가 더 최신일 때만 채택한다(전체 교체 금지 —
 * 지연 도착한 snapshot/baseline이 최신 틱을 되돌리지 않는다).
 */
export function usePrices(
  symbols: { market: Market; symbol: string }[],
): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  // 틱 change 기준선(prevClose) — baseline 도착 후 채워짐. 미도착이면 applyTicks가 폴백.
  const prevCloses = useRef<Record<string, number>>({});
  const keyStr = symbols
    .map((s) => keyOf(s.market, s.symbol))
    .sort()
    .join(",");

  // baseline 시드. 전체 유니버스 맵이라 요청 심볼 외 키도 실리지만 조회는 키 기반이라 무해.
  // ponytail: market 파라미터 최적화 생략 — 86종 몇 KB, 서버 30s 캐시가 흡수.
  useEffect(() => {
    if (!keyStr) return;
    let alive = true;
    fetch(BASELINE_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BaselineMap | null) => {
        if (!alive || !data) return;
        for (const [k, b] of Object.entries(data)) prevCloses.current[k] = Number(b.prevClose);
        setQuotes((prev) => applyBaseline(prev, data));
      })
      .catch(() => {
        // baseline 실패 → SSE 단독 동작(기존 하위호환). 카드·상세는 대시 대기 표기로 생존.
      });
    return () => {
      alive = false;
    };
  }, [keyStr]);

  useEffect(() => {
    if (!keyStr) return;
    const es = new EventSource(
      `${STREAM_URL}?symbols=${encodeURIComponent(keyStr)}`,
    );
    // EventSource.onmessage 는 명명 이벤트(event: snapshot/ticks)를 못 받는다.
    // 워커(sse.ts)·mock(/api/stream) 둘 다 명명 이벤트라 addEventListener 필수.
    // snapshot도 델타와 동일하게 키별 병합(D12d) — 재연결 snapshot이 상태를 되감지 않는다.
    const onTicks = (ev: MessageEvent) => {
      let ticks: Tick[];
      try {
        ticks = JSON.parse(ev.data);
      } catch {
        return;
      }
      setQuotes((prev) => applyTicks(prev, ticks, prevCloses.current));
    };
    es.addEventListener("snapshot", onTicks);
    es.addEventListener("ticks", onTicks);
    es.onerror = () => {
      // EventSource가 자동 재연결. 로그만.
      // ponytail: 하트비트 워치독·bfcache 재연결은 T05.
    };
    return () => es.close();
  }, [keyStr]);

  return quotes;
}
