"use client";

import Link from "next/link";
import type { Quote, UniverseEntry } from "@mockstock/shared";
import {
  formatPrice,
  formatSignedPrice,
  formatPct,
  changeClass,
} from "@/lib/market/format";
import { cn } from "@/lib/utils";

export function QuoteCard({
  entry,
  quote,
}: {
  entry: UniverseEntry;
  quote?: Quote;
}) {
  const price = quote?.price ?? entry.seedPrice;
  const change = quote?.change ?? 0;
  const pct = quote?.changePct ?? 0;

  return (
    <Link
      href={`/stock/${entry.market}/${entry.symbol}`}
      className="flex items-center justify-between rounded-2xl border bg-card p-4 transition hover:border-foreground/20 hover:shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground">
          {entry.name.slice(0, 2)}
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold">{entry.name}</div>
          <div className="text-xs text-muted-foreground">
            {entry.symbol} · {entry.market === "KR" ? "KOSPI" : "US"}
          </div>
        </div>
      </div>
      <div className="text-right tabular-nums">
        <div className="font-semibold">{formatPrice(price, entry.currency)}</div>
        <div className={cn("text-xs font-medium", changeClass(change))}>
          {formatSignedPrice(change, entry.currency)} ({formatPct(pct)})
        </div>
      </div>
    </Link>
  );
}
