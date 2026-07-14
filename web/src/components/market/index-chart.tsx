"use client";

// 홈 지수 라인차트 — KIS 국내업종 일봉(/api/index-candles)을 종가 라인(AreaSeries)으로 그린다.
// 색: 기간 등락(첫→마지막 종가) 기준 상승 빨강/하락 파랑(PRICE_COLORS). 축·격자색은 CSS 토큰을
// canvas 왕복으로 정규화(oklch→lab ColorParser 크래시 회피 — PriceChart와 동일 기법).
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  ColorType,
  AreaSeries,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { PRICE_COLORS, type DailyCandle, type Market } from "@mockstock/shared";
import { cn } from "@/lib/utils";

/** CSS 색 → lightweight-charts가 아는 hex/rgb(canvas 재직렬화). 실패 시 undefined. */
function toChartColor(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = raw;
    const v = String(ctx.fillStyle);
    return v.startsWith("#") || v.startsWith("rgb") ? v : undefined;
  } catch {
    return undefined;
  }
}

/** #hex 또는 rgb(...) → 저알파 rgba. */
function toRgba(color: string, alpha: number): string {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return color;
}

const CANDLES_ENDPOINT = "/api/index-candles";

export function IndexChart({
  market,
  indexKey,
  label,
  height = 260,
}: {
  market: Market;
  indexKey: string;
  label: string;
  height?: number;
}) {
  const { data, status } = useQuery({
    queryKey: ["index-candles", market, indexKey],
    queryFn: async ({ signal }): Promise<DailyCandle[]> => {
      const res = await fetch(`${CANDLES_ENDPOINT}?market=${market}&key=${indexKey}`, { signal });
      if (!res.ok) throw new Error("지수 차트를 불러오지 못했습니다");
      return res.json();
    },
    staleTime: 5 * 60_000, // 일봉 — 5분 신선.
  });

  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !data || data.length < 2) return;

    const cs = getComputedStyle(el);
    const axisColor =
      toChartColor(cs.color) ??
      toChartColor(cs.getPropertyValue("--color-brand").trim()) ??
      PRICE_COLORS.up;
    const gridColor = toRgba(axisColor, 0.08);

    // 기간 등락 방향(첫→마지막 종가) → 라인 색. 한국 관례: 상승 빨강/하락 파랑.
    const up = data[data.length - 1].c >= data[0].c;
    const line = up ? PRICE_COLORS.up : PRICE_COLORS.down;

    let chart: ReturnType<typeof createChart> | null = null;
    try {
      chart = createChart(el, {
        autoSize: true,
        height,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: axisColor,
          attributionLogo: false,
        },
        grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false },
        localization: {
          locale: "ko-KR",
          priceFormatter: (p: number) =>
            p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        },
      });
      const series: ISeriesApi<"Area"> = chart.addSeries(AreaSeries, {
        lineColor: line,
        topColor: toRgba(line, 0.28),
        bottomColor: toRgba(line, 0.02),
        lineWidth: 2,
        priceLineVisible: false,
      });
      series.setData(data.map((c) => ({ time: c.date as Time, value: c.c })));
      chart.timeScale().fitContent();
    } catch {
      // 색 파싱 등 예외는 차트만 생략(페이지는 유지).
      chart?.remove();
      return;
    }
    return () => chart?.remove();
  }, [data, height]);

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="mb-2 text-sm font-medium text-muted-foreground">{label} · 최근 지수 추이(일봉)</div>
      {status === "pending" ? (
        <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
          불러오는 중…
        </div>
      ) : !data || data.length < 2 ? (
        <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
          지수 데이터를 불러오지 못했어요.
        </div>
      ) : (
        <div ref={elRef} className={cn("w-full")} style={{ height }} />
      )}
    </div>
  );
}
