// 상장주식수(shares_outstanding) 적재 — 시총 표시(discover/home)의 데이터 레이어.
// 시총 = shares_outstanding × 라이브 lastPrice(read-path 라이브 계산). shares는 느린 펀더멘털이라
// 부팅 1회(누락 종목만) + 주간 크론으로만 채운다(B13 Neon 보존 — 핫 루프 금지).
//  - US: Finnhub /stock/profile2 → shareOutstanding(백만 단위 → ×1e6). 키 없으면 스킵(fail-soft).
//  - KR: KIS 주식현재가 시세(FHKST01010100) lstn_stcn — kisRest 단일 throttle 경유(2 req/s 공유).
//  - numeric(20,0) 문자열 왕복(float 금지·db.md). UPSERT는 shares_outstanding만 SET(가격 컬럼 불변).
//  - DB 없으면(키리스 로컬) no-op → sharesOutstanding NULL → read-path 시총 "—"(불변식 보존).
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { UNIVERSE, type Market } from "@mockstock/shared";
import { instruments } from "@mockstock/shared/schema";
import { fetchKrShares, parseShares, isKisRestEnabled } from "./candles/kisRest";

type Db = PgDatabase<any, any, any>;

const FINNHUB_REST_BASE = "https://finnhub.io/api/v1";
const PROFILE2_PATH = "/stock/profile2";

function finnhubKey(): string | null {
  return process.env.FINNHUB_API_KEY || null;
}

/** Finnhub 키 존재 여부 — false면 US shares fetch가 전부 null(fail-soft, kisRest 규약과 동일). */
export function isFinnhubRestEnabled(): boolean {
  return !!finnhubKey();
}

/**
 * US 상장주식수 — Finnhub /stock/profile2 의 shareOutstanding(**백만 주 단위**) × 1e6.
 * 반환은 정수 문자열(numeric(20,0)) 또는 키 부재/파싱 실패 시 null. 백만→주 변환은 정수화(반올림).
 */
export async function fetchUsShares(symbol: string): Promise<string | null> {
  if (!isFinnhubRestEnabled()) return null;
  const url = new URL(FINNHUB_REST_BASE + PROFILE2_PATH);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", finnhubKey()!);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`finnhub profile2 HTTP ${res.status}`); // 본문(토큰 포함 가능) 로그 금지(B6)
  const json = (await res.json()) as { shareOutstanding?: number };
  return millionsToShares(json.shareOutstanding);
}

/** 백만 주 단위 실수 → 주 단위 정수 문자열. 비수치·0·음수는 null. */
export function millionsToShares(millions: unknown): string | null {
  const m = Number(millions);
  if (!Number.isFinite(m) || m <= 0) return null;
  return Math.round(m * 1e6).toString();
}

function providerEnabled(market: Market): boolean {
  return market === "KR" ? isKisRestEnabled() : isFinnhubRestEnabled();
}

async function fetchShares(market: Market, symbol: string): Promise<string | null> {
  return market === "KR" ? fetchKrShares(symbol) : fetchUsShares(symbol);
}

/** 단일 종목 UPSERT — shares_outstanding만 SET(가격 컬럼 불변). instruments는 부팅 시드로 이미 존재. */
async function upsertShares(db: Db, market: Market, symbol: string, shares: string): Promise<void> {
  await db
    .update(instruments)
    .set({ sharesOutstanding: shares })
    .where(sql`${instruments.market} = ${market} and ${instruments.symbol} = ${symbol}`);
}

/**
 * shares_outstanding 적재 — onlyMissing=true면 아직 NULL인 종목만(부팅용, DB 재접촉 최소화).
 * 전 UNIVERSE 순회, 시장별 provider 키 있는 종목만. KIS는 kisRest throttle이 페이싱 담당.
 * 심볼 1개 실패는 다음 심볼로(전체 중단 없음). 키리스/DB 없음이면 상위에서 걸러져 no-op.
 */
export async function syncSharesOutstanding(
  db: Db,
  opts: { onlyMissing?: boolean } = {},
): Promise<{ fetched: number; skipped: number; errors: number }> {
  const out = { fetched: 0, skipped: 0, errors: 0 };
  let missing: Set<string> | null = null;
  if (opts.onlyMissing) {
    const rows = (await db
      .select({ market: instruments.market, symbol: instruments.symbol })
      .from(instruments)
      .where(sql`${instruments.sharesOutstanding} is null`)) as { market: Market; symbol: string }[];
    missing = new Set(rows.map((r) => `${r.market}:${r.symbol}`));
  }
  for (const e of UNIVERSE) {
    if (!providerEnabled(e.market)) continue;
    if (missing && !missing.has(`${e.market}:${e.symbol}`)) {
      out.skipped++;
      continue;
    }
    try {
      const shares = await fetchShares(e.market, e.symbol);
      if (shares == null) {
        out.skipped++;
        continue;
      }
      await upsertShares(db, e.market, e.symbol, shares);
      out.fetched++;
    } catch (err) {
      out.errors++;
      console.error(`[shares] ${e.market}:${e.symbol} 적재 실패`, err);
    }
  }
  return out;
}

// parseShares는 kisRest에서 재사용(KR·테스트 공용) — 배럴 노출 없이 직접 임포트.
export { parseShares };
