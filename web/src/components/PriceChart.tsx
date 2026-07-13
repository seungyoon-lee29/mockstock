"use client";

// 리플레이·종목상세 공용 가격 차트 래퍼(lightweight-charts v5). 데이터 주입형 — fetch 안 함.
// 색은 PRICE_COLORS(상승 빨강/하락 파랑)와 --color-brand(시안) 토큰만 경유(색상 리터럴 금지).
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  TickMarkType,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  PRICE_COLORS,
  TF_MINUTES,
  type ChartTimeframe,
  type Currency,
  type Market,
} from "@mockstock/shared";
import { formatMarketDate, formatMarketTime } from "@/lib/market/candleServe";
import { formatPrice } from "@/lib/market/format";
import { cn } from "@/lib/utils";

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

/**
 * 정규화된 색(toChartColor 결과: #hex 또는 rgb(...))을 저알파 rgba 문자열로.
 * canvas가 준 값만 받으므로 파싱 실패는 없다 — 그래도 못 뽑으면 원색 그대로 반환.
 */
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

type PriceChartProps = {
  /** 접근성 라벨용 심볼. 데이터는 props로만 주입한다. */
  symbol?: string;
  data: CandlestickData<Time>[];
  /**
   * 거래량 오버레이 히스토그램 데이터. 미지정/빈 배열이면 거래량 시리즈를 아예 만들지 않는다
   * (리플레이 등 미전달 호출부 무영향). time은 data와 같은 축·색은 캔들 방향(상승 빨강/하락 파랑).
   */
  volumes?: HistogramData<Time>[];
  /** 타임프레임 — 분봉 tf면 x축에 시각(HH:mm) 표시. 미지정 시 기존 동작(날짜만). */
  timeframe?: ChartTimeframe;
  /** 시장 — 분봉 x축·크로스헤어를 시장 tz(KST/ET)로 표기. 미지정 시 라이브러리 기본(UTC). */
  market?: Market;
  /** 지정 시 y축 가격 라벨을 통화 포맷(KRW 정수·USD 2자리, format.ts)으로 표기. */
  currency?: Currency;
  /** 차트 높이(px). */
  height?: number;
  className?: string;
};

// 이 봉수 이상 한꺼번에 늘면(=뒤늦은 백필 도착) 보이는 범위를 재적합. +1(분봉 롤오버·리플레이
// 커서 한 스텝)은 사용자 줌/팬을 뺏지 않도록 재적합 안 함. 최초 0→N(리플레이 마운트)도 대점프라 1회 적합.
const BACKFILL_FIT_JUMP = 10;

// OHLC 레전드 한 줄 상태(크로스헤어 바 or 마지막 바). currency 있으면 formatPrice, 없으면 원값.
type Ohlc = { open: number; high: number; low: number; close: number };

