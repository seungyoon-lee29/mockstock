// DELETE /api/orders/[id] — 지정가 미체결 취소 (T08 §5.1 주문함·§6.3). 본인 open 주문만.
// CAS(id AND user_id AND status='open') RETURNING reserved_krw → 매수 예약이면 환불(단일 트랜잭션).
// 성공 시 워커에 cancel push(§7.1, 실패 무시).
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { pushOrderSync } from "@/lib/market/workerClient";
import { cancelOrder } from "@/lib/orders/limit";

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return json(401, { message: "로그인이 필요합니다." });
  if (session.user.isAnonymous) return json(403, { message: "로그인이 필요합니다." });

  const { id } = await ctx.params;
  if (!id) return json(400, { message: "주문 id가 필요합니다." });

  const db = getDb();
  const result = await cancelOrder(db, session.user.id, id);
  // 본인 open 주문이 아니면(없음·이미 체결/취소·타인) 404 — 존재 여부를 세분화해 노출하지 않음.
  if (!result.ok) return json(404, { message: "취소할 수 있는 주문이 없습니다." });

  // 워커 매칭 캐시에서 제거 push(§7.1). 실패는 조용히 무시.
  void pushOrderSync("cancel", { id });

  return json(200, {
    ok: true,
    orderId: id,
    status: "cancelled",
    refunded: result.refunded,
    message: result.refunded ? "주문을 취소하고 예약 현금을 환불했습니다." : "주문을 취소했습니다.",
  });
}
