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
import {
  expectedMinuteBars,
  isChartLiveSource,
  isCurrentDailyPeriod,
  isMinuteTf,
  marketDayOf,
  mergeLiveCandles,
} from "./candleServe";

const MAX_CANDLES = CANDLE_LIMITS.intradayCandleCap; // 분봉 유지 상한 — 서버 캡과 동일 정책.
const SEC = 60; // 분→초 환산 — aggregateIntraday(shared)와 동일 경계.

// ponytail: 분봉 백필이 빈/짧게 오는 건 장중엔 거의 항상 일시적(워커 재기동 직후·KIS REST
// 순간 rate-limit EGW00201로 캐시가 아직 안 데워짐 → 라우트가 DB의 몇 안 되는 로우만 반환) —
// 실데이터는 존재하니 몇 초 뒤 재시도하면 채워진다. 일·주·월의 빈 응답은 정직한 공백일 수 있어 재시도 안 함.
// ~30초 창(10×3s) — KIS 경합 하 최악의 콜드 백필(~10-15s)+persist 반영까지 커버(8s는 짧아 재시도 소진).
const BACKFILL_RETRY = { tries: 10, delayMs: 3000 };
// 재시도 임계: 세션 경과분 대비 이 비율 미만이면 "실패 강등"으로 보고 재시도(정상은 수십·수백봉).
// 백필이 예산 절단·부분 커버로 세션 전체보다 짧을 수 있어 여유 있게 절반으로 — 개장 직후엔 기대치도
// 작아 불필요 재시도 안 함. 기대 0(개장 전·휴장)이면 빈 응답도 정직한 공백으로 확정(재시도 안 함).
const BACKFILL_MIN_RATIO = 0.5;

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
  const source = quote?.source; // mock 여부 판별용(B4 차트 확장)

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const minute = isMinuteTf(tf);
    const url = `/api/candles?market=${market}&symbol=${encodeURIComponent(symbol)}&tf=${tf}`;
    // 백필 fetch. 분봉이 빈/실패면 BACKFILL_RETRY 만큼 재시도, 비어있지 않은 응답이 오는 즉시 확정.
    const load = async (attempt: number) => {
      let data: unknown = [];
      try {
        // no-store 필수: /api/candles엔 Cache-Control이 없어 브라우저가 콜드 창의 빈/짧은 응답을
        // 캐시·리플레이 → backfill이 영영 []로 고착(재시도도 캐시된 빈 body 재독). 라이브 시세는 캐시 금물.
        const r = await fetch(url, { cache: "no-store" });
        data = r.ok ? await r.json() : [];
      } catch {
        // 실패 → 아래 재시도 판단으로 넘어감(라이브 단독 강등 유지). 에러 UI는 호출부 소관.
      }
      if (!alive) return;
      const arr = Array.isArray(data) ? data : [];
      if (!minute) {
        setDaily(arr as DailyCandle[]); // 일·주·월: 빈 응답도 정본으로 확정, 재시도 없음.
        return;
      }
      // 받은 만큼은 항상 반영(짧아도 라이브보다 낫다) — 그 위에서 임계 미달이면 재시도.
      if (arr.length > 0) setBackfill(arr as IntradayCandle[]);
      // 세션 경과분 → 이 tf의 기대 봉수. 기대 0(개장 전·휴장·주말)이면 임계 0 → 빈 응답도 확정, 재시도 안 함.
      // arr.length가 empty뿐 아니라 "실패 강등(~2봉)"일 때도 재시도 — 라우트는 백필 실패 시 DB 몇 로우만 준다.
      const expected = Math.floor(expectedMinuteBars(market, new Date()) / TF_MINUTES[tf]);
      const enough = arr.length >= expected * BACKFILL_MIN_RATIO;
      if (!enough && attempt < BACKFILL_RETRY.tries) {
        timer = setTimeout(() => load(attempt + 1), BACKFILL_RETRY.delayMs);
      }
      // 재시도 소진 → 마지막으로 받은(빈·짧은) backfill 유지.
    };
    void load(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [market, symbol, tf]);

  // 분봉 라이브 집계: 틱을 tf 버킷(epoch floor)에 fold. 롤오버 시 직전 버킷을 completed로 승격.
  useEffect(() => {
    if (ts == null || price == null || !isMinuteTf(tf)) return;
    if (!isChartLiveSource(source)) return; // 확인된 실피드 틱만 분봉 집계(B4 차트 확장 — mock·baseline 합성 제외)
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
  }, [market, symbol, tf, ts, price, source]);

  // 일·주·월 라이브: **마지막 봉만** h/l/c 갱신. 응답이 비었으면 그대로 빈 배열(봉 생성 금지 — 계약).
  useEffect(() => {
    if (ts == null || price == null || isMinuteTf(tf)) return;
    if (!isChartLiveSource(source)) return; // 확인된 실피드 틱만 마지막 봉 갱신(B4 차트 확장 — mock·baseline 합성 제외)
    const today = marketDayOf(market, new Date(ts)); // "오늘"은 시장 tz(US 세션은 KST 이틀에 걸침)
    setDaily((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      // 마지막 봉이 오늘이 속한 기간(day=당일, week=ISO주, month=월)일 때만 — 서버가 합성을
      // 생략한 정직한 공백을 클라가 메우지 않고, 스테일 마지막 봉을 라이브로 덮지 않는다.
      if (!isCurrentDailyPeriod(tf, last.date, today)) return prev;
      if (price === last.c && price <= last.h && price >= last.l) return prev; // 무변화 → 참조 유지
      return [
        ...prev.slice(0, -1),
        { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price },
      ];
    });
  }, [market, tf, ts, price, source]);

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
