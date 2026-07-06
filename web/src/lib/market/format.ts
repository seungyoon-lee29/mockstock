import type { Currency } from "@mockstock/shared";

/** 통화별 가격 표기. USD=$0.00, KRW=0원 */
export function formatPrice(value: number, currency: Currency): string {
  if (currency === "USD")
    return `$${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

/** 부호 붙은 변화액: +$1.23 / -1,200원 */
export function formatSignedPrice(value: number, currency: Currency): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return sign + formatPrice(Math.abs(value), currency);
}

/** +1.23% / -0.45% / 0.00% */
export function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

export type Dir = "up" | "down" | "flat";
export function dirOf(v: number): Dir {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

/** 한국식: 상승=빨강(text-up), 하락=파랑(text-down) — globals.css에 정의 */
export function changeClass(v: number): string {
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground";
}

/** 대량 숫자 축약(자산 표기용): 1.2조 / 3,400억 없이 원 단위 콤마 */
export function formatMoney(value: number, currency: Currency): string {
  return formatPrice(value, currency);
}
