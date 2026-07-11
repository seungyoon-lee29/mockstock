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

/**
 * CSS가 준 색을 lightweight-charts ColorParser가 아는 hex/rgb로 정규화한다.
 * globals.css 의 oklch 토큰을 Chromium이 `lab(...)`으로 직렬화해 ColorParser가 throw →
 * 종목상세·리플레이 페이지 전체 크래시(a0 진단 §1). canvas 2d fillStyle 왕복으로
 * 브라우저가 sRGB hex/rgba 로 재직렬화한 값을 쓴다. 실패하면 undefined — 호출부가
 * 라이브러리 기본색으로 폴백한다(색이 이상해도 페이지는 살아야 한다).
 */
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
    // getComputedStyle 색은 rgb 보장이 없다(oklch→lab 직렬화) — 반드시 정규화 후 전달.
    const axisColor = toChartColor(cs.color);
    const lineColor =
      toChartColor(cs.getPropertyValue("--color-brand").trim()) ?? PRICE_COLORS.up;

    // 차트 내부 예외(색 파싱 등)가 useEffect 밖으로 새면 React가 트리 전체를 언마운트한다 —
    // 차트만 생략하고 페이지는 살린다(a0 §1).
    let chart: ReturnType<typeof createChart> | null = null;
    try {
      chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          ...(axisColor ? { textColor: axisColor } : {}),
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
    } catch (err) {
      console.error("[PriceChart] 차트 생성 실패 — 차트만 생략:", err);
      try {
        chart?.remove();
      } catch {
        // 반쯤 만들어진 차트의 remove 실패까지 페이지를 죽이게 두지 않는다.
      }
      chart = null;
      seriesRef.current = null;
    }

    return () => {
      chart?.remove();
      seriesRef.current = null;
    };
    // data는 아래 별도 effect가 setData로 갱신 → 데이터 변경 시 차트 재생성 안 함(리플레이 스트리밍 대비).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // 데이터 주입 갱신. 시리즈 union 때문에 setData 인자는 never 캐스팅(런타임은 필드만 읽어 안전).
  useEffect(() => {
    try {
      seriesRef.current?.setData(data as never);
    } catch (err) {
      console.error("[PriceChart] 데이터 반영 실패 — 이번 갱신만 생략:", err);
    }
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
