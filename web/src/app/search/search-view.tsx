"use client";

import { useMemo, useState } from "react";
import { searchUniverse, keyOf } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import { QuoteCard } from "@/components/market/quote-card";
import { Input } from "@/components/ui/input";

export function SearchView() {
  const [query, setQuery] = useState("");

  // 빈 쿼리는 searchUniverse가 상위 종목을 돌려줌 → 진입 시 둘러보기 가능.
  const entries = useMemo(() => searchUniverse(query), [query]);
  const quotes = usePrices(entries);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">검색</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        종목명 또는 티커로 검색해 바로 매매 화면으로 이동하세요
      </p>

      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="종목명 또는 티커 (예: 삼성전자, AAPL)"
        aria-label="종목 검색"
        autoFocus
        className="mb-5 h-10"
      />

      {entries.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          &lsquo;{query}&rsquo;에 해당하는 종목이 없습니다
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((e) => (
            <QuoteCard
              key={keyOf(e.market, e.symbol)}
              entry={e}
              quote={quotes[keyOf(e.market, e.symbol)]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
