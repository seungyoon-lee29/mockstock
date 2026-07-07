"use client";

// 종목 하나를 과거 일봉으로 배속 재생하며 로컬 매매하는 훈련 화면(PRD §5.3).
// 미래 누설 금지: 차트에는 현재 시점(cursor)까지의 캔들만 넘긴다. 재생 끝나면 결과 리포트 +
// reportTail("실제 역사 vs 나") 공개. 성적은 /api/replay 로 개인 기록만 저장(게스트는 로그인 CTA).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import type { CandlestickData, Time } from "lightweight-charts";
import { authClient } from "@/lib/auth-client";
import { PriceChart } from "@/components/PriceChart";
import { PriceText } from "@/components/PriceText";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPrice, formatPct } from "@/lib/market/format";
import {
  REPLAY_SCENARIO_ID,
  REPLAY_SPEEDS,
  REPLAY_DEFAULT_SPEED,
  manifestUrl,
  candleUrl,
  stepIntervalMs,
  firstIndexOnOrAfter,
  lastIndexOnOrBefore,
  initAccount,
  equityOf,
  buy,
  sell,
  returnPct,
  maxDrawdown,
  buyAndHoldReturnPct,
  savePendingReplay,
  loadPendingReplay,
  clearPendingReplay,
  visibleSeries,
  type Candle,
  type ReplayManifest,
  type ReplayAccount,
  type Timeframe,
} from "@/lib/replay";

// 매매 프리셋 비중(현금/보유의 25·50·100%). 매직넘버 산재 방지용 단일 소스.
const TRADE_FRACTIONS = [0.25, 0.5, 1] as const;
const fractionLabel = (f: number) => (f === 1 ? "전량" : `${Math.round(f * 100)}%`);

// 차트 타임프레임 토글(일/주). 재생·매매·성적은 일봉 인덱스 기준이고 주봉은 표시에만 영향.
const TIMEFRAMES = [
  { id: "day", label: "일" },
  { id: "week", label: "주" },
] as const satisfies readonly { id: Timeframe; label: string }[];

export function ReplayPlayer({ symbol }: { symbol: string }) {
  const [data, setData] = useState<{ manifest: ReplayManifest; candles: Candle[] } | null>(null);
  const [error, setError] = useState(false);

  // 로그인 왕복 후 복귀(§194): 보존된 게스트 결과를 감지해 한 번만 재제출. 멱등키(id)로 서버가
  // 중복 저장을 막고, resubmitting ref + 성공 시 정리로 클라 이중 트리거도 차단. 미로그인 응답
  // (id=null)이면 보존 유지 → 실제 로그인 후 재시도.
  const resubmitting = useRef(false);
  useEffect(() => {
    if (resubmitting.current) return;
    const pending = loadPendingReplay();
    if (!pending) return;
    resubmitting.current = true;
    fetch("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending),
    })
      .then((r) => (r.ok ? r.json() : { id: null }))
      .then((b: { id: string | null }) => {
        if (b.id) {
          clearPendingReplay();
          toast.success("이전 훈련 기록을 저장했어요.");
        }
      })
      .catch(() => {
        resubmitting.current = false; // 네트워크 실패 → 다음 방문에 재시도
      });
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(manifestUrl(REPLAY_SCENARIO_ID)).then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch(candleUrl(REPLAY_SCENARIO_ID, symbol)).then((r) => (r.ok ? r.json() : Promise.reject())),
    ])
      .then(([manifest, candles]: [ReplayManifest, Candle[]]) => {
        if (live) setData({ manifest, candles });
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [symbol]);

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <p>{symbol} 데이터를 불러오지 못했습니다.</p>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/replay">종목 다시 고르기</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }
  return <ReplaySession key={symbol} symbol={symbol} manifest={data.manifest} candles={data.candles} />;
}

