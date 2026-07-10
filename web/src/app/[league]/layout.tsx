import { notFound } from "next/navigation";

const LEAGUES = ["us", "kr"] as const;

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
}) {
  const { league } = await params;
  if (!(LEAGUES as readonly string[]).includes(league)) notFound();
  return children;
}
