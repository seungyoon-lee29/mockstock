"use client";

// 참가자 공개 포트폴리오 — 리더보드 행 클릭 상세(무인증 공개, 리더보드와 동일 표면).
// 서버는 원시 {cash, reserved, positions}만 주고, 클라가 구독 중인 SSE 현재가로
// 평가액·수익률을 로컬 재계산한다(§9, 리더보드·포트폴리오 페이지와 동일 원칙).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getEntry, keyOf, type Currency, type Quote } from "@mockstock/shared";
import { usePrices } from "@/lib/market/usePrices";
import {
  changeClass,
  formatPct,
  formatPrice,
  formatSignedPrice,
  formatTradeTime,
} from "@/lib/market/format";
import { LEADERBOARD_POLL_MS } from "@/lib/leaderboard";
import type { ParticipantPortfolio } from "@/lib/portfolio";
import { InvestmentProfileCard } from "@/components/profile/investment-profile-card";
import { SymbolAvatar } from "@/components/market/symbol-avatar";
import { PriceText } from "@/components/PriceText";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const SHELL = "mx-auto w-full max-w-5xl px-4 py-6";

async function fetchParticipant(
  league: string,
  userId: string,
): Promise<ParticipantPortfolio | null> {
  const res = await fetch(
    `/api/users/${encodeURIComponent(userId)}/portfolio?league=${league}`,
    { cache: "no-store" },
  );
  if (res.status === 404) return null; // 유저 부재·익명·시즌 준비 중
  if (!res.ok) throw new Error("참가자 정보를 불러오지 못했습니다.");
  return res.json();
}

/** 포지션 1건 실시간 평가. 시세 미도착이면 취득원가로 평가(등락 0) — 리더보드 rankParticipants와 동일 규약. */
function valuePosition(
  p: ParticipantPortfolio["positions"][number],
  quote: Quote | undefined,
) {
  const qty = Number(p.qty);
  const cost = Number(p.costBasis);
  const avgPrice = qty > 0 ? cost / qty : 0; // 주당 평단 = costBasis / qty (db.md 파생 규약)
  const price = quote?.price ?? avgPrice;
  const valuation = quote ? qty * quote.price : cost;
  const pnl = valuation - cost;
  const pnlPct = cost === 0 ? null : (pnl / cost) * 100;
  return { avgPrice, price, valuation, pnl, pnlPct };
}

