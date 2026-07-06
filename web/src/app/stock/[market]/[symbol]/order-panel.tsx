"use client";

// 주문 패널: 시장가/지정가 탭 · 매수/매도 · 수량/지정가. POST /api/orders(idempotencyKey=UUID).
// 성공·에러 문구는 서버가 이미 한국어로 내려주므로 그대로 표기(정책 문구 단일 출처 — 중복 하드코딩 금지).
// 미체결 지정가는 이 화면에서 접수한 것만 로컬 유지(전체 조회 API 없음 — 포트폴리오 담당).
import { useState } from "react";
import { type Side, type UniverseEntry } from "@mockstock/shared";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatPrice } from "@/lib/market/format";
import { cn } from "@/lib/utils";

type OrderTab = "market" | "limit";
type OpenOrder = { orderId: string; side: Side; qty: number; limitPrice: number };
type Feedback = { ok: boolean; text: string } | null;

// 응답 파싱 실패·네트워크 오류 등 서버 문구가 없을 때만 쓰는 폴백.
const NETWORK_ERROR = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";

export function OrderPanel({ entry, price }: { entry: UniverseEntry; price: number }) {
  const { data: session, isPending } = authClient.useSession();
  const [tab, setTab] = useState<OrderTab>("market");
  const [side, setSide] = useState<Side>("buy");
  const [qty, setQty] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [guestBusy, setGuestBusy] = useState(false);

  const qtyNum = Number(qty);
  const limitNum = Number(limit);
  const estUnit = tab === "limit" && limitNum > 0 ? limitNum : price;
  const estTotal = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum * estUnit : 0;

  async function submit() {
    setFeedback(null);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      setFeedback({ ok: false, text: "수량은 1 이상의 정수여야 합니다." });
      return;
    }
    if (tab === "limit" && !(limitNum > 0)) {
      setFeedback({ ok: false, text: "지정가는 0보다 큰 값이어야 합니다." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: entry.market,
          symbol: entry.symbol,
          side,
          qty: qtyNum,
          idempotencyKey: crypto.randomUUID(),
          ...(tab === "limit" ? { limitPrice: limitNum } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      const text = typeof body.message === "string" ? body.message : NETWORK_ERROR;
      setFeedback({ ok: res.ok, text });
      // 지정가 접수 성공(201 open) → 로컬 미체결 목록에 추가.
      if (res.ok && tab === "limit" && body.status === "open") {
        setOpenOrders((prev) => [
          { orderId: String(body.orderId), side, qty: qtyNum, limitPrice: limitNum },
          ...prev,
        ]);
        setQty("");
        setLimit("");
      }
    } catch {
      setFeedback({ ok: false, text: NETWORK_ERROR });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(orderId: string) {
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      // 200 취소 성공, 404(이미 체결/취소·없음)도 목록에서 제거해 UI를 실제 상태에 맞춘다.
      if (res.ok || res.status === 404) {
        setOpenOrders((prev) => prev.filter((o) => o.orderId !== orderId));
      }
      setFeedback({
        ok: res.ok,
        text: typeof body.message === "string" ? body.message : NETWORK_ERROR,
      });
    } catch {
      setFeedback({ ok: false, text: NETWORK_ERROR });
    }
  }

  if (isPending) {
    return <div className="h-72 animate-pulse rounded-2xl border bg-card" aria-hidden />;
  }

  // 미로그인 → 게스트로 시작 유도(§5.4: 둘러보기는 게스트, 주문은 로그인 게이트).
  if (!session) {
    return (
      <div className="flex h-fit flex-col gap-3 rounded-2xl border bg-card p-5 text-center">
        <p className="text-sm text-muted-foreground">주문하려면 로그인이 필요해요.</p>
        <Button
          className="rounded-full font-semibold"
          disabled={guestBusy}
          onClick={async () => {
            setGuestBusy(true);
            try {
              await authClient.signIn.anonymous();
            } finally {
              setGuestBusy(false);
            }
          }}
        >
          게스트로 시작
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-fit flex-col gap-4 rounded-2xl border bg-card p-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as OrderTab)}>
        <TabsList className="w-full">
          <TabsTrigger value="market">시장가</TabsTrigger>
          <TabsTrigger value="limit">지정가</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="inline-flex rounded-lg bg-muted p-1">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition",
              side === s
                ? s === "buy"
                  ? "bg-up text-white"
                  : "bg-down text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "buy" ? "매수" : "매도"}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">수량 (주)</span>
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="0"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </label>

      {tab === "limit" && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">지정가 ({entry.currency})</span>
          <Input
            type="number"
            min={0}
            step={entry.currency === "USD" ? "0.01" : "1"}
            inputMode="decimal"
            placeholder={String(price)}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      )}

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">예상 주문 금액</span>
        <span className="font-medium tabular-nums">
          {estTotal > 0 ? formatPrice(estTotal, entry.currency) : "-"}
        </span>
      </div>

      {tab === "limit" && (
        <p className="text-xs text-muted-foreground">
          지정가 주문은 접수 후 가격 도달 시 체결됩니다.
        </p>
      )}

      <Button
        className={cn(
          "rounded-lg font-semibold text-white transition hover:opacity-90",
          side === "buy" ? "bg-up" : "bg-down",
        )}
        disabled={busy}
        onClick={submit}
      >
        {busy ? "처리 중…" : side === "buy" ? "매수 주문" : "매도 주문"}
      </Button>

      {feedback && (
        <p
          role="status"
          aria-live="polite"
          className={cn("text-sm", feedback.ok ? "text-brand" : "text-destructive")}
        >
          {feedback.text}
        </p>
      )}

      {openOrders.length > 0 && (
        <div className="mt-1 flex flex-col gap-2 border-t pt-3">
          <p className="text-sm font-semibold">내 미체결 주문</p>
          {openOrders.map((o) => (
            <div key={o.orderId} className="flex items-center justify-between gap-2 text-sm">
              <span className="tabular-nums">
                <span className={o.side === "buy" ? "text-up" : "text-down"}>
                  {o.side === "buy" ? "매수" : "매도"}
                </span>{" "}
                {o.qty}주 · {formatPrice(o.limitPrice, entry.currency)}
              </span>
              <Button variant="ghost" size="sm" onClick={() => cancel(o.orderId)}>
                취소
              </Button>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            이 화면에서 접수한 주문만 표시합니다. 전체 미체결은 포트폴리오에서 확인하세요.
          </p>
        </div>
      )}
    </div>
  );
}
