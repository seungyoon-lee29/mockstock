"use client";

// 종목 로고 아바타 — 정적 로고 로드 실패 시 2글자 텍스트 폴백(radix Avatar가 onError 처리).
import { useState } from "react";
import type { Market } from "@mockstock/shared";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** 정적 로고 경로 포맷 — scripts/logos/fetch-logos.mjs 저장 규칙과 동일하게 유지할 것. */
export function symbolLogoSrc(market: Market, symbol: string): string {
  return `/logos/${market}/${symbol}.png`;
}

// 404난 로고 경로 기억 — 리스트 재정렬로 재마운트될 때마다 404 재요청(틱당 반복)하는 스팸 방지.
const failedLogoSrcs = new Set<string>();

export function SymbolAvatar({
  market,
  symbol,
  name,
  size = "default",
}: {
  market: Market;
  symbol: string;
  name: string;
  size?: "default" | "sm" | "lg";
}) {
  const src = symbolLogoSrc(market, symbol);
  const [failed, setFailed] = useState(() => failedLogoSrcs.has(src));
  return (
    <Avatar size={size}>
      {!failed && (
        <AvatarImage
          src={src}
          alt={`${name} 로고`}
          onLoadingStatusChange={(status) => {
            if (status === "error") {
              failedLogoSrcs.add(src);
              setFailed(true);
            }
          }}
        />
      )}
      <AvatarFallback className="font-bold">{name.slice(0, 2)}</AvatarFallback>
    </Avatar>
  );
}
