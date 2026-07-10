import Link from "next/link";
import { cookies } from "next/headers";

// 두 리그(US·KR) 지갑·순위 요약 진입 화면 — 유저가 지갑 2개임을 알게. 상세는 /[league]/portfolio.
export default async function Home() {
  const league = (await cookies()).get("league")?.value === "us" ? "us" : "kr";
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">두 개의 리그, 두 개의 지갑</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        국내(₩10,000,000)와 해외($10,000)를 각각 네이티브 통화로 플레이하세요.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LeagueCard league="kr" title="국내 리그" seed="₩10,000,000" />
        <LeagueCard league="us" title="해외 리그" seed="$10,000" />
      </div>
      <div className="mt-6">
        <Link href={`/${league}/discover`} className="text-brand underline">
          {league === "us" ? "해외" : "국내"} 종목 둘러보기 →
        </Link>
      </div>
    </main>
  );
}

// ponytail: 카드 전체를 Link로 감싸면 내부 리더보드 Link가 중첩 앵커가 됨 — 바깥을 div로,
// 두 링크를 나란히 배치해 중첩 앵커 없이 각각 동작하게 함.
function LeagueCard({ league, title, seed }: { league: string; title: string; seed: string }) {
  return (
    <div className="rounded-2xl border bg-card p-5 transition hover:border-brand">
      <div className="text-lg font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">시드 {seed}</div>
      <div className="mt-3 flex gap-3 text-sm">
        <Link href={`/${league}/portfolio`} className="text-brand">포트폴리오</Link>
        <Link href={`/${league}/leaderboard`} className="text-muted-foreground hover:text-foreground">리더보드</Link>
      </div>
    </div>
  );
}
