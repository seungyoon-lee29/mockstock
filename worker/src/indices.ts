// 홈 인덱스 스트립 폴러 (T-index) — KR·US 모두 Yahoo Finance 차트 API로 실제 지수(지연) 폴링.
// DB 미접촉(B13): 외부 API만 호출해 메모리에 최신 IndexQuote 보관, /indices가 메모리를 읽어 서빙.
// 키 불필요(Yahoo 무키). 폴 실패 종목은 직전값 유지(마지막 종가). 비공식 API라 best-effort.
import { INDICES, type IndexQuote, type IndicesPayload, type Market } from "@mockstock/shared";
import { envInt } from "./candles/kisRest";
import { fetchYahooIndexQuote } from "./feeds/yahoo";

const POLL_MS_DEFAULT = 20_000;

// 시장별 최신 스냅샷(메모리 단일 소스). 폴 성공 시에만 교체 — 실패 시 직전값(마지막 종가) 유지.
const latest: IndicesPayload = { KR: [], US: [] };

let timer: ReturnType<typeof setInterval> | undefined;

/** 한 시장 1라운드 — Yahoo 실제 지수(^KS11/^KQ11/^GSPC/^IXIC) 지연 시세 순차 폴. 실패 종목은 스킵. */
async function pollMarket(market: Market): Promise<void> {
  const out: IndexQuote[] = [];
  for (const def of INDICES[market]) {
    try {
      const q = await fetchYahooIndexQuote(`^${def.key}`); // key 스템에 ^ 접두 → "^KS11"
      if (q) out.push({ ...def, ...q, ts: Date.now() });
    } catch (e) {
      console.warn(`[indices] ${market} ${def.label} 폴 실패`, (e as Error).message);
    }
  }
  if (out.length) latest[market] = out; // 전부 실패면 직전값 유지
}

async function pollAll(): Promise<void> {
  await Promise.all([pollMarket("KR"), pollMarket("US")]);
}

/** 부팅 시 시작 — 즉시 1회 + INDEX_POLL_MS 간격 폴링. */
export function startIndices(): void {
  void pollAll(); // 부팅 즉시 1회
  const ms = envInt("INDEX_POLL_MS", POLL_MS_DEFAULT);
  timer = setInterval(() => void pollAll(), ms);
  timer.unref?.();
}

export function stopIndices(): void {
  if (timer) clearInterval(timer);
}

/** /indices 핸들러용 — 메모리의 최신 스냅샷(복사본). DB 미접촉. */
export function getIndices(): IndicesPayload {
  return { KR: [...latest.KR], US: [...latest.US] };
}
