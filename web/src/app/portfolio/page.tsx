"use client";

// 포트폴리오 — 총자산·보유 종목·미체결 주문·실현손익. 로그인 게이트 + SSE 실시간 평가.
// 서버(/api/portfolio)는 numeric 원문만 주고, 평가액은 여기서 usePrices 현재가·fxRate로 재계산한다(§9).
// US 평가는 fxRate>0일 때만 원화 환산 — 없으면 "환산 불가"로 명시 표기(총자산에서도 제외).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getEntry, keyOf, type Currency, type Market, type Quote } from "@mockstock/shared";
import { authClient } from "@/lib/auth-client";
import { usePrices } from "@/lib/market/usePrices";
import {
  changeClass,
  formatPct,
  formatPrice,
  formatSignedPrice,
} from "@/lib/market/format";
import type { PortfolioPosition, PortfolioResponse } from "@/lib/portfolio";
import { Button } from "@/components/ui/button";
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

function currencyOf(market: Market, symbol: string): Currency {
  return getEntry(market, symbol)?.currency ?? (market === "US" ? "USD" : "KRW");
}

/** 포지션 1건 실시간 평가(KRW). US는 fxRate>0에서만 환산 가능 — 불가 시 valuationKrw=null. */
function valuePosition(p: PortfolioPosition, quote: Quote | undefined, fxRate: number) {
  const qty = Number(p.qty);
  const cost = Number(p.costBasisKrw);
  const price = quote?.price ?? getEntry(p.market, p.symbol)?.seedPrice ?? 0;
  const nativeValue = qty * price;
  const valuationKrw =
    p.market === "US" ? (fxRate > 0 ? nativeValue * fxRate : null) : nativeValue;
  const pnlKrw = valuationKrw == null ? null : valuationKrw - cost;
  const pnlPct = valuationKrw == null || cost === 0 ? null : (pnlKrw! / cost) * 100;
  return { price, valuationKrw, pnlKrw, pnlPct };
}

async function fetchPortfolio(): Promise<PortfolioResponse | null> {
  const res = await fetch("/api/portfolio", { cache: "no-store" });
  if (res.status === 401) throw new Error("unauthorized");
  if (res.status === 404) return null; // 진행 중인 시즌 없음
  if (!res.ok) throw new Error("포트폴리오를 불러오지 못했습니다.");
  return res.json();
}

export default function PortfolioPage() {
  const { data: session, isPending } = authClient.useSession();
  const isGuest =
    !session || (session.user as { isAnonymous?: boolean }).isAnonymous === true;

  return (
    <main className={SHELL}>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">포트폴리오</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        이번 시즌 내 자산과 주문을 한눈에 확인하세요
      </p>
      {isPending ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : isGuest ? (
        <LoginPrompt />
      ) : (
        <PortfolioView />
      )}
    </main>
  );
}

function LoginPrompt() {
  return (
    <Card className="mx-auto max-w-md text-center">
      <CardHeader>
        <CardTitle>로그인이 필요합니다</CardTitle>
        <CardDescription>
          포트폴리오는 로그인 후 이용할 수 있어요. 로그인하면 시드머니로 매매를 시작할 수 있습니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button
          className="w-full rounded-full font-semibold"
          onClick={() =>
            authClient.signIn.social({ provider: "google", callbackURL: "/portfolio" })
          }
        >
          Google로 로그인
        </Button>
        <Button
          variant="outline"
          className="w-full rounded-full font-semibold"
          onClick={() =>
            authClient.signIn.social({ provider: "github", callbackURL: "/portfolio" })
          }
        >
          GitHub로 로그인
        </Button>
      </CardContent>
    </Card>
  );
}

