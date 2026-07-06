// 환율 갱신(§6.6) — USDKRW 단일 로우 upsert. 09:00 KST 크론이 금 15:30 확정에 선행.
//  1순위: 한국수출입은행 고시환율(env EXIM_API_KEY 있을 때) / 폴백: frankfurter(무키).
//  빈 응답(주말·공휴일·오전 고시 전)이면 upsert 를 생략해 직전 값을 유지한다.
import type { PgDatabase } from "drizzle-orm/pg-core";
import { fxRates } from "@mockstock/shared/schema";
import { FX_PAIR_USDKRW } from "@mockstock/shared";

type Db = PgDatabase<any, any, any>;

/** KST 기준 YYYYMMDD (EXIM searchdate 파라미터용). */
function kstYyyymmdd(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 한국수출입은행 고시환율 — AP01(환율), USD 매매기준율(deal_bas_r). 휴일·11시 전엔 빈 배열. */
async function fromExim(key: string): Promise<number | null> {
  const url = `https://www.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=${encodeURIComponent(key)}&searchdate=${kstYyyymmdd(new Date())}&data=AP01`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ cur_unit?: string; deal_bas_r?: string }>;
    const usd = Array.isArray(rows) ? rows.find((r) => r.cur_unit === "USD") : undefined;
    const v = usd?.deal_bas_r ? Number(usd.deal_bas_r.replace(/,/g, "")) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** frankfurter 무키 폴백 — { rates: { KRW } }. */
async function fromFrankfurter(): Promise<number | null> {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=KRW");
    if (!res.ok) return null;
    const j = (await res.json()) as { rates?: { KRW?: number } };
    const v = j.rates?.KRW;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** USDKRW 갱신. 성공 시 upsert, 빈 응답이면 직전 값 유지(upsert 생략). */
export async function updateFxRates(db: Db): Promise<{ ok: boolean; rate: number | null }> {
  const key = process.env.EXIM_API_KEY;
  const rate = (key ? await fromExim(key) : null) ?? (await fromFrankfurter());
  if (rate == null) return { ok: false, rate: null };
  const rateStr = rate.toFixed(4);
  await db
    .insert(fxRates)
    .values({ pair: FX_PAIR_USDKRW, rate: rateStr, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: fxRates.pair, set: { rate: rateStr, fetchedAt: new Date() } });
  return { ok: true, rate };
}
