// 등락 방향에 따라 상승 빨강/하락 파랑 색을 입히는 공용 가격 텍스트.
// 색은 format.ts의 changeClass(→ --color-up/--color-down 토큰)만 경유(색상 리터럴 금지).
import type { HTMLAttributes, ReactNode } from "react";
import type { Currency } from "@mockstock/shared";
import { changeClass, formatSignedPrice, formatPct } from "@/lib/market/format";
import { cn } from "@/lib/utils";

type PriceTextProps = HTMLAttributes<HTMLSpanElement> & {
  /** 색 방향을 결정하는 등락액(양수=상승/음수=하락/0=보합). */
  change: number;
  /** children 미지정 시 자동 표기용 등락률. */
  pct?: number;
  /** children 미지정 시 자동 등락액 포맷에 필요한 통화. */
  currency?: Currency;
  children?: ReactNode;
};

export function PriceText({
  change,
  pct,
  currency,
  className,
  children,
  ...rest
}: PriceTextProps) {
  let content = children;
  if (content == null && currency) {
    content =
      pct == null
        ? formatSignedPrice(change, currency)
        : `${formatSignedPrice(change, currency)} (${formatPct(pct)})`;
  }
  return (
    <span
      className={cn("tabular-nums", changeClass(change), className)}
      {...rest}
    >
      {content}
    </span>
  );
}
