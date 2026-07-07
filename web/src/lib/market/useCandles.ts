"use client";

// SSE 최신 틱(ts·price)을 shared MinuteAggregator로 클라 버킷팅 → 1분봉(IntradayCandle[], time=초).
// 완성된 분봉은 aggregator 산출을 정본으로 쌓고(워커 축적과 동일 경로), 현재 진행 중인 분은
// forming 캔들로 라이브 갱신해 붙인다(초 단위 렌더 신선도). 백필 병합은 호출부(stock-detail)가 담당.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MinuteAggregator,
  type IntradayCandle,
  type Market,
  type Tick,
} from "@mockstock/shared";

const MAX_CANDLES = 240; // ponytail: 최근 N개 분봉만 유지(≈4시간). 세션 길어져도 메모리·렌더 상한 고정.
const SEC = 60; // 분 버킷 크기(초) — aggregator와 동일 경계.

/**
 * 실시간 1분봉 시리즈. usePriceSeries와 같은 입력 패턴(ts·price)에 market·symbol을 더해
 * shared Tick을 구성한다. time 오름차순·유일한 IntradayCandle[]를 반환한다.
 * @param ts   epoch **ms**(Quote.ts)
 * @param price 최신 체결가
 */
export function useCandles(
  market: Market,
  symbol: string,
  ts: number | undefined,
  price: number | undefined,
): IntradayCandle[] {
  const aggRef = useRef<MinuteAggregator | null>(null);
  aggRef.current ??= new MinuteAggregator();

  const [completed, setCompleted] = useState<IntradayCandle[]>([]);
  const [forming, setForming] = useState<IntradayCandle | null>(null);

  useEffect(() => {
    if (ts == null || price == null) return;
    const tick: Tick = { market, symbol, price, ts };
    const done = aggRef.current!.add(tick); // 분 롤오버 시 직전 완성봉(정본)·아니면 null
    if (done) {
      setCompleted((prev) => {
        const next = [...prev, done];
        return next.length > MAX_CANDLES ? next.slice(next.length - MAX_CANDLES) : next;
      });
    }
    // forming: 현재 분 버킷을 라이브 표시용으로 fold(정본은 롤오버 때 completed로 승격).
    const bucket = Math.floor(ts / 1000 / SEC) * SEC;
    setForming((prev) => {
      if (prev && bucket < prev.time) return prev; // 역행 틱 무시(aggregator와 동일 정책)
      return prev && prev.time === bucket
        ? { ...prev, h: Math.max(prev.h, price), l: Math.min(prev.l, price), c: price, v: prev.v + 1 }
        : { time: bucket, o: price, h: price, l: price, c: price, v: 1 };
    });
  }, [market, symbol, ts, price]);

  // completed(과거 확정) + forming(진행 중) — forming.time은 항상 completed 마지막보다 뒤라 유일·오름차순.
  return useMemo(
    () => (forming ? [...completed, forming] : completed),
    [completed, forming],
  );
}
