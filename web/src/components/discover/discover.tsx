"use client";

import { useMemo } from "react";
import { UNIVERSE, keyOf, type Market } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import { QuoteCard } from "@/components/market/quote-card";

// 리그 토글 제거 — 리그 안에서는 그 시장만(스펙 §디스커버). 리그 전환은 헤더 스위처.
export function Discover({ market }: { market: Market }) {
  const entries = useMemo(
    () => UNIVERSE.filter((e) => e.market === market),
    [market],
  );

  const quotes = usePrices(entries);

  // 실시간 등락률 상위 정렬
  const sorted = useMemo(() => {
    return [...entries].sort((a, b) => {
      const pa = quotes[keyOf(a.market, a.symbol)]?.changePct ?? 0;
      const pb = quotes[keyOf(b.market, b.symbol)]?.changePct ?? 0;
      return pb - pa;
    });
  }, [entries, quotes]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">발견</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        실시간 인기 종목을 둘러보고 가상 현금으로 투자해보세요
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((e) => (
          <QuoteCard
            key={keyOf(e.market, e.symbol)}
            entry={e}
            quote={quotes[keyOf(e.market, e.symbol)]}
          />
        ))}
      </div>
    </div>
  );
}
