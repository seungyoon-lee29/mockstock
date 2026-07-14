"use client";

// 호가창(depth ladder) — 매도호가(위, 파랑) · 현재가 구분선 · 매수호가(아래, 빨강).
// HTS 관례: 매도호가는 최우선(최저가)이 중앙(구분선)에 가장 가깝게, 매수호가는 최우선(최고가)이
// 구분선 바로 아래. 각 행에 잔량 비례 막대(우측 정박) + 우측정렬 tabular-nums 수량. 표시 전용.
import { PRICE_COLORS, type Currency, type Market, type OrderbookLevel } from "@mockstock/shared";
import { useOrderbook } from "@/lib/market/useOrderbook";
import { formatPrice } from "@/lib/market/format";
import { cn } from "@/lib/utils";

// 잔량 막대색 — PRICE_COLORS(상승 빨강/하락 파랑)에 알파 접미사(8자리 hex)로 저투명(리터럴 색 금지).
const BAR_ALPHA = "26"; // ~15% (0x26/0xff)
const ASK_BAR = PRICE_COLORS.down + BAR_ALPHA; // 매도 = 파랑
const BID_BAR = PRICE_COLORS.up + BAR_ALPHA; // 매수 = 빨강

/** 호가 한 행 — 우측 정박 잔량 막대 뒤로 가격+수량. side로 색·정렬 분기. */
function Row({
  level,
  side,
  maxQty,
  currency,
}: {
  level: OrderbookLevel;
  side: "ask" | "bid";
  maxQty: number;
  currency: Currency;
}) {
  const pct = maxQty > 0 ? (level.qty / maxQty) * 100 : 0;
  return (
    <div className="relative flex items-center justify-between px-2 py-0.5 text-xs tabular-nums">
      <div
        className="absolute inset-y-0 right-0 rounded-sm"
        style={{ width: `${pct}%`, backgroundColor: side === "ask" ? ASK_BAR : BID_BAR }}
      />
      <span className={cn("relative font-medium", side === "ask" ? "text-down" : "text-up")}>
        {formatPrice(level.price, currency)}
      </span>
      <span className="relative text-muted-foreground">{level.qty.toLocaleString("ko-KR")}</span>
    </div>
  );
}

export function OrderBook({
  market,
  symbol,
  currency,
}: {
  market: Market;
  symbol: string;
  currency: Currency;
}) {
  const ob = useOrderbook(market, symbol);
  const asks = ob?.asks ?? [];
  const bids = ob?.bids ?? [];
  const empty = asks.length === 0 && bids.length === 0;
  const maxQty = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));

  return (
    <div className="rounded-2xl border bg-card p-3">
      <h2 className="mb-2 px-1 text-sm font-semibold">호가</h2>
      {empty ? (
        // 높이 안정화 — 로딩·빈 상태에서도 패널이 뛰지 않게 최소 높이 유지.
        <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
          호가 대기 중
        </div>
      ) : (
        <div>
          {/* 매도호가: 최고가(레벨10)가 맨 위, 최우선(레벨1)이 구분선 바로 위 → 역순 렌더. */}
          {[...asks].reverse().map((l, i) => (
            <Row key={`ask-${i}`} level={l} side="ask" maxQty={maxQty} currency={currency} />
          ))}
          <div className="my-1 border-t" />
          {/* 매수호가: 최우선(최고가)이 구분선 바로 아래, 아래로 갈수록 낮아짐. */}
          {bids.map((l, i) => (
            <Row key={`bid-${i}`} level={l} side="bid" maxQty={maxQty} currency={currency} />
          ))}
        </div>
      )}
    </div>
  );
}
