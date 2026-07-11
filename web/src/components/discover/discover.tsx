"use client";

// 탐색 — 검색을 흡수한 발견 화면(D3·D4).
// 쿼리 없음: 당일 체결 건수 인기 순위(/api/discover/popular)로 현재 리그 종목 정렬,
//            집계 0건이면 등락률 내림차순 폴백. 1..N 순위 뱃지(상위 3 강조).
// 쿼리 있음: shared searchUniverse — 전 시장 결과, 순위 없음.
// 리그 전환은 헤더 스위처(리그 안에서는 그 시장만 — 스펙 §디스커버).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UNIVERSE, searchUniverse, keyOf, type Market } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import { QuoteCard } from "@/components/market/quote-card";
import { Input } from "@/components/ui/input";

const POPULAR_ENDPOINT = "/api/discover/popular";

// /api/discover/popular 응답 계약 미러 (라우트 파일은 서버 전용이라 타입 임포트 금지).
interface PopularItem {
  symbol: string;
  market: Market;
  fillCount: number;
}
interface PopularResponse {
  items: PopularItem[];
  empty: boolean;
}

export function Discover({ market }: { market: Market }) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const league = market === "US" ? "us" : "kr";

  const leagueEntries = useMemo(
    () => UNIVERSE.filter((e) => e.market === market),
    [market],
  );
  // 쿼리 있으면 전 시장 검색 결과, 없으면 현재 리그 전 종목.
  const searchEntries = useMemo(() => (q ? searchUniverse(q) : []), [q]);
  const entries = q ? searchEntries : leagueEntries;
  const quotes = usePrices(entries);

  const { data: popular } = useQuery({
    queryKey: ["discover-popular", league],
    queryFn: async ({ signal }): Promise<PopularResponse> => {
      const res = await fetch(`${POPULAR_ENDPOINT}?league=${league}`, { signal });
      if (!res.ok) throw new Error("인기 순위를 불러오지 못했습니다");
      return res.json();
    },
  });

  // 인기 순위: 당일 체결 건수 순 → 집계에 없는(미체결) 종목은 등락률 내림차순으로 뒤에.
  // 집계 0건·로딩·실패면 전체가 등락률 폴백이 된다.
  const ranked = useMemo(() => {
    const rankOf = new Map<string, number>();
    if (popular && !popular.empty) {
      popular.items.forEach((it, i) => rankOf.set(keyOf(it.market, it.symbol), i));
    }
    const pctOf = (e: (typeof leagueEntries)[number]) =>
      quotes[keyOf(e.market, e.symbol)]?.changePct ?? 0;
    return [...leagueEntries].sort((a, b) => {
      const ra = rankOf.get(keyOf(a.market, a.symbol)) ?? Infinity;
      const rb = rankOf.get(keyOf(b.market, b.symbol)) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return pctOf(b) - pctOf(a);
    });
  }, [leagueEntries, popular, quotes]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">탐색</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        오늘의 인기 종목을 둘러보고, 종목명·티커로 검색해 바로 투자해보세요
      </p>

      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="종목명 또는 티커 (예: 삼성전자, AAPL)"
        aria-label="종목 검색"
        className="mb-5 h-10"
      />

      {q ? (
        searchEntries.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            &lsquo;{q}&rsquo;에 해당하는 종목이 없습니다
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {searchEntries.map((e) => (
              <QuoteCard
                key={keyOf(e.market, e.symbol)}
                entry={e}
                quote={quotes[keyOf(e.market, e.symbol)]}
              />
            ))}
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ranked.map((e, i) => (
            <QuoteCard
              key={keyOf(e.market, e.symbol)}
              entry={e}
              quote={quotes[keyOf(e.market, e.symbol)]}
              rank={i + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