export function ParticipantView({ league, userId }: { league: string; userId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["participant", league, userId],
    queryFn: () => fetchParticipant(league, userId),
    refetchInterval: LEADERBOARD_POLL_MS,
    retry: 1,
  });

  // 훅 순서 고정 — data 로드 전에도 usePrices를 항상 호출(빈 배열이면 미연결).
  const positions = useMemo(() => data?.positions ?? [], [data]);
  const quotes = usePrices(positions.map((p) => ({ market: p.market, symbol: p.symbol })));

  // 렌더 중 재할당 없이 useMemo + reduce로 평가액 합산(§9 클라 로컬 평가).
  const rows = useMemo(
    () => positions.map((p) => ({ p, ...valuePosition(p, quotes[keyOf(p.market, p.symbol)]) })),
    [positions, quotes],
  );
  const holdingsValue = useMemo(
    () => rows.reduce((acc, r) => acc + r.valuation, 0),
    [rows],
  );

  if (isLoading) {
    return (
      <div className={SHELL}>
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={SHELL}>
        <Notice title="참가자 정보를 불러오지 못했어요" hint="잠시 후 다시 시도해 주세요." />
      </div>
    );
  }
  if (!data) {
    return (
      <div className={SHELL}>
        <Notice
          title="참가자를 찾을 수 없어요"
          hint="탈퇴했거나 존재하지 않는 참가자예요. 리더보드에서 다시 선택해 주세요."
        />
      </div>
    );
  }

  const currency: Currency = league === "us" ? "USD" : "KRW";
  const cash = Number(data.cash);
  const reserved = Number(data.reserved);
  const realized = Number(data.realizedPnl);
  const seed = Number(data.season.seedMoney);
  const total = cash + reserved + holdingsValue;
  const returnAbs = total - seed;
  const returnPct = seed > 0 ? (returnAbs / seed) * 100 : 0;

  return (
    <div className={cn(SHELL, "flex flex-col gap-6")}>
      {/* 헤더 — 이름 + BOT 배지(리더보드와 동일 스타일) */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="truncate text-2xl font-bold tracking-tight">
            {data.user.name?.trim() || "게스트"}
          </h1>
          {data.user.isBot && <Badge variant="secondary">BOT</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">이번 시즌 공개 포트폴리오</p>
      </div>

      {!data.hasAccount ? (
        <Notice
          title="이번 시즌 참가 이력이 없습니다"
          hint="이 참가자는 아직 이번 시즌 리그에 참여하지 않았어요."
        />
      ) : (
        <>
          {/* 총 평가액·수익률·수익금 — 리더보드 순위 계산과 동일(현금+예약+보유 실시간 평가) */}
          <Card>
            <CardHeader>
              <CardDescription>총 평가액</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {formatPrice(total, currency)}
              </CardTitle>
              <PriceText change={returnAbs} className="text-sm font-semibold">
                {formatSignedPrice(returnAbs, currency)} ({formatPct(returnPct)})
              </PriceText>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="현금" value={formatPrice(cash, currency)} />
              <Stat label="예약 현금" value={formatPrice(reserved, currency)} />
              <Stat
                label="실현손익"
                value={formatSignedPrice(realized, currency)}
                className={changeClass(realized)}
              />
            </CardContent>
          </Card>

          {/* 보유 종목 */}
          <section>
            <h2 className="mb-2 text-lg font-semibold">보유 종목</h2>
            <Card>
              <CardContent className="p-0">
                {rows.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    보유 중인 종목이 없습니다.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>종목</TableHead>
                        <TableHead className="text-right">수량</TableHead>
                        <TableHead className="text-right">평단가</TableHead>
                        <TableHead className="text-right">현재가</TableHead>
                        <TableHead className="text-right">평가금액</TableHead>
                        <TableHead className="text-right">평가손익</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(({ p, avgPrice, price, valuation, pnl, pnlPct }) => {
                        const name = getEntry(p.market, p.symbol)?.name ?? p.symbol;
                        return (
                          <TableRow key={keyOf(p.market, p.symbol)}>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <SymbolAvatar market={p.market} symbol={p.symbol} name={name} />
                                <div>
                                  <div className="font-medium">{name}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {p.symbol} · {p.market === "KR" ? "KOSPI" : "US"}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {Number(p.qty).toLocaleString("ko-KR", { maximumFractionDigits: 6 })}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPrice(avgPrice, currency)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPrice(price, currency)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPrice(valuation, currency)}
                            </TableCell>
                            <TableCell className={cn("text-right tabular-nums", changeClass(pnl))}>
                              {`${formatSignedPrice(pnl, currency)}${pnlPct != null ? ` (${formatPct(pnlPct)})` : ""}`}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </section>

          {/* 봇(공개 벤치마크)만 — 미체결 주문 공개(읽기 전용, 취소 버튼 없음). */}
          {data.openOrders && (
            <section>
              <h2 className="mb-2 text-lg font-semibold">미체결 주문</h2>
              <Card>
                <CardContent className="p-0">
                  {data.openOrders.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      미체결 주문이 없습니다.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>종목</TableHead>
                          <TableHead>구분</TableHead>
                          <TableHead className="text-right">수량</TableHead>
                          <TableHead className="text-right">주문가</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.openOrders.map((o) => {
                          const name = getEntry(o.market, o.symbol)?.name ?? o.symbol;
                          return (
                            <TableRow key={o.id}>
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  <SymbolAvatar market={o.market} symbol={o.symbol} name={name} />
                                  <div>
                                    <div className="font-medium">{name}</div>
                                    <div className="text-xs text-muted-foreground">{o.symbol}</div>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <span className={o.side === "buy" ? "text-up" : "text-down"}>
                                  {o.side === "buy" ? "매수" : "매도"}
                                </span>
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {o.type === "limit" ? "지정가" : "시장가"}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {Number(o.qty).toLocaleString("ko-KR", { maximumFractionDigits: 6 })}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {o.limitPrice ? formatPrice(Number(o.limitPrice), currency) : "시장가"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>
          )}

          {/* 봇(공개 벤치마크)만 — 거래내역 전부 공개. */}
          {data.trades && (
            <section>
              <h2 className="mb-2 text-lg font-semibold">거래내역</h2>
              <Card>
                <CardContent className="p-0">
                  {data.trades.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      아직 체결된 거래가 없습니다.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>체결시각</TableHead>
                          <TableHead>종목</TableHead>
                          <TableHead>구분</TableHead>
                          <TableHead className="text-right">수량</TableHead>
                          <TableHead className="text-right">체결가</TableHead>
                          <TableHead className="text-right">체결금액</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.trades.map((t) => {
                          const name = getEntry(t.market, t.symbol)?.name ?? t.symbol;
                          const price = t.filledPrice ? Number(t.filledPrice) : null;
                          const amount = price != null ? Number(t.qty) * price : null;
                          return (
                            <TableRow key={t.id}>
                              <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                                {formatTradeTime(t.filledAt)}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  <SymbolAvatar market={t.market} symbol={t.symbol} name={name} />
                                  <div>
                                    <div className="font-medium">{name}</div>
                                    <div className="text-xs text-muted-foreground">{t.symbol}</div>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <span className={t.side === "buy" ? "text-up" : "text-down"}>
                                  {t.side === "buy" ? "매수" : "매도"}
                                </span>
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {t.type === "limit" ? "지정가" : "시장가"}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {Number(t.qty).toLocaleString("ko-KR", { maximumFractionDigits: 6 })}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {price != null ? formatPrice(price, currency) : "—"}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {amount != null ? formatPrice(amount, currency) : "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>
          )}

          {/* AI 투자 성향(§D8) — 서버가 통계로 lazy 생성, 키 없으면 규칙 기반 간이 분석 */}
          <InvestmentProfileCard league={league} userId={userId} />
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", className)}>{value}</div>
    </div>
  );
}

function Notice({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}
