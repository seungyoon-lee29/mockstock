"use client";

// tf 파라미터드 캔들 훅 (멀티 타임프레임 v2). **배치 D 계약 — 시그니처 안정 유지**:
//   useCandles(market, symbol, tf)
//   - 분봉 tf("1m"…"60m") → IntradayCandle[] (time=epoch 초, 오름차순)
//   - "day" | "week" | "month" → DailyCandle[] (date="YYYY-MM-DD" 거래소 로컬, 오름차순)
// 분봉: /api/candles?tf= 백필 1회 + SSE 틱을 tf 버킷(epoch floor — aggregateIntraday와 동일 수식)에
// 라이브 집계, 겹치는 버킷은 백필(서버 정본) 우선 병합. 일·주·월: 1회 fetch 후 **마지막 봉만** 틱 갱신.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CANDLE_LIMITS,
  keyOf,
  TF_MINUTES,
  type ChartTimeframe,
  type DailyCandle,
  type IntradayCandle,
  type Market,
} from "@mockstock/shared";
import { usePrices } from "./usePrices";
import { isMinuteTf, marketDayOf, mergeLiveCandles } from "./candleServe";

const MAX_CANDLES = CANDLE_LIMITS.intradayCandleCap; // 분봉 유지 상한 — 서버 캡과 동일 정책.
const SEC = 60; // 분→초 환산 — aggregateIntraday(shared)와 동일 경계.

/**
 * 타임프레임별 캔들 시리즈(백필 + 라이브). 요청 tf로 응답 타입 분기(별도 판별자 불요 — 계약).
 * ponytail: usePrices 내부 구독은 상세 페이지 헤더 구독과 SSE 2연결 — 워커가 흡수, 컨텍스트 공유는 필요해질 때.
 */
export function useCandles(
  market: Market,
  symbol: string,
  tf: ChartTimeframe,
): IntradayCandle[] | DailyCandle[] {
  const quotes = usePrices([{ market, symbol }]);
  const quote = quotes[keyOf(market, symbol)];
  const ts = quote?.ts; // epoch ms
  const price = quote?.price;

  const [backfill, setBackfill] = useState<IntradayCandle[]>([]); // 분봉 서버 정본
  const [daily, setDaily] = useState<DailyCandle[]>([]); // 일·주·월 서버 응답
  const [completed, setCompleted] = useState<IntradayCandle[]>([]); // 라이브 완성 버킷
  const [forming, setForming] = useState<IntradayCandle | null>(null); // 진행 중 버킷
  const curRef = useRef<IntradayCandle | null>(null); // forming의 정본(업데이터 부수효과 회피)
  const tfRef = useRef(tf); // tf 전환 직후, 리셋 effect 실행 전 렌더의 스테일 시리즈 노출 방지

  // tf·심볼 변경 시 리셋 + 백필 1회 fetch. 비어도(day1·키 없는 로컬) 라이브만으로 정상 동작.
  useEffect(() => {
    tfRef.current = tf;
    curRef.current = null;
    setBackfill([]);
    setDaily([]);
    setCompleted([]);
    setForming(null);
    let alive = true;
    fetch(`/api/candles?market=${market}&symbol=${encodeURIComponent(symbol)}&tf=${tf}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        if (!alive || !Array.isArray(data)) return;
        if (isMinuteTf(tf)) setBackfill(data as IntradayCandle[]);
        else setDaily(data as DailyCandle[]);
      })
      .catch(() => {
        // 백필 실패 → 라이브 단독 동작(강등). 에러 UI는 호출부 소관.
      });
    return () => {
      alive = false;
    };
  }, [market, symbol, tf]);

  // 분봉 라이브 집계: 틱을 tf 버킷(epoch floor)에 fold. 롤오버 시 직전 버킷을 completed로 승격.
  useEffect(() => {
    if (ts == null || price == null || !isMinuteTf(tf)) return;
    const size = TF_MINUTES[tf] * SEC;
    const sec = Math.floor(ts / 1000);
    const bucket = sec - (sec % size);
    const cur = curRef.current;
    if (cur && bucket < cur.time) return; // 역행 틱 무시(기존 aggregator와 동일 정책)
    if (!cur || bucket > cur.time) {
      if (cur) {
        const done = cur;
        setCompleted((prev) => {
          const next = [...prev, done];
          return next.length > MAX_CANDLES ? next.slice(next.length - MAX_CANDLES) : next;
        });
      }
      curRef.current = { time: bucket, o: price, h: price, l: price, c: price, v: 1 };
    } else {
      curRef.current = {
        ...cur,
        h: Math.max(cur.h, price),
        l: Math.min(cur.l, price),
        c: price,
        v: cur.v + 1, // v=틱 카운트(shared 관례)
      };
    }
    setForming(curRef.current);
  }, [market, symbol, tf, ts, price]);

  // 일·주·월 라이브: **마지막 봉만** h/l/c 갱신. 응답이 비었으면 그대로 빈 배열(봉 생성 금지 — 계약).
  useEffect(() => {
    if (ts == null || price == null || isMinuteTf(tf)) return;
    const today = marketDayOf(market, new Date(ts)); // "오늘"은 시장 tz(US 세션은 KST 이틀에 걸침)
    setDaily((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      // day: 마지막 봉이 오늘 봉일 때만(서버가 합성을 생략한 정직한 공백을 클라가 메우지 않는다).
      // ponytail: week/month는 마지막 봉이 현재 기간이라 가정하고 갱신 — 스테일 데이터면 어차피 낡은 차트.
      if (tf === "day" && last.date !== today) return prev;
      if (price === last.c && price <= last.h && price >= last.l) return prev; // 무변화 → 참조 유지
      return [
        ...prev.slice(0, -1),
        { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price },
      ];
    });
  }, [market, tf, ts, price]);

  // 분봉 병합: 백필 마지막과 겹치는 라이브 버킷은 **결합**(h/l 확장·c 라이브 — 덮으면 최신 틱 유실),
  // 더 최신 라이브 버킷은 이어붙이고 더 과거 라이브는 폐기. 캡 적용.
  const minuteSeries = useMemo(() => {
    const live = forming ? [...completed, forming] : completed;
    const merged = mergeLiveCandles(backfill, live);
    return merged.length > MAX_CANDLES ? merged.slice(-MAX_CANDLES) : merged;
  }, [backfill, completed, forming]);

  // tf가 방금 바뀐 렌더 — 상태 리셋 effect가 아직 안 돌아 이전 tf 시리즈가 남아 있다 → 빈 배열.
  if (tfRef.current !== tf) return [];
  return isMinuteTf(tf) ? minuteSeries : daily;
}
