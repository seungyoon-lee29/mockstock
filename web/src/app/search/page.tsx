import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// 검색은 탐색(/[league]/discover)에 흡수(D3) — 구 /search 진입은 리그 쿠키(기본 kr)의
// 탐색으로 보낸다. 리그 결정은 루트 page.tsx와 동일 관행(쿠키 "league", 기본 kr).
export default async function SearchPage() {
  const league = (await cookies()).get("league")?.value === "us" ? "us" : "kr";
  redirect(`/${league}/discover`);
}
