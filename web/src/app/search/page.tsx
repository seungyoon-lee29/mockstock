import type { Metadata } from "next";
import { SearchView } from "./search-view";

export const metadata: Metadata = {
  title: "검색 — 모의주식",
  description: "종목명 또는 티커로 유니버스 종목을 검색하세요.",
};

export default function SearchPage() {
  return (
    <main className="flex-1">
      <SearchView />
    </main>
  );
}
