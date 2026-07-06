import { ReplayLanding } from "./replay-landing";

// 과거장 훈련소 — 시나리오 소개 + 종목 선택. 재생은 종목별 라우트(/replay/[symbol])에서.
export default function ReplayPage() {
  return (
    <main className="flex-1">
      <ReplayLanding />
    </main>
  );
}