export function PriceChart({
  symbol,
  data,
  volumes,
  timeframe,
  market,
  currency,
  height = 320,
  className,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const barCountRef = useRef(0); // 마지막 fitContent 시점의 바 수 — 바 수 증가(백필 도착·롤오버)에만 재적합.
  const [legend, setLegend] = useState<Ohlc | null>(null);

  // 분봉↔일봉 카테고리 — Time 타입(UTCTimestamp vs "YYYY-MM-DD" 문자열)이 한 시리즈에 섞이면
  // lightweight-charts가 throw한다. 카테고리 전환 시 차트·시리즈를 재생성한다(생성 effect deps).
  const isMinute = timeframe != null && timeframe in TF_MINUTES;
  // 거래량 시리즈 유무만 재생성 트리거로 — 값 변화는 update effect가 처리(리플레이 무영향).
  const hasVolume = (volumes?.length ?? 0) > 0;

  // 차트 + 시리즈 생성/파기. 타입·tf 카테고리·통화 변경 시에만 재생성. 앱은 다크 고정이라 테마 런타임 반응 생략.
  // ponytail: 라이트/다크 토글이 생기면 테마를 deps에 추가.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const cs = getComputedStyle(el);
    // getComputedStyle 색은 rgb 보장이 없다(oklch→lab 직렬화) — 반드시 정규화 후 전달.
    // 축 텍스트: 컨테이너 currentColor(text-foreground 토큰) → 브랜드 토큰 → PRICE_COLORS.up.
    // 라이브러리 기본 textColor(#191919)는 다크 배경에서 안 보인다 — 폴백까지 항상 명시 지정.
    const axisColor =
      toChartColor(cs.color) ??
      toChartColor(cs.getPropertyValue("--color-brand").trim()) ??
      PRICE_COLORS.up;

    // 그리드: axisColor(정규화된 hex/rgb)를 저알파 rgba로 — TradingView식 은은한 격자.
    // toChartColor가 준 rgb(...)면 rgba로, #hex면 canvas가 rgb로 재직렬화하므로 폴백은 skip.
    const gridColor = toRgba(axisColor, 0.08);

    // 차트 내부 예외(색 파싱 등)가 useEffect 밖으로 새면 React가 트리 전체를 언마운트한다 —
    // 차트만 생략하고 페이지는 살린다(a0 §1).
    let chart: ReturnType<typeof createChart> | null = null;
    try {
      chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: axisColor,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: gridColor },
          horzLines: { color: gridColor },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: {
          borderVisible: false,
          timeVisible: isMinute,
          secondsVisible: false,
          // 분봉 눈금은 시장 tz로 — 라이브러리는 tz 미지원이라 UTCTimestamp를 UTC로 찍는다(버그 원인).
          // 시각 눈금은 HH:mm, 날짜 경계(Year/Month/DayOfMonth) 눈금은 시장 로컬 날짜.
          ...(isMinute && market
            ? {
                tickMarkFormatter: (time: Time, mark: TickMarkType) =>
                  mark === TickMarkType.Time || mark === TickMarkType.TimeWithSeconds
                    ? formatMarketTime(market, Number(time))
                    : formatMarketDate(market, Number(time)),
              }
            : {}),
        },
        localization: {
          locale: "ko-KR",
          // 통화 미지정이면 라이브러리 기본 포맷(기존 동작) 유지.
          ...(currency ? { priceFormatter: (p: number) => formatPrice(p, currency) } : {}),
          // 크로스헤어 툴팁도 시장 tz(날짜+시각) — 일·주·월은 date 문자열이라 기존 동작 유지.
          ...(isMinute && market
            ? {
                timeFormatter: (t: Time) =>
                  `${formatMarketDate(market, Number(t))} ${formatMarketTime(market, Number(t))}`,
              }
            : {}),
        },
      });

      const s = chart.addSeries(CandlestickSeries, {
        upColor: PRICE_COLORS.up,
        downColor: PRICE_COLORS.down,
        borderUpColor: PRICE_COLORS.up,
        borderDownColor: PRICE_COLORS.down,
        wickUpColor: PRICE_COLORS.up,
        wickDownColor: PRICE_COLORS.down,
      });
      s.setData(data);
      seriesRef.current = s;

      // 거래량 오버레이 — 자체 price scale(priceScaleId: "")에 하단 20%로 고정(scaleMargins).
      // volumes 미전달/빈 배열이면 시리즈를 만들지 않는다(리플레이 등 무영향).
      // ponytail: 라이브 분봉의 v는 tick 카운트(실거래량 아님) — 일·주·월봉 v만 KIS/Alpaca 실거래량.
      if (volumes && volumes.length > 0) {
        const vs = chart.addSeries(HistogramSeries, {
          priceScaleId: "",
          priceFormat: { type: "volume" },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        vs.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        vs.setData(volumes);
        volumeRef.current = vs;
      }

      // OHLC 레전드: 크로스헤어가 바 위면 그 바를 상태로. 벗어나면 null → 렌더에서 마지막 바로 폴백
      // (마지막 바 폴백을 렌더 파생값으로 두면 effect 안 동기 setState가 없어져 cascading render 회피).
      const onMove = (param: MouseEventParams<Time>) => {
        const bar = param.seriesData.get(s) as CandlestickData<Time> | undefined;
        setLegend(
          bar ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close } : null,
        );
      };
      // chart.remove()가 구독까지 정리하므로 별도 unsubscribe 불필요(cleanup의 chart?.remove()).
      chart.subscribeCrosshairMove(onMove);

      chart.timeScale().fitContent();
      chartRef.current = chart;
      barCountRef.current = data.length;
    } catch (err) {
      console.error("[PriceChart] 차트 생성 실패 — 차트만 생략:", err);
      try {
        chart?.remove();
      } catch {
        // 반쯤 만들어진 차트의 remove 실패까지 페이지를 죽이게 두지 않는다.
      }
      chart = null;
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    }

    return () => {
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
    // data/volumes는 아래 별도 effect가 setData로 갱신 → 데이터 변경 시 차트 재생성 안 함(리플레이 스트리밍 대비).
    // isMinute(tf 카테고리)는 deps 필수 — 분↔일 전환 시 재생성해야 Time 타입이 안 섞인다.
    // hasVolume은 거래량 시리즈 유무가 바뀔 때만 재생성(데이터 값 변화는 update effect가 처리).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMinute, currency, market, hasVolume]);

  // 데이터 주입 갱신(캔들+거래량). 차트 재생성 없이 setData만 — 리플레이 스트리밍 대비.
  useEffect(() => {
    try {
      seriesRef.current?.setData(data);
      if (volumes && volumes.length > 0) volumeRef.current?.setData(volumes);
      // 바 수가 크게 늘면(=뒤늦은 백필 도착, +~200) 보이는 범위를 재적합 — setData는 뷰를 안 넓힌다.
      // 초기 fitContent가 라이브 2봉에만 맞춰진 뒤 240봉 백필이 도착하면 차트가 2봉에 갇히던 버그(a1).
      // +1(분봉 롤오버·리플레이 커서 스텝)은 재적합 안 함 — 사용자 줌/팬·리플레이 재생을 매 스텝 뺏지 않도록.
      if (chartRef.current && data.length - barCountRef.current >= BACKFILL_FIT_JUMP) {
        chartRef.current.timeScale().fitContent();
      }
      barCountRef.current = data.length;
    } catch (err) {
      console.error("[PriceChart] 데이터 반영 실패 — 이번 갱신만 생략:", err);
    }
  }, [data, volumes]);

  // 표시 바: 크로스헤어 바(legend) 없으면 마지막 바로 폴백(effect 밖 렌더 파생 — 동기 setState 회피).
  const lastBar = data.length ? data[data.length - 1] : null;
  const bar: Ohlc | null =
    legend ??
    (lastBar
      ? { open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close }
      : null);
  // 상승/하락 색: 종가≥시가면 up(빨강), 아니면 down(파랑). PRICE_COLORS만 사용(리터럴 금지).
  const legendColor = bar && bar.close >= bar.open ? PRICE_COLORS.up : PRICE_COLORS.down;
  const fmt = (v: number) => (currency ? formatPrice(v, currency) : String(v));

  // text-foreground: 축 텍스트 색의 원천(currentColor) — muted는 다크에서 저대비.
  // relative 래퍼: OHLC 레전드를 차트 위에 절대배치. 차트 컨테이너는 래퍼를 꽉 채워 autoSize 유지.
  return (
    <div className={cn("relative w-full text-foreground", className)} style={{ height }}>
      <div
        ref={containerRef}
        role="img"
        aria-label={symbol ? `${symbol} 가격 차트` : "가격 차트"}
        className="h-full w-full"
      />
      {bar && (
        // pointer-events-none: 크로스헤어 이벤트를 먹지 않도록. 라벨(시/고/저/종)은 한국어.
        <div className="pointer-events-none absolute left-2 top-2 flex gap-x-3 text-xs tabular-nums">
          {(
            [
              ["시", bar.open],
              ["고", bar.high],
              ["저", bar.low],
              ["종", bar.close],
            ] as const
          ).map(([label, value]) => (
            <span key={label}>
              <span className="text-muted-foreground">{label} </span>
              <span style={{ color: legendColor }}>{fmt(value)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