function ReplaySession({
  symbol,
  manifest,
  candles,
}: {
  symbol: string;
  manifest: ReplayManifest;
  candles: Candle[];
}) {
  const playStart = useMemo(
    () => firstIndexOnOrAfter(candles, manifest.playPeriod.start),
    [candles, manifest],
  );
  const playEnd = useMemo(
    () => lastIndexOnOrBefore(candles, manifest.playPeriod.end),
    [candles, manifest],
  );

  const [cursor, setCursor] = useState(playStart);
  const [account, setAccount] = useState<ReplayAccount>(() => initAccount());
  const [curve, setCurve] = useState<number[]>(() => [equityOf(initAccount(), candles[playStart].c)]);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(REPLAY_DEFAULT_SPEED);
  const [timeframe, setTimeframe] = useState<Timeframe>("day");
  const [finished, setFinished] = useState(false);
  const [revealTail, setRevealTail] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "guest">("idle");

  const sessionIdRef = useRef<string | null>(null);
  const accountRef = useRef(account);
  accountRef.current = account;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // 세션 시작 insert(완주율 분모). 게스트·실패는 id=null → 완주 시 로그인 CTA. best-effort.
  useEffect(() => {
    fetch("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: REPLAY_SCENARIO_ID }),
    })
      .then((r) => (r.ok ? r.json() : { id: null }))
      .then((b: { id: string | null }) => (sessionIdRef.current = b.id))
      .catch(() => (sessionIdRef.current = null));
  }, []);

  const price = candles[cursor].c;
  const prevClose = candles[cursor - 1]?.c ?? candles[cursor].o;
  const equity = equityOf(account, price);
  const rtnPct = returnPct(equity);

  // 하루 전진: 다음 캔들 종가로 자산곡선 append. playEnd 도달 시 완주.
  const tick = useCallback(() => {
    const cur = cursorRef.current;
    if (cur >= playEnd) {
      setPlaying(false);
      setFinished(true);
      return;
    }
    const next = cur + 1;
    setCursor(next);
    setCurve((c) => [...c, equityOf(accountRef.current, candles[next].c)]);
  }, [candles, playEnd]);

  useEffect(() => {
    if (!playing || finished) return;
    const id = setInterval(tick, stepIntervalMs(speed));
    return () => clearInterval(id);
  }, [playing, finished, speed, tick]);

  // 완주 시 성적 저장(개인 기록만). id 없으면 게스트 → 로그인 CTA.
  useEffect(() => {
    if (!finished) return;
    const id = sessionIdRef.current;
    if (!id) {
      setSaveState("guest");
      return;
    }
    fetch("/api/replay", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, returnPct: rtnPct, mdd: maxDrawdown(curve) }),
    })
      .then((r) => setSaveState(r.ok ? "saved" : "guest"))
      .catch(() => setSaveState("guest"));
    // 완주 순간 1회만 — rtnPct/curve는 그 시점 값으로 캡처.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  // 미래 누설 금지: 현재 시점까지만. 완주 후 "이후 보기" 시에만 tail 공개.
  // 주봉은 커서까지 자른 일봉을 집계하므로(미래 캔들이 애초에 없음) 누설 불변식이 그대로 유지된다.
  const chartData = useMemo<CandlestickData<Time>[]>(
    () =>
      visibleSeries(candles, cursor, timeframe, { finished, revealTail }).map((c) => ({
        time: c.date as Time,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    [candles, cursor, finished, revealTail, timeframe],
  );

  function trade(next: ReplayAccount) {
    setAccount(next);
    setCurve((c) => {
      const copy = [...c];
      copy[copy.length - 1] = equityOf(next, price);
      return copy;
    });
  }

  function reset() {
    setCursor(playStart);
    setAccount(initAccount());
    setCurve([equityOf(initAccount(), candles[playStart].c)]);
    setFinished(false);
    setRevealTail(false);
    setSaveState("idle");
    setPlaying(true);
    sessionIdRef.current = null;
    fetch("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: REPLAY_SCENARIO_ID }),
    })
      .then((r) => (r.ok ? r.json() : { id: null }))
      .then((b: { id: string | null }) => (sessionIdRef.current = b.id))
      .catch(() => (sessionIdRef.current = null));
  }

  const pathname = usePathname(); // 로그인 후 이 종목으로 복귀시킬 callbackURL

  // 게스트 완주 결과를 sessionStorage에 보존 후 소셜 로그인(§194). 복귀 시 ReplayPlayer가 재제출.
  function saveViaLogin(provider: "google" | "github") {
    savePendingReplay({
      id: crypto.randomUUID(),
      scenarioId: REPLAY_SCENARIO_ID,
      returnPct: rtnPct,
      mdd: maxDrawdown(curve),
    });
    authClient.signIn.social({ provider, callbackURL: pathname });
  }

  const progress = playEnd > playStart ? (cursor - playStart) / (playEnd - playStart) : 1;
  const holding = account.qty > 1e-9;
  const avgCost = holding ? account.costBasis / account.qty : 0;
  const unrealizedPct = holding ? ((price * account.qty - account.costBasis) / account.costBasis) * 100 : 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-baseline justify-between">
        <div>
          <Link href="/replay" className="text-sm text-muted-foreground hover:text-foreground">
            ← 훈련소
          </Link>
          <h1 className="text-2xl font-extrabold tracking-tight">{symbol}</h1>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold tabular-nums">{formatPrice(price, "USD")}</div>
          <PriceText change={price - prevClose} pct={((price - prevClose) / prevClose) * 100} currency="USD" className="text-sm" />
        </div>
      </div>

      <div className="mt-2 text-sm text-muted-foreground tabular-nums">{candles[cursor].date}</div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-brand" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardContent className="px-2">
            <PriceChart symbol={symbol} data={chartData} height={360} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* 재생 컨트롤 */}
          <Card size="sm">
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={playing ? "outline" : "default"}
                disabled={finished}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? "일시정지" : "재생"}
              </Button>
              <div className="flex gap-1">
                {REPLAY_SPEEDS.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={speed === s ? "default" : "ghost"}
                    onClick={() => setSpeed(s)}
                  >
                    x{s}
                  </Button>
                ))}
              </div>
              <div className="ml-auto flex gap-1">
                {TIMEFRAMES.map((tf) => (
                  <Button
                    key={tf.id}
                    size="sm"
                    variant={timeframe === tf.id ? "default" : "ghost"}
                    onClick={() => setTimeframe(tf.id)}
                  >
                    {tf.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          {finished ? (
            <ResultCard
              rtnPct={rtnPct}
              mdd={maxDrawdown(curve)}
              trades={account.trades}
              buyHoldPct={buyAndHoldReturnPct(candles, playStart, playEnd)}
              tailPct={
                manifest.reportTailPeriod
                  ? buyAndHoldReturnPct(candles, playEnd, candles.length - 1)
                  : null
              }
              revealTail={revealTail}
              onRevealTail={() => setRevealTail(true)}
              saveState={saveState}
              onSaveViaLogin={saveViaLogin}
              onReset={reset}
            />
          ) : (
            <>
              {/* 포트폴리오 */}
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="text-sm text-muted-foreground">내 포트폴리오</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  <Row label="현금" value={formatPrice(account.cash, "KRW")} />
                  <Row label="평가금액" value={formatPrice(account.qty * price, "KRW")} />
                  <Row label="총자산" value={formatPrice(equity, "KRW")} strong />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">수익률</span>
                    <PriceText change={rtnPct} className="font-semibold">
                      {formatPct(rtnPct)}
                    </PriceText>
                  </div>
                  {holding && (
                    <div className="mt-1 flex justify-between border-t pt-1.5 text-xs">
                      <span className="text-muted-foreground">평단 {formatPrice(avgCost, "USD")}</span>
                      <PriceText change={unrealizedPct}>{formatPct(unrealizedPct)}</PriceText>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 매매 */}
              <Card size="sm">
                <CardContent className="space-y-2">
                  <div>
                    <p className="mb-1 text-xs font-medium text-up">매수</p>
                    <div className="grid grid-cols-3 gap-1">
                      {TRADE_FRACTIONS.map((f) => (
                        <Button
                          key={f}
                          size="sm"
                          variant="outline"
                          disabled={account.cash < 1}
                          onClick={() => trade(buy(account, price, f))}
                        >
                          {fractionLabel(f)}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-down">매도</p>
                    <div className="grid grid-cols-3 gap-1">
                      {TRADE_FRACTIONS.map((f) => (
                        <Button
                          key={f}
                          size="sm"
                          variant="outline"
                          disabled={!holding}
                          onClick={() => trade(sell(account, price, f))}
                        >
                          {fractionLabel(f)}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <p className="text-center text-xs text-muted-foreground">매매 {account.trades}회</p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-bold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

function ResultCard({
  rtnPct,
  mdd,
  trades,
  buyHoldPct,
  tailPct,
  revealTail,
  onRevealTail,
  saveState,
  onSaveViaLogin,
  onReset,
}: {
  rtnPct: number;
  mdd: number;
  trades: number;
  buyHoldPct: number;
  tailPct: number | null;
  revealTail: boolean;
  onRevealTail: () => void;
  saveState: "idle" | "saved" | "guest";
  onSaveViaLogin: (provider: "google" | "github") => void;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>결과 리포트</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">내 수익률</span>
          <PriceText change={rtnPct} className="text-lg font-bold">
            {formatPct(rtnPct)}
          </PriceText>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">최대 낙폭(MDD)</span>
          <PriceText change={mdd}>{formatPct(mdd)}</PriceText>
        </div>
        <Row label="매매 횟수" value={`${trades}회`} />
        <div className="mt-2 flex justify-between border-t pt-2">
          <span className="text-muted-foreground">그냥 들고 있었다면</span>
          <PriceText change={buyHoldPct}>{formatPct(buyHoldPct)}</PriceText>
        </div>
        {tailPct !== null && (
          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            실제 역사: 재생 구간 이후에도 <PriceText change={tailPct} className="font-semibold">{formatPct(tailPct)}</PriceText> 움직였습니다.
            {!revealTail && (
              <button onClick={onRevealTail} className="ml-1 font-semibold text-brand underline">
                이후 차트 보기
              </button>
            )}
          </p>
        )}

        {saveState === "saved" && (
          <p className="text-center text-xs text-muted-foreground">기록이 프로필에 저장되었습니다.</p>
        )}
        {saveState === "guest" && (
          <div className="flex flex-col gap-2">
            <p className="text-center text-xs text-muted-foreground">
              로그인하면 이 기록이 프로필에 저장됩니다.
            </p>
            <Button className="w-full rounded-full font-semibold" onClick={() => onSaveViaLogin("google")}>
              Google로 로그인하고 저장
            </Button>
            <Button
              variant="outline"
              className="w-full rounded-full font-semibold"
              onClick={() => onSaveViaLogin("github")}
            >
              GitHub로 로그인하고 저장
            </Button>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={onReset} className="flex-1">
            다시 하기
          </Button>
          <Button asChild variant="outline" className="flex-1">
            <Link href="/replay">다른 종목</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
