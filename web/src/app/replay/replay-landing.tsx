"use client";

// 시나리오 소개 + 종목 선택. 정적 manifest만 읽어 종목 그리드를 만들고, 각 종목은 재생 라우트로 링크.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SymbolAvatar } from "@/components/market/symbol-avatar";
import {
  REPLAY_SCENARIO_ID,
  manifestUrl,
  type ReplayManifest,
} from "@/lib/replay";

export function ReplayLanding() {
  const [manifest, setManifest] = useState<ReplayManifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(manifestUrl(REPLAY_SCENARIO_ID))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((m: ReplayManifest) => live && setManifest(m))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <p className="text-sm font-medium text-brand">과거장 훈련소</p>
      <h1 className="mt-1 text-2xl font-extrabold tracking-tight">
        {manifest?.name ?? "코로나 폭락·반등 (2020)"}
      </h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        {manifest?.description ??
          "실제 과거 차트를 배속으로 재생하며 가상 매매로 훈련합니다. 리그와 무관한 개인 연습 모드예요."}
      </p>
      {manifest && (
        <p className="mt-1 text-sm text-muted-foreground">
          재생 구간 {manifest.playPeriod.start} ~ {manifest.playPeriod.end}
        </p>
      )}

      <h2 className="mt-8 text-lg font-bold">종목을 하나 골라 시작하세요</h2>
      <p className="text-sm text-muted-foreground">
        한 종목을 끝까지 매매하며 이 사건을 겪어봅니다.
      </p>

      {error ? (
        <Card className="mt-4">
          <CardContent className="py-8 text-center text-muted-foreground">
            시나리오 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
          </CardContent>
        </Card>
      ) : !manifest ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {manifest.symbols.US.map((symbol) => (
            <Link key={symbol} href={`/replay/${symbol}`} className="group">
              <Card
                size="sm"
                className="transition group-hover:ring-brand/40 group-hover:ring-2"
              >
                <CardHeader className="flex-row items-center gap-2 space-y-0">
                  <SymbolAvatar market="US" symbol={symbol} name={symbol} size="sm" />
                  <CardTitle className="text-base font-bold">{symbol}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-xs text-muted-foreground">
                  일봉 재생 시작
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
