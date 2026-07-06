"use client";

// 종목 상세: 현재가·등락 + SSE 틱 누적 라인 차트 + 주문 패널. 과거 캔들 API는 없어 실시간 틱만 그린다.
import { useEffect, useState } from "react";
import type { LineData, Time, UTCTimestamp } from "lightweight-charts";
import { keyOf, type UniverseEntry } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import { PriceChart } from "@/components/PriceChart";
import { PriceText } from "@/components/PriceText";
import { formatPrice } from "@/lib/market/format";
import { OrderPanel } from "./order-panel";

const MAX_POINTS = 300; // ponytail: 최근 N틱만 유지 — 세션 길어져도 메모리·렌더 상한 고정.

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
          {series.length > 0 ? (
            <PriceChart symbol={entry.symbol} type="line" data={series} height={360} />
          ) : (
            <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">
              실시간 시세를 불러오는 중입니다…
            </div>
          )}
        </div>
        <OrderPanel entry={entry} price={price} />
      </div>
    </main>
  );
}
