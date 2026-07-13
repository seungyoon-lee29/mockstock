"use client";

// 구 딥링크 호환 — /[league]/discover 는 이제 통합 홈(/)으로 리다이렉트.
// 홈은 league 쿠키로 활성 시장을 고르므로, 먼저 이 리그로 쿠키를 세팅한 뒤 / 로 보낸다
// (쿠키 세팅은 서버 컴포넌트 렌더에서 불가 → 클라에서 document.cookie, site-header와 동일 관용구).
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

const LEAGUE_COOKIE = "league";

export default function LeagueDiscoverRedirect({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league } = use(params);
  const router = useRouter();

  useEffect(() => {
    const target = league === "us" ? "us" : "kr"; // 알 수 없는 값은 kr로 정규화
    document.cookie = `${LEAGUE_COOKIE}=${target}; path=/`;
    router.replace("/");
  }, [league, router]);

  return null;
}
