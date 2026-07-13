// 홈 인덱스 스트립 폴러 (T-index) — KR=KIS 업종지수 REST, US=Finnhub /quote REST.
// DB 미접촉(B13): 외부 API만 호출해 메모리에 최신 IndexQuote 보관, /indices가 메모리를 읽어 서빙.
// 키 없으면 해당 시장 폴링 스킵 → 빈 배열(UI "—"). mock 인덱스 값은 만들지 않는다(v1 확정).
// KIS 콜은 kisRest.fetchKrIndex(=kisGet→throttle) 경유라 캔들 백필과 초당 2건 상한을 공유한다.
import { INDICES, type IndexQuote, type IndicesPayload } from "@mockstock/shared";
import { config } from "./config";
import { envInt, fetchKrIndex, isKisRestEnabled } from "./candles/kisRest";
import { fetchFinnhubQuote } from "./feeds/finnhub";

const POLL_MS_DEFAULT = 20_000;

// 시장별 최신 스냅샷(메모리 단일 소스). 폴 성공 시에만 교체 — 실패 시 직전값(마지막 종가) 유지.
const latest: IndicesPayload = { KR: [], US: [] };

let timer: ReturnType<typeof setInterval> | undefined;

/** KR 인덱스 1라운드 — KIS 업종지수 순차 폴(throttle이 초당 2건 보장). 실패 종목은 스킵. */
async function pollKr(): Promise<void> {
  if (!isKisRestEnabled()) return; // 키 없음 → 스킵(빈 배열 유지)
  const out: IndexQuote[] = [];
  for (const def of INDICES.KR) {
    try {
      const q = await fetchKrIndex(def.key);
      if (q) out.push({ ...def, ...q, ts: Date.now() });
    } catch (e) {
      console.warn(`[indices] KR ${def.label} 폴 실패`, (e as Error).message);
    }
  }
  if (out.length) latest.KR = out; // 전부 실패면 직전값 유지(마지막 종가)
}

/** US 인덱스 1라운드 — Finnhub /quote 순차 폴. 실패 종목은 스킵. */
async function pollUs(): Promise<void> {
  if (!config.finnhubApiKey) return; // 키 없음 → 스킵
  const out: IndexQuote[] = [];
  for (const def of INDICES.US) {
    try {
      const q = await fetchFinnhubQuote(def.key);
      if (q) out.push({ ...def, ...q, ts: Date.now() });
    } catch (e) {
      console.warn(`[indices] US ${def.label} 폴 실패`, (e as Error).message);
    }
  }
  if (out.length) latest.US = out;
}

async function pollAll(): Promise<void> {
  await Promise.all([pollKr(), pollUs()]);
}

/** 부팅 시 시작 — 즉시 1회 + INDEX_POLL_MS 간격 폴링. 키 없는 시장은 내부에서 스킵. */
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
