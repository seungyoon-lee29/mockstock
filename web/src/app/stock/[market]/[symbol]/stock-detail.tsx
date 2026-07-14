"use client";

// 종목 상세: 현재가·등락 + 캔들 차트 + 주문 패널.
// 토글: 분▾(1·5·10·15·30·60분봉) · 일 · 주 · 월 — 캔들은 useCandles(tf)가
// 백필+라이브 병합까지 담당(계약: 분봉=IntradayCandle[](time=초), 일·주·월=DailyCandle[](date 문자열)).
import { useMemo, useState } from "react";
import type { CandlestickData, HistogramData, Time, UTCTimestamp } from "lightweight-charts";
import {
  keyOf,
  PRICE_COLORS,
  TF_MINUTES,
  type ChartTimeframe,
  type UniverseEntry,
} from "@mockstock/shared";
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
import { OrderBook } from "@/components/market/order-book";
import { OrderPanel } from "./order-panel";

const CHART_HEIGHT = 360;

// 거래량 막대색 — PRICE_COLORS(상승 빨강/하락 파랑)에 알파 접미사(8자리 hex)로 저투명.
// 캔들 위 오버레이라 반투명해야 가독성 유지. 리터럴 색 금지 규칙: 단일 소스 hex에서 파생.
const VOLUME_ALPHA = "59"; // ~35% (0x59/0xff)
const VOLUME_UP = PRICE_COLORS.up + VOLUME_ALPHA;
const VOLUME_DOWN = PRICE_COLORS.down + VOLUME_ALPHA;

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

export function StockDetail({ entry }: { entry: UniverseEntry }) {
  const quotes = usePrices([{ market: entry.market, symbol: entry.symbol }]);
  const quote = quotes[keyOf(entry.market, entry.symbol)];

  const [tf, setTf] = useState<ChartTimeframe>("1m");
  const isMinute = tf in TF_MINUTES;

  const raw = useCandles(entry.market, entry.symbol, tf);

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

  // 거래량 오버레이 — 캔들과 같은 time 축, 색은 방향(상승 빨강/하락 파랑) + 저알파로 캔들 가독성 유지.
  // ponytail: 라이브 분봉의 v는 tick 카운트(실거래량 아님) — 일·주·월봉 v만 KIS/Alpaca 실거래량.
  const volumes = useMemo<HistogramData<Time>[]>(
    () =>
      raw.map((c) => ({
        time: ("date" in c ? c.date : c.time) as Time,
        value: c.v,
        color: c.c >= c.o ? VOLUME_UP : VOLUME_DOWN,
      })),
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

          {candles.length > 0 ? (
            <PriceChart
              symbol={entry.symbol}
              data={candles}
              volumes={volumes}
              timeframe={tf}
              market={entry.market}
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
        <div className="flex flex-col gap-6">
          <OrderPanel entry={entry} price={price} />
          <OrderBook market={entry.market} symbol={entry.symbol} currency={entry.currency} />
        </div>
      </div>
    </main>
  );
}
