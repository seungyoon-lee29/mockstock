"use client";

// 시나리오 선택(상단 토글) + 종목 선택. 선택 시나리오의 manifest만 읽어 종목 그리드를 만들고,
// 각 종목은 재생 라우트로 링크(?s=<scenarioId>로 시나리오 전달).
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SymbolAvatar } from "@/components/market/symbol-avatar";
import {
  REPLAY_SCENARIOS,
  REPLAY_DEFAULT_SCENARIO_ID,
  manifestUrl,
  type ReplayManifest,
} from "@/lib/replay";

export function ReplayLanding() {
  const [scenarioId, setScenarioId] = useState<string>(REPLAY_DEFAULT_SCENARIO_ID);
  const [manifest, setManifest] = useState<ReplayManifest | null>(null);
  // 실패한 시나리오 id를 담는다(불리언 대신) — 시나리오 전환 시 동기 setState 없이 파생 판정 가능.
  const [errorId, setErrorId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(manifestUrl(scenarioId))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((m: ReplayManifest) => live && setManifest(m))
      .catch(() => live && setErrorId(scenarioId));
    return () => {
      live = false;
    };
  }, [scenarioId]);

  // 시나리오를 막 바꾸면 manifest는 아직 이전 시나리오 것 → 스켈레톤으로 취급(동기 setState 없이 파생).
  const fresh = manifest?.id === scenarioId ? manifest : null;
  const error = errorId === scenarioId;
  const isMinute = fresh?.granularity === "minute";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <p className="text-sm font-medium text-brand">과거장 훈련소</p>
      <h1 className="mt-1 text-2xl font-extrabold tracking-tight">
        실제 과거 차트로 훈련하기
      </h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        실제 과거 차트를 배속으로 재생하며 가상 매매로 훈련합니다. 리그와 무관한 개인 연습 모드예요.
      </p>

      {/* 시나리오 선택 토글 */}
      <div className="mt-5 flex flex-wrap gap-2">
        {REPLAY_SCENARIOS.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={scenarioId === s.id ? "default" : "outline"}
            onClick={() => setScenarioId(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {fresh && (
        <p className="mt-3 text-sm text-muted-foreground">
          {fresh.description}
          {" "}
          <span className="tabular-nums">
            (재생 구간 {fresh.playPeriod.start} ~ {fresh.playPeriod.end})
          </span>
        </p>
      )}

      <h2 className="mt-8 text-lg font-bold">종목을 하나 골라 시작하세요</h2>
      <p className="text-sm text-muted-foreground">
        한 종목을 끝까지 매매하며 이 구간을 겪어봅니다.
      </p>

      {error ? (
        <Card className="mt-4">
          <CardContent className="py-8 text-center text-muted-foreground">
            시나리오 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
          </CardContent>
        </Card>
      ) : !fresh ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {fresh.symbols.US.map((symbol) => (
            <Link
              key={symbol}
              href={`/replay/${symbol}?s=${scenarioId}`}
              className="group"
            >
              <Card
                size="sm"
                className="transition group-hover:ring-brand/40 group-hover:ring-2"
              >
                <CardHeader className="flex-row items-center gap-2 space-y-0">
                  <SymbolAvatar market="US" symbol={symbol} name={symbol} size="sm" />
                  <CardTitle className="text-base font-bold">{symbol}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-xs text-muted-foreground">
                  {isMinute ? "분봉 재생 시작" : "일봉 재생 시작"}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
