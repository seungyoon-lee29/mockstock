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

/**
 * 라이브 시총 = 상장주식수 × 현재가. 표시 전용 파생값(저장·정산 아님 — db.md의 float 금지는
 * 체결·정산 금액 대상이라 무관). shares/price는 numeric 문자열(baseline 계약)이라 여기서 Number화.
 * shares 미상(null·비수치)이거나 가격 비정상이면 null → UI는 "—". 반환은 통화 네이티브 단위 값.
 */
export function computeMarketCap(
  sharesOutstanding: string | null | undefined,
  price: number,
): number | null {
  if (sharesOutstanding == null) return null;
  const shares = Number(sharesOutstanding);
  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return shares * price;
}

/**
 * 시총 축약 표기. KRW → 조·억(예: 1,701.4조 / 3,400억), USD → T·B·M(예: $3.71T / $850.20B).
 * cap이 null이면 "—"(미상). 큰 버킷은 소수, 작은 값은 정수/콤마.
 */
export function formatMarketCap(cap: number | null, currency: Currency): string {
  if (cap == null || !Number.isFinite(cap)) return "—";
  if (currency === "USD") {
    if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
    if (cap >= 1e9) return `$${(cap / 1e9).toFixed(2)}B`;
    if (cap >= 1e6) return `$${(cap / 1e6).toFixed(2)}M`;
    return `$${Math.round(cap).toLocaleString("en-US")}`;
  }
  // KRW: 조(1e12) · 억(1e8)
  if (cap >= 1e12) return `${(cap / 1e12).toFixed(1)}조`;
  if (cap >= 1e8) return `${Math.round(cap / 1e8).toLocaleString("ko-KR")}억`;
  return `${Math.round(cap).toLocaleString("ko-KR")}원`;
}
