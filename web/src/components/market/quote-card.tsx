"use client";

import Link from "next/link";
import type { Quote, UniverseEntry } from "@mockstock/shared";
import {
  formatPrice,
  formatSignedPrice,
  formatPct,
  changeClass,
} from "@/lib/market/format";
import { SymbolAvatar } from "@/components/market/symbol-avatar";
import { cn } from "@/lib/utils";

/** 순위 뱃지 강조 상한 — 상위 3위는 브랜드색(리더보드 상위 강조와 동일 관례). */
const TOP_RANK_HIGHLIGHT = 3;

export function QuoteCard({
  entry,
  quote,
  rank,
}: {
  entry: UniverseEntry;
  quote?: Quote;
  /** 인기 순위(1..N). 없으면 뱃지 미표시(검색 결과 등). */
  rank?: number;
}) {
  return (
    <Link
      href={`/stock/${entry.market}/${entry.symbol}`}
      className="flex items-center justify-between rounded-2xl border bg-card p-4 transition hover:border-foreground/20 hover:shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        {rank != null && (
          <span
            className={cn(
              "w-6 shrink-0 text-center text-sm font-bold tabular-nums",
              rank <= TOP_RANK_HIGHLIGHT ? "text-brand" : "text-muted-foreground",
            )}
          >
            {rank}
          </span>
        )}
        <SymbolAvatar
          market={entry.market}
          symbol={entry.symbol}
          name={entry.name}
          size="lg"
        />
        <div className="min-w-0">
          <div className="truncate font-semibold">{entry.name}</div>
          <div className="text-xs text-muted-foreground">
            {entry.symbol} · {entry.market === "KR" ? "KOSPI" : "US"}
          </div>
        </div>
      </div>
      {/* 시세 미도착(quote 없음) 시 seedPrice 폴백 금지 — 대시로 대기 표시(D12f).
          정상 상태에선 baseline 시드(usePrices)가 quote를 항상 채운다. */}
      <div className="text-right tabular-nums">
        {quote ? (
          <>
            <div className="font-semibold">
              {formatPrice(quote.price, entry.currency)}
            </div>
            <div className={cn("text-xs font-medium", changeClass(quote.change))}>
              {formatSignedPrice(quote.change, entry.currency)} (
              {formatPct(quote.changePct)})
            </div>
          </>
        ) : (
          <>
            <div className="font-semibold text-muted-foreground">–</div>
            <div className="text-xs font-medium text-muted-foreground">–</div>
          </>
        )}
      </div>
    </Link>
  );
}
