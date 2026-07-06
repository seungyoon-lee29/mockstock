"use client";

// 리플레이·종목상세 공용 가격 차트 래퍼(lightweight-charts v5). 데이터 주입형 — fetch 안 함.
// 색은 PRICE_COLORS(상승 빨강/하락 파랑)와 --color-brand(시안) 토큰만 경유(색상 리터럴 금지).
import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type Time,
} from "lightweight-charts";
import { PRICE_COLORS } from "@mockstock/shared";
import { cn } from "@/lib/utils";

export type PriceChartType = "candlestick" | "line";

type PriceChartProps = {
  /** 접근성 라벨용 심볼. 데이터는 props로만 주입한다. */
  symbol?: string;
  type?: PriceChartType;
  data: CandlestickData<Time>[] | LineData<Time>[];
  /** 차트 높이(px). */
  height?: number;
  className?: string;
};

export function PriceChart({
  symbol,
  type = "candlestick",
  data,
  height = 320,
  className,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<
    ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null
  >(null);

  // 차트 + 시리즈 생성/파기. 타입 변경 시에만 재생성. 앱은 다크 고정이라 테마 런타임 반응 생략.
  // ponytail: 라이트/다크 토글이 생기면 테마를 deps에 추가.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const cs = getComputedStyle(el);
    const axisColor = cs.color; // 상속 텍스트색이 rgb로 resolve → canvas 안전
    const lineColor = cs.getPropertyValue("--color-brand").trim() || PRICE_COLORS.up;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: axisColor,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });

    if (type === "line") {
      const s = chart.addSeries(LineSeries, { color: lineColor, lineWidth: 2 });
      s.setData(data as LineData<Time>[]);
      seriesRef.current = s;
    } else {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: PRICE_COLORS.up,
        downColor: PRICE_COLORS.down,
        borderUpColor: PRICE_COLORS.up,
        borderDownColor: PRICE_COLORS.down,
        wickUpColor: PRICE_COLORS.up,
        wickDownColor: PRICE_COLORS.down,
      });
      s.setData(data as CandlestickData<Time>[]);
      seriesRef.current = s;
    }
    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      seriesRef.current = null;
    };
    // data는 아래 별도 effect가 setData로 갱신 → 데이터 변경 시 차트 재생성 안 함(리플레이 스트리밍 대비).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // 데이터 주입 갱신. 시리즈 union 때문에 setData 인자는 never 캐스팅(런타임은 필드만 읽어 안전).
  useEffect(() => {
    seriesRef.current?.setData(data as never);
  }, [data]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={symbol ? `${symbol} 가격 차트` : "가격 차트"}
      style={{ height }}
      className={cn("w-full text-muted-foreground", className)}
    />
  );
}
