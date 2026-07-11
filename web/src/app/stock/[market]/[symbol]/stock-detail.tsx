"use client";

// 종목 상세: 현재가·등락 + SSE 틱 차트 + 주문 패널.
// 토글: 라인(실시간 틱 누적) · 분▾(1·5·10·15·30·60분봉) · 일 · 주 · 월 — 캔들은 useCandles(tf)가
// 백필+라이브 병합까지 담당(계약: 분봉=IntradayCandle[](time=초), 일·주·월=DailyCandle[](date 문자열)).
import { useMemo, useState } from "react";
import type { CandlestickData, LineData, Time, UTCTimestamp } from "lightweight-charts";
import { keyOf, TF_MINUTES, type ChartTimeframe, type UniverseEntry } from "@mockstock/shared";
import { ChevronDownIcon } from "lucide-react";
import { usePrices } from "@/lib/market/usePrices";
import { useCandles } from "@/lib/market/useCandles";
import { PriceChart } from "@/components/PriceChart";
import { PriceText } from "@/components/PriceText";
import { SymbolAvatar } from "@/components/market/symbol-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatPrice } from "@/lib/market/format";
import { cn } from "@/lib/utils";
import { OrderPanel } from "./order-panel";

const MAX_POINTS = 300; // ponytail: 최근 N틱만 유지 — 세션 길어져도 메모리·렌더 상한 고정.

type Timeframe = "line" | ChartTimeframe;
const CHART_HEIGHT = 360;

// 분▾ 드롭다운 항목 — 라벨은 TF_MINUTES(단일 소스)에서 파생(매직 라벨 산재 금지).
type MinuteTf = keyof typeof TF_MINUTES;
const MINUTE_TFS = Object.keys(TF_MINUTES) as MinuteTf[];
const minuteLabel = (tf: MinuteTf) => `${TF_MINUTES[tf]}분`;

// 일·주·월 버튼(캔들 daily 카테고리).
const DAILY_TFS = [
  { id: "day", label: "일" },
  { id: "week", label: "주" },
  { id: "month", label: "월" },
] as const satisfies readonly { id: ChartTimeframe; label: string }[];

/** 토글 버튼 공용 스타일 — 드롭다운 트리거도 동일 룩. */
const tfButtonClass = (active: boolean) =>
  cn(
    "rounded-md px-3 py-1 text-sm font-semibold transition",
    active
      ? "bg-background text-foreground shadow-sm"
      : "text-muted-foreground hover:text-foreground",
  );

/** SSE 최신 틱(ts·price)을 라인 시리즈로 누적. lightweight-charts는 시간 오름차순·유일을 요구한다. */
function usePriceSeries(ts: number | undefined, price: number | undefined): LineData<Time>[] {
  const [series, setSeries] = useState<LineData<Time>[]>([]);
  // effect 내 setState(lint set-state-in-effect) 대신 렌더 중 상태 조정 패턴
  // (react.dev "adjusting state when a prop changes") — 직전 반영 틱과 다를 때만 누적.
  const [applied, setApplied] = useState<{ ts: number; price: number } | null>(null);
  if (ts != null && price != null && (applied?.ts !== ts || applied?.price !== price)) {
    setApplied({ ts, price });
    const time = Math.floor(ts / 1000) as UTCTimestamp; // ms→s (UTCTimestamp는 초 단위)
    const last = series[series.length - 1];
    if (last && (last.time as number) === time) {
      // 같은 초 내 갱신 → 마지막 점 값만 교체(유일 시간 유지).
      setSeries([...series.slice(0, -1), { time, value: price }]);
    } else if (!last || (last.time as number) < time) {
      // 역행 틱(last.time > time)은 무시.
      const next = [...series, { time, value: price }];
      setSeries(next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next);
    }
  }
  return series;
}

export function StockDetail({ entry }: { entry: UniverseEntry }) {
  const quotes = usePrices([{ market: entry.market, symbol: entry.symbol }]);
  const quote = quotes[keyOf(entry.market, entry.symbol)];
  const series = usePriceSeries(quote?.ts, quote?.price);

  const [tf, setTf] = useState<Timeframe>("line");
  const isMinute = tf !== "line" && tf in TF_MINUTES;

  // 훅 규칙상 항상 호출 — 라인 모드에서는 기본 tf(1m)로 대기(계약: 요청 tf로 응답 타입 분기).
  const chartTf: ChartTimeframe = tf === "line" ? "1m" : tf;
  const raw = useCandles(entry.market, entry.symbol, chartTf);

  // 계약 매핑: 분봉=time(epoch 초)→UTCTimestamp, 일·주·월=date("YYYY-MM-DD") 문자열 그대로
  // (lightweight-charts Time은 date 문자열 허용 — epoch 변환 금지, 스펙 확정).
  const candles = useMemo<CandlestickData<Time>[]>(
    () =>
      raw.map((c) =>
        "date" in c
          ? { time: c.date as Time, open: c.o, high: c.h, low: c.l, close: c.c }
          : { time: c.time as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c },
      ),
    [raw],
  );

  // D12f: seedPrice 폴백 제거 — quote 없으면 대시 표기(baseline 시드가 정상 상태를 보장).
  const price = quote?.price;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <SymbolAvatar market={entry.market} symbol={entry.symbol} name={entry.name} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">{entry.name}</h1>
            <p className="text-sm text-muted-foreground">
              {entry.symbol} · {entry.market === "KR" ? "KOSPI" : "US"}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className="text-2xl font-bold">
            {price != null ? formatPrice(price, entry.currency) : "—"}
          </div>
          {quote ? (
            <PriceText
              change={quote.change}
              pct={quote.changePct}
              currency={entry.currency}
              className="text-sm font-medium"
            />
          ) : (
            <div className="text-sm font-medium text-muted-foreground">시세 대기 중</div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="rounded-2xl border bg-card p-4">
          <div className="mb-3 inline-flex rounded-lg bg-muted p-1">
            <button type="button" onClick={() => setTf("line")} className={tfButtonClass(tf === "line")}>
              라인
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(tfButtonClass(isMinute), "inline-flex items-center gap-0.5")}
              >
                {isMinute ? minuteLabel(tf as MinuteTf) : "분"}
                <ChevronDownIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {MINUTE_TFS.map((m) => (
                  <DropdownMenuItem key={m} onSelect={() => setTf(m)}>
                    {minuteLabel(m)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {DAILY_TFS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTf(t.id)}
                className={tfButtonClass(tf === t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tf === "line" ? (
            series.length > 0 ? (
              <PriceChart
                symbol={entry.symbol}
                type="line"
                data={series}
                currency={entry.currency}
                height={CHART_HEIGHT}
              />
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
              symbol={entry.symbol}
              type="candlestick"
              data={candles}
              timeframe={tf}
              currency={entry.currency}
              height={CHART_HEIGHT}
            />
          ) : (
            <div
              className="flex items-center justify-center text-sm text-muted-foreground"
              style={{ height: CHART_HEIGHT }}
            >
              데이터 준비 중
            </div>
          )}
        </div>
        <OrderPanel entry={entry} price={price} />
      </div>
    </main>
  );
}