function PortfolioView() {
  const queryClient = useQueryClient();
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["portfolio"],
    queryFn: fetchPortfolio,
    refetchInterval: 30_000,
    retry: 1,
  });

  // 훅 순서 고정 — data 로드 전에도 usePrices를 항상 호출(빈 배열이면 미연결).
  const positions = data?.positions ?? [];
  const quotes = usePrices(positions.map((p) => ({ market: p.market, symbol: p.symbol })));

  async function cancel(id: string) {
    setCancelingId(id);
    try {
      const res = await fetch(`/api/orders/${id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}) as { message?: string });
      if (!res.ok) {
        toast.error(body.message ?? "주문 취소에 실패했습니다.");
        return;
      }
      toast.success(body.message ?? "주문을 취소했습니다.");
      await queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    } finally {
      setCancelingId(null);
    }
  }

  if (isLoading) return <Skeleton className="h-64 w-full rounded-2xl" />;
  if (isError)
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          포트폴리오를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </CardContent>
      </Card>
    );
  if (!data)
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          진행 중인 시즌이 없습니다. 다음 시즌을 기다려 주세요.
        </CardContent>
      </Card>
    );

  const fxRate = data.fxRate;
  const cash = Number(data.cashKrw);
  const reserved = Number(data.reservedKrw);
  const realized = Number(data.realizedPnlKrw);

  let holdingsKrw = 0;
  let hasUnconvertible = false;
  const rows = positions.map((p) => {
    const v = valuePosition(p, quotes[keyOf(p.market, p.symbol)], fxRate);
    if (v.valuationKrw == null) hasUnconvertible = true;
    else holdingsKrw += v.valuationKrw;
    return { p, ...v };
  });
  const totalKrw = cash + reserved + holdingsKrw;

  return (
    <div className="flex flex-col gap-6">
      {/* 총자산 요약 */}
      <Card>
        <CardHeader>
          <CardDescription>총자산</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {formatPrice(totalKrw, "KRW")}
          </CardTitle>
          {hasUnconvertible && (
            <p className="text-xs text-muted-foreground">
              * 환율 정보가 없어 일부 해외 종목은 원화 환산·합산에서 제외되었습니다.
            </p>
          )}
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="현금" value={formatPrice(cash, "KRW")} />
          <Stat label="예약 현금" value={formatPrice(reserved, "KRW")} />
          <Stat
            label="실현손익"
            value={formatSignedPrice(realized, "KRW")}
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
                    <TableHead className="text-right">현재가</TableHead>
                    <TableHead className="text-right">평가금액</TableHead>
                    <TableHead className="text-right">평가손익</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ p, price, valuationKrw, pnlKrw, pnlPct }) => {
                    const currency = currencyOf(p.market, p.symbol);
                    const name = getEntry(p.market, p.symbol)?.name ?? p.symbol;
                    return (
                      <TableRow key={keyOf(p.market, p.symbol)}>
                        <TableCell>
                          <div className="font-medium">{name}</div>
                          <div className="text-xs text-muted-foreground">
                            {p.symbol} · {p.market === "KR" ? "KOSPI" : "US"}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Number(p.qty).toLocaleString("ko-KR", { maximumFractionDigits: 6 })}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPrice(price, currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {valuationKrw == null ? "환산 불가" : formatPrice(valuationKrw, "KRW")}
                        </TableCell>
                        <TableCell
                          className={cn("text-right tabular-nums", pnlKrw != null && changeClass(pnlKrw))}
                        >
                          {pnlKrw == null
                            ? "—"
                            : `${formatSignedPrice(pnlKrw, "KRW")}${pnlPct != null ? ` (${formatPct(pnlPct)})` : ""}`}
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

      {/* 미체결 주문 */}
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
                    <TableHead className="text-right">취소</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.openOrders.map((o) => {
                    const currency = currencyOf(o.market, o.symbol);
                    const name = getEntry(o.market, o.symbol)?.name ?? o.symbol;
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <div className="font-medium">{name}</div>
                          <div className="text-xs text-muted-foreground">{o.symbol}</div>
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
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={cancelingId === o.id}
                            onClick={() => cancel(o.id)}
                          >
                            {cancelingId === o.id ? "취소 중…" : "취소"}
                          </Button>
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
