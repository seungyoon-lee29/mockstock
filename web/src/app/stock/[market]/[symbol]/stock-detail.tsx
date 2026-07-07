"use client";

// 종목 상세: 현재가·등락 + SSE 틱 차트(라인/1분봉 토글) + 주문 패널.
// 라인=실시간 틱 누적, 1분=클라 버킷 라이브 분봉 + /api/candles 백필 병합.
import { useEffect, useMemo, useState } from "react";
import type { CandlestickData, LineData, Time, UTCTimestamp } from "lightweight-charts";
import { keyOf, type IntradayCandle, type UniverseEntry } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import { useCandles } from "@/lib/market/useCandles";
import { PriceChart } from "@/components/PriceChart";
import { PriceText } from "@/components/PriceText";
import { formatPrice } from "@/lib/market/format";
import { cn } from "@/lib/utils";
import { OrderPanel } from "./order-panel";

const MAX_POINTS = 300; // ponytail: 최근 N틱만 유지 — 세션 길어져도 메모리·렌더 상한 고정.

type Timeframe = "line" | "1m";
const CHART_HEIGHT = 360;

/**
 * 백필(과거) + 라이브(진행) 분봉을 time 오름차순·유일로 병합.
 * 겹치는 분은 백필(워커가 축적한 완성 정본)을 채택 — 라이브 첫 버킷은 마운트 직후 첫 틱을 o로
 * 잡는 부분봉이라 OHLC가 부정확하다. 백필은 완성된 과거 분만 담으므로, forming·백필보다 최신인
 * 라이브 완성봉은 애초에 겹치지 않아 그대로 보존된다(=백필을 나중에 set해 충돌만 덮는다).
 */
function mergeCandles(backfill: IntradayCandle[], live: IntradayCandle[]): IntradayCandle[] {
  const byTime = new Map<number, IntradayCandle>();
  for (const c of live) byTime.set(c.time, c);
  for (const c of backfill) byTime.set(c.time, c); // 백필을 마지막에 써 충돌 분을 정본으로 덮음
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** SSE 최신 틱(ts·price)을 라인 시리즈로 누적. lightweight-charts는 시간 오름차순·유일을 요구한다. */
function usePriceSeries(ts: number | undefined, price: number | undefined): LineData<Time>[] {
  const [series, setSeries] = useState<LineData<Time>[]>([]);
  useEffect(() => {
    if (ts == null || price == null) return;
    const time = Math.floor(ts / 1000) as UTCTimestamp; // ms→s (UTCTimestamp는 초 단위)
    setSeries((prev) => {
      const last = prev[prev.length - 1];
      if (last && (last.time as number) === time) {
        // 같은 초 내 갱신 → 마지막 점 값만 교체(유일 시간 유지).
        return [...prev.slice(0, -1), { time, value: price }];
      }
      if (last && (last.time as number) > time) return prev; // 역행 틱 무시.
      const next = [...prev, { time, value: price }];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });
  }, [ts, price]);
  return series;
}

export function StockDetail({ entry }: { entry: UniverseEntry }) {
  const quotes = usePrices([{ market: entry.market, symbol: entry.symbol }]);
  const quote = quotes[keyOf(entry.market, entry.symbol)];
  const series = usePriceSeries(quote?.ts, quote?.price);
  const liveCandles = useCandles(entry.market, entry.symbol, quote?.ts, quote?.price);

  const [tf, setTf] = useState<Timeframe>("line");

  // 1분 토글 최초 진입 시 /api/candles 백필 1회. 비어도(day1) 라이브만으로 정상 동작.
  const [backfill, setBackfill] = useState<IntradayCandle[]>([]);
  const [backfillLoaded, setBackfillLoaded] = useState(false);
  useEffect(() => {
    if (tf !== "1m" || backfillLoaded) return;
    let alive = true;
    fetch(`/api/candles?market=${entry.market}&symbol=${encodeURIComponent(entry.symbol)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        if (alive) {
          setBackfill(Array.isArray(data) ? (data as IntradayCandle[]) : []);
          setBackfillLoaded(true);
        }
      })
      .catch(() => alive && setBackfillLoaded(true));
    return () => {
      alive = false;
    };
  }, [tf, backfillLoaded, entry.market, entry.symbol]);

  // 병합 후 lightweight-charts CandlestickData(open/high/low/close, time=초)로 매핑.
  const candles = useMemo<CandlestickData<Time>[]>(
    () =>
      mergeCandles(backfill, liveCandles).map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    [backfill, liveCandles],
  );

  const price = quote?.price ?? entry.seedPrice;
  const change = quote?.change ?? 0;
  const pct = quote?.changePct ?? 0;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight">{entry.name}</h1>
          <p className="text-sm text-muted-foreground">
            {entry.symbol} · {entry.market === "KR" ? "KOSPI" : "US"}
          </p>
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className="text-2xl font-bold">{formatPrice(price, entry.currency)}</div>
          <PriceText
            change={change}
            pct={pct}
            currency={entry.currency}
            className="text-sm font-medium"
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="rounded-2xl border bg-card p-4">
          <div className="mb-3 inline-flex rounded-lg bg-muted p-1">
            {(["line", "1m"] as Timeframe[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTf(t)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-semibold transition",
                  tf === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t === "line" ? "라인" : "1분"}
              </button>
            ))}
          </div>

          {tf === "line" ? (
            series.length > 0 ? (
              <PriceChart symbol={entry.symbol} type="line" data={series} height={CHART_HEIGHT} />
            ) : (
              <div
                className="flex items-center justify-center text-sm text-muted-foreground"
                style={{ height: CHART_HEIGHT }}
              >
                실시간 시세를 불러오는 중입니다…
              </div>
            )
          ) : candles.length > 0 ? (
            <PriceChart
              key="1m"
              symbol={entry.symbol}
              type="candlestick"
              data={candles}
              height={CHART_HEIGHT}
            />
          ) : (
            <div
              className="flex items-center justify-center text-sm text-muted-foreground"
              style={{ height: CHART_HEIGHT }}
            >
              실시간 분봉을 집계 중입니다…
            </div>
          )}
        </div>
        <OrderPanel entry={entry} price={price} />
      </div>
    </main>
  );
}
