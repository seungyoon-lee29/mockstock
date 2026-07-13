// Finnhub WS 피드 (US) — 단일 커넥션으로 US 유니버스 전 구독, source:"finnhub" (B4).
// 정규장 외 틱은 shared/calendar 판정으로 폐기(B5). 끊김 시 지수 백오프 재연결.
// Node 22 내장 WebSocket 글로벌 사용 — 의존성 없음.
import { UNIVERSE, type Market, type Tick } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import type { Feed } from "./types";

const WS_ENDPOINT = "wss://ws.finnhub.io";
const REST_BASE = "https://finnhub.io/api/v1";
const QUOTE_TIMEOUT_MS = 5_000; // /quote 폴 상한 — 인덱스 폴러가 걸리지 않게
const MAX_SYMBOLS = 50; // Finnhub 커넥션당 구독 한도
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

interface FinnhubTrade {
  s: string; // symbol
  p: number; // price
  t: number; // epoch ms
  v: number; // volume
}

/**
 * Finnhub REST /quote — ETF/심볼 현재값. 인덱스 폴러(US)가 SPY/QQQ를 프록시로 조회한다.
 * 필드: c(현재가) d(전일대비) dp(전일대비%). 키(FINNHUB_API_KEY)는 워커 env 전용(B6/B14).
 * 키 없거나 값 미확보(장 시작 전 c=0 등)면 null → 호출부 fail-soft. 로그에 키·응답본문 노출 금지.
 */
export async function fetchFinnhubQuote(
  symbol: string,
): Promise<{ value: number; change: number; changePct: number } | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const url = new URL(`${REST_BASE}/quote`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", key);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { c?: number; d?: number; dp?: number };
    const value = Number(j.c);
    const change = Number(j.d);
    const changePct = Number(j.dp);
    if (!Number.isFinite(value) || value === 0) return null; // c=0 = 데이터 없음(장 시작 전 등)
    return { value, change: Number.isFinite(change) ? change : 0, changePct: Number.isFinite(changePct) ? changePct : 0 };
  } catch {
    return null; // 타임아웃·네트워크 실패 → fail-soft
  } finally {
    clearTimeout(t);
  }
}

export class FinnhubFeed implements Feed {
  readonly market: Market = "US";
  private readonly symbols: string[];
  private ws: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly apiKey: string) {
    const us = UNIVERSE.filter((e) => e.market === "US").map((e) => e.symbol);
    if (us.length > MAX_SYMBOLS) {
      console.warn(`[finnhub] US 유니버스 ${us.length}종목 > 한도 ${MAX_SYMBOLS} — 앞 ${MAX_SYMBOLS}개만 구독`);
    }
    this.symbols = us.slice(0, MAX_SYMBOLS);
  }

  start(onTick: (tick: Tick) => void): void {
    this.connect(onTick);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private connect(onTick: (tick: Tick) => void): void {
    const ws = new WebSocket(`${WS_ENDPOINT}/?token=${this.apiKey}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      for (const symbol of this.symbols) {
        ws.send(JSON.stringify({ type: "subscribe", symbol }));
      }
      console.log(`[finnhub] 연결 성공 — ${this.symbols.length}종목 구독`);
    };

    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: FinnhubTrade[] };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // 비JSON 프레임 무시
      }
      if (msg.type !== "trade" || !Array.isArray(msg.data)) return; // ping 등 무시
      for (const d of msg.data) {
        if (!isMarketOpen("US", new Date(d.t))) continue; // 프리/애프터마켓 틱 폐기(B5)
        onTick({ market: "US", symbol: d.s, price: d.p, ts: d.t, source: "finnhub" });
      }
    };

    // 오류 시 close가 뒤따르므로 재연결 스케줄은 onclose에서만 (중복 방지).
    ws.onerror = (ev) => {
      console.warn(`[finnhub] WS 오류: ${(ev as { message?: string }).message ?? ev.type}`);
    };

    ws.onclose = () => {
      if (this.stopped) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
      this.attempt += 1;
      console.warn(`[finnhub] 연결 끊김 — ${delay}ms 후 재연결 (시도 ${this.attempt})`);
      this.retryTimer = setTimeout(() => this.connect(onTick), delay);
      this.retryTimer.unref?.();
    };
  }
}
