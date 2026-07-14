"use client";

// 홈 대시보드 상단 인덱스 스트립 — 코스피·코스닥 | S&P 500·나스닥 4종을 항상 노출.
// "라벨 값 등락%" 칩. 상승 빨강 / 하락 파랑. 칩 클릭 시 아래에 큰 지수 라인차트(일봉) 표시.
//  · KR 지수 = KIS 업종지수 기간별 일봉, US(SPY/QQQ) = Alpaca ETF 일봉 (/api/index-candles).
// /api/indices는 키 없으면 시장별 빈 배열 → 해당 시장 칩은 "—"(크래시 금지).
// 좁은 화면에선 가로 스크롤(overflow-x-auto) — 랩 대신 스크롤로 한 줄 유지.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { INDICES, type IndexQuote, type IndicesPayload } from "@mockstock/shared";
import { changeClass, formatPct } from "@/lib/market/format";
import { cn } from "@/lib/utils";
import { IndexChart } from "./index-chart";

const INDICES_ENDPOINT = "/api/indices";
const POLL_MS = 20_000; // 워커 폴 주기(기본 20s)와 정렬.

/** 지수값 표기 — 소수 2자리 콤마(코스피 2,610.15 / S&P 500 5,431.20). */
function formatIndexValue(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function Chip({
  label,
  quote,
  selected,
  onSelect,
}: {
  label: string;
  quote: IndexQuote | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex shrink-0 items-baseline gap-2 rounded-full border px-3 py-1.5",
        "cursor-pointer transition-colors hover:bg-muted/50",
        selected ? "border-brand bg-brand/10" : "bg-card",
      )}
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {quote ? (
        <>
          <span className="text-sm font-semibold tabular-nums">{formatIndexValue(quote.value)}</span>
          <span className={cn("text-xs font-medium tabular-nums", changeClass(quote.change))}>
            {formatPct(quote.changePct)}
          </span>
        </>
      ) : (
        // 키리스·빈 배열·미도착 → "—" (크래시 금지)
        <span className="text-sm font-semibold text-muted-foreground">—</span>
      )}
    </button>
  );
}

export function IndexStrip() {
  const { data } = useQuery({
    queryKey: ["indices"],
    queryFn: async ({ signal }): Promise<IndicesPayload> => {
      const res = await fetch(INDICES_ENDPOINT, { signal });
      if (!res.ok) throw new Error("지수를 불러오지 못했습니다");
      return res.json();
    },
    refetchInterval: POLL_MS,
  });

  // 선택된 지수(차트 대상). 기본 = 첫 KR 지수(코스피). 키는 4종 유니크라 market 없이 조회 가능.
  const defs = [...INDICES.KR, ...INDICES.US];
  const [selectedKey, setSelectedKey] = useState<string>(INDICES.KR[0].key);
  const selectedDef = defs.find((d) => d.key === selectedKey) ?? INDICES.KR[0];

  // key → IndexQuote. data 미도착(로딩·실패)이면 전 칩 "—".
  const byKey = new Map<string, IndexQuote>();
  for (const q of [...(data?.KR ?? []), ...(data?.US ?? [])]) byKey.set(q.key, q);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {defs.map((d) => (
          <Chip
            key={d.key}
            label={d.label}
            quote={byKey.get(d.key)}
            selected={d.key === selectedKey}
            onSelect={() => setSelectedKey(d.key)}
          />
        ))}
      </div>
      <IndexChart market={selectedDef.market} indexKey={selectedDef.key} label={selectedDef.label} />
    </div>
  );
}
