import Link from "next/link";
import { cookies } from "next/headers";
import { SEED_MONEY, type Market } from "@mockstock/shared";
import { formatPrice } from "@/lib/market/format";
import { IndexStrip } from "@/components/market/index-strip";
import { Discover } from "@/components/discover/discover";

// 통합 라이브 대시보드(홈) — 게스트 우선, 즉시 렌더(계정 게이트 없음).
// 상단: 지수 스트립(항상 4종). 아래: 활성 시장의 종목 리스트(Discover 재사용) + 지갑 요약.
// 활성 시장은 league 쿠키(헤더 토글이 설정) — 기본 KR. 리그·지갑 2개 구조는 유지.
export default async function Home() {
  const league = (await cookies()).get("league")?.value === "us" ? "us" : "kr";
  const market: Market = league === "us" ? "US" : "KR";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
      <IndexStrip />
      <WalletSummary league={league} />
      {/* Discover가 자체 헤더·검색·패딩을 렌더 — 활성 시장만 표시(스펙 §디스커버). */}
      <Discover market={market} />
    </main>
  );
}

// 활성 리그 지갑 요약(게스트 시드 폴백) — 다른 리그로 가는 힌트 포함. 블로킹 게이트 아님.
// 시드 금액은 정적 상수(SEED_MONEY) — 로그인 없이도 노출. 실 잔고는 로그인 후 포트폴리오에서.
function WalletSummary({ league }: { league: string }) {
  const market: Market = league === "us" ? "US" : "KR";
  const other = league === "us" ? "kr" : "us";
  const seed = formatPrice(SEED_MONEY[market], market === "US" ? "USD" : "KRW");
  const otherLabel = other === "us" ? "해외" : "국내";

  return (
    <section className="my-4 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">
            {league === "us" ? "해외" : "국내"} 리그 지갑 · 시드머니
          </div>
          <div className="text-2xl font-bold tabular-nums">{seed}</div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href={`/${league}/portfolio`} className="text-brand font-medium">
            포트폴리오
          </Link>
          <Link
            href={`/${other}/discover`}
            className="text-muted-foreground hover:text-foreground"
          >
            {otherLabel} 리그로 →
          </Link>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        두 개의 리그, 두 개의 지갑 — 국내(₩)와 해외($)를 각각 네이티브 통화로 플레이하세요.
      </p>
    </section>
  );
}
