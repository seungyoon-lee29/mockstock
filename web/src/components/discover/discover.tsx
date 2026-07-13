"use client";

// 탐색 — 검색을 흡수한 발견 화면(D3·D4).
// 쿼리 없음: 당일 체결 건수 인기 순위(/api/discover/popular)로 현재 리그 종목 정렬,
//            집계 0건이면 등락률 내림차순 폴백. 1..N 순위 뱃지(상위 3 강조).
// 쿼리 있음: shared searchUniverse — 전 시장 결과, 순위 없음.
// 리그 전환은 헤더 스위처(리그 안에서는 그 시장만 — 스펙 §디스커버).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UNIVERSE, searchUniverse, getEntry, keyOf, type Market } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import { rankOrder, RERANK_INTERVAL_MS } from "@/lib/market/discover-rank";
import type { BaselineMap } from "@/lib/market/baseline";
import { computeMarketCap, formatMarketCap } from "@/lib/market/format";
import { QuoteCard } from "@/components/market/quote-card";
import { Input } from "@/components/ui/input";

const POPULAR_ENDPOINT = "/api/discover/popular";
const BASELINE_ENDPOINT = "/api/quotes/baseline";

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

  // 라이브 시총용 상장주식수(sharesOutstanding). 정적 펀더멘털이라 틱과 분리 — 전 유니버스 맵.
  // 키리스 로컬·미적재면 shares null → 시총 "—". usePrices도 같은 엔드포인트를 쓰지만 노출을 안 해
  // 여기서 별도 조회(서버 30s 캐시가 중복 비용 흡수 — ponytail: 공유 훅 리팩터 생략).
  const { data: baseline } = useQuery({
    queryKey: ["baseline-caps"],
    queryFn: async ({ signal }): Promise<BaselineMap> => {
      const res = await fetch(BASELINE_ENDPOINT, { signal });
      if (!res.ok) throw new Error("기준선을 불러오지 못했습니다");
      return res.json();
    },
    staleTime: 30_000,
  });

  // 라이브 시총 문자열(표시 전용). shares 미상·가격 미도착이면 "—".
  const capOf = (e: (typeof entries)[number]): string => {
    const k = keyOf(e.market, e.symbol);
    const price = quotes[k]?.price ?? 0;
    return formatMarketCap(
      computeMarketCap(baseline?.[k]?.sharesOutstanding, price),
      e.currency,
    );
  };

  const { data: popular } = useQuery({
    queryKey: ["discover-popular", league],
    queryFn: async ({ signal }): Promise<PopularResponse> => {
      const res = await fetch(`${POPULAR_ENDPOINT}?league=${league}`, { signal });
      if (!res.ok) throw new Error("인기 순위를 불러오지 못했습니다");
      return res.json();
    },
  });

  const rankOf = useMemo(() => {
    const m = new Map<string, number>();
    if (popular && !popular.empty) {
      popular.items.forEach((it, i) => m.set(keyOf(it.market, it.symbol), i));
    }
    return m;
  }, [popular]);

  // 카드 순서(심볼 키 배열)는 state로 고정 — 매초 시세 틱에 재정렬되지 않게.
  // 최신 quotes/입력은 ref로 참조해 인터벌·재계산이 항상 현재 스냅샷으로 정렬하게 한다.
  const [order, setOrder] = useState<string[]>([]);
  const snap = useRef({ leagueEntries, rankOf, quotes });
  snap.current = { leagueEntries, rankOf, quotes };

  // 재계산 시점: 마운트·주기(RERANK_INTERVAL_MS)·popular 변경·리그(종목집합) 변경.
  // quotes(1초 틱)는 의존성에서 제외 — 재계산 시점에만 현재 스냅샷을 읽는다.
  useEffect(() => {
    const rerank = () => {
      const s = snap.current;
      setOrder(rankOrder(s.leagueEntries, s.rankOf, s.quotes));
    };
    rerank();
    const id = setInterval(rerank, RERANK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [leagueEntries, rankOf]);

  // 확정 순서로 엔트리 복원 + 아직 순서 배열에 없는 종목(레이스)은 뒤에 붙여 누락 방어.
  const ranked = useMemo(() => {
    const seen = new Set(order);
    const ordered = order
      .map((k) => getEntry(...(k.split(":") as [Market, string])))
      .filter((e): e is NonNullable<typeof e> => !!e && e.market === market);
    const missing = leagueEntries.filter(
      (e) => !seen.has(keyOf(e.market, e.symbol)),
    );
    return [...ordered, ...missing];
  }, [order, leagueEntries, market]);

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
                marketCap={capOf(e)}
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
              marketCap={capOf(e)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
