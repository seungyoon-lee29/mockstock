// Yahoo Finance 차트 API(비공식) — 미국 실제 지수(^GSPC·^IXIC) 지연 시세/일봉.
// SPY/QQQ ETF가 아니라 진짜 지수값이 필요해서(사용자 요청, 지연 허용) 사용. 키 불필요.
//  · 비공식 엔드포인트라 best-effort: 실패·비200·파싱오류는 null/[](호출부 fail-soft — UI "—"/빈 차트).
//    단 fail-soft로 강등하기 전 원인(심볼·range·status/예외)을 한 줄 로그로 남긴다(무음 실패 방지).
//  · 일봉은 무거운 range(1y)만 프로덕션 호스트에서 실패하는 사례가 있어 DAILY_RANGE_FALLBACK 사다리로
//    점점 가벼운 range를 재시도한다(quote용 range=5d는 별도 — 영향 없음).
//  · 지수는 거래량이 의미 없어 v=0. date는 거래소(ET) 로컬 거래일(DailyCandle 계약).
// 심볼은 INDICES.US key 스템(GSPC/IXIC)에 ^ 접두 — 예: "^GSPC".
import type { DailyCandle } from "@mockstock/shared";

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const TIMEOUT_MS = 5_000;
const UA = "Mozilla/5.0 (compatible; mockstock/1.0)"; // Yahoo는 기본 UA 차단 — 명시 필요.
// 일봉 range 폴백 사다리 — 무거운 순 → 가벼운 순. 첫 range부터 시도해 빈 결과면 다음으로.
const DAILY_RANGE_FALLBACK = ["1y", "6mo", "3mo", "1mo"] as const;

interface YahooResult {
  timestamp?: number[];
  meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number };
  indicators?: {
    quote?: {
      open?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      close?: (number | null)[];
      volume?: (number | null)[];
    }[];
  };
}
interface YahooChart {
  chart?: { result?: YahooResult[] };
}

async function fetchChart(symbol: string, range: string): Promise<YahooResult | null> {
  const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
    if (!res.ok) {
      console.error(`[yahoo] fetchChart 실패 — symbol=${symbol} range=${range} status=${res.status}`);
      return null;
    }
    const json = (await res.json()) as YahooChart;
    return json.chart?.result?.[0] ?? null;
  } catch (e) {
    // 타임아웃·네트워크·파싱 실패 → fail-soft(null). 원인은 로그로만 남긴다.
    console.error(`[yahoo] fetchChart 실패 — symbol=${symbol} range=${range} 예외=${(e as Error)?.name ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type YahooIndexQuote = { value: number; change: number; changePct: number };

/** 지수 현재값(지연) — meta.regularMarketPrice + 전일종가로 등락 산출. 실패 시 null. */
export async function fetchYahooIndexQuote(symbol: string): Promise<YahooIndexQuote | null> {
  const r = await fetchChart(symbol, "5d");
  const value = r?.meta?.regularMarketPrice;
  const prev = r?.meta?.chartPreviousClose ?? r?.meta?.previousClose;
  if (typeof value !== "number" || typeof prev !== "number" || prev === 0) return null;
  const change = value - prev;
  return { value, change, changePct: (change / prev) * 100 };
}

/** ET 로컬 거래일 "YYYY-MM-DD"(DailyCandle.date 계약). */
function etDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * 지수 일봉 — 날짜 오름차순 DailyCandle[]. v=0(지수 거래량 무의미).
 * DAILY_RANGE_FALLBACK을 순서대로 시도해 캔들이 나오는 첫 range를 쓴다. 전부 실패 시 [](fail-soft 유지).
 */
export async function fetchYahooIndexDaily(symbol: string): Promise<DailyCandle[]> {
  for (const range of DAILY_RANGE_FALLBACK) {
    const r = await fetchChart(symbol, range);
    const ts = r?.timestamp;
    const q = r?.indicators?.quote?.[0];
    if (!ts || !q) continue;
    const out: DailyCandle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue; // 휴장·결측 캔들 스킵
      out.push({ date: etDate(ts[i] * 1_000), o, h, l, c, v: 0 }); // Yahoo는 이미 오름차순
    }
    if (out.length > 0) {
      if (range !== DAILY_RANGE_FALLBACK[0]) {
        console.warn(`[yahoo] fetchYahooIndexDaily — symbol=${symbol} range=${range}로 폴백 성공`);
      }
      return out;
    }
  }
  return []; // 사다리 전부 실패 → fail-soft
}
