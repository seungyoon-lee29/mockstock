// KIS WS 피드 (KR) — 세션당 41건 한도 내 실시간체결가(H0STCNT0)만 구독, source:"kis" (B4).
// 정규장 외 틱은 shared/calendar 판정으로 폐기(B5). 끊김 시 지수 백오프 재연결.
// approval_key(WS 전용, REST access_token과 별개)만 발급 — 읽기전용 시세라 AES 복호화 불필요.
// Node 22 내장 WebSocket/fetch 글로벌 사용 — 의존성 없음. 시크릿·키 값은 로그에 노출 금지(B6/B14).
import { UNIVERSE, type Market, type Tick } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import type { Feed } from "./types";

// 모의투자(VTS) 도메인 — 실전 아님. approval_key REST 발급 + WS 접속.
const APPROVAL_ENDPOINT = "https://openapivts.koreainvestment.com:29443/oauth2/Approval";
const WS_ENDPOINT = "ws://ops.koreainvestment.com:31000"; // 모의(평문 ws). 실전은 :21000
const TR_ID_TRADE = "H0STCNT0"; // 국내주식 실시간체결가
const TR_TYPE_SUBSCRIBE = "1"; // 1=등록 2=해제
const TR_ID_PINGPONG = "PINGPONG";
const MAX_SYMBOLS = 41; // KIS WS 세션당 구독 한도
const RECORD_FIELDS = 46; // H0STCNT0 레코드당 필드 수 (다건이면 46*n 연쇄)
const F_CODE = 0; // 유가증권단축종목코드 (MKSC_SHRN_ISCD)
const F_PRICE = 2; // 주식현재가=체결가 (STCK_PRPR). [1]=체결시간 HHMMSS는 미사용
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000; // approval_key 24h 캐시(B6) — 재연결 시 재사용, 재발급 스로틀 겸용
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class KisFeed implements Feed {
  readonly market: Market = "KR";
  private readonly symbols: string[];
  private ws: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;
  private approvalKey: string | null = null;
  private approvalKeyAt = 0; // 발급 시각(epoch ms)

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
  ) {
    const kr = UNIVERSE.filter((e) => e.market === "KR").map((e) => e.symbol);
    if (kr.length > MAX_SYMBOLS) {
      console.warn(`[kis] KR 유니버스 ${kr.length}종목 > 한도 ${MAX_SYMBOLS} — 앞 ${MAX_SYMBOLS}개만 구독`);
    }
    this.symbols = kr.slice(0, MAX_SYMBOLS);
  }

  start(onTick: (tick: Tick) => void): void {
    void this.connect(onTick);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  // WS 전용키. 24h 캐시 — 재연결은 캐시 재사용이라 Approval 재요청이 자연 스로틀됨(B6).
  private async getApprovalKey(): Promise<string> {
    if (this.approvalKey && Date.now() - this.approvalKeyAt < APPROVAL_TTL_MS) return this.approvalKey;
    const res = await fetch(APPROVAL_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 주의: 필드명은 secretkey (REST tokenP의 appsecret 아님).
      body: JSON.stringify({ grant_type: "client_credentials", appkey: this.appKey, secretkey: this.appSecret }),
    });
    if (!res.ok) throw new Error(`approval HTTP ${res.status}`); // 본문(키 포함 가능)은 로그 금지
    const json = (await res.json()) as { approval_key?: string };
    if (!json.approval_key) throw new Error("approval_key 응답 없음");
    this.approvalKey = json.approval_key;
    this.approvalKeyAt = Date.now();
    return this.approvalKey;
  }

  private async connect(onTick: (tick: Tick) => void): Promise<void> {
    if (this.stopped) return;
    let key: string;
    try {
      key = await this.getApprovalKey();
    } catch (err) {
      this.scheduleReconnect(onTick, err);
      return;
    }

    const ws = new WebSocket(WS_ENDPOINT);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      for (const symbol of this.symbols) ws.send(subscribeFrame(key, symbol));
      console.log(`[kis] 연결 성공 — ${this.symbols.length}종목 구독`);
    };

    ws.onmessage = (ev) => this.handleFrame(String(ev.data), ws, onTick);

    // 오류 시 close가 뒤따르므로 재연결 스케줄은 onclose에서만 (중복 방지).
    ws.onerror = (ev) => {
      console.warn(`[kis] WS 오류: ${(ev as { message?: string }).message ?? ev.type}`);
    };

    ws.onclose = () => this.scheduleReconnect(onTick);
  }

  private handleFrame(raw: string, ws: WebSocket, onTick: (tick: Tick) => void): void {
    // raw[0] '0'(평문)/'1'(AES) → 실시간 데이터 프레임, 그 외 → JSON 제어 프레임.
    const flag = raw[0];
    if (flag === "0" || flag === "1") {
      const ts = Date.now(); // ponytail: 실시간 WS 수신시각≈체결시각. 신선도 게이트는 수신시각 기준이라 HHMMSS 변환 불필요
      if (!isMarketOpen("KR", new Date(ts))) return; // 정규장 외 틱 폐기(B5)
      for (const { symbol, price } of parseTradeFrame(raw)) {
        onTick({ market: "KR", symbol, price, ts, source: "kis" });
      }
      return;
    }

    // 제어 프레임(JSON): PINGPONG 에코 / 구독 제어응답.
    let msg: { header?: { tr_id?: string }; body?: { rt_cd?: string; msg1?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.header?.tr_id === TR_ID_PINGPONG) {
      ws.send(raw); // 받은 원문 그대로 에코(B6)
      return;
    }
    if (msg.body?.rt_cd && msg.body.rt_cd !== "0") {
      console.warn(`[kis] 구독 제어응답 오류: ${msg.body.msg1 ?? "unknown"}`);
    }
  }

  private scheduleReconnect(onTick: (tick: Tick) => void, err?: unknown): void {
    if (this.stopped) return;
    if (err) console.warn(`[kis] approval 발급 실패: ${err instanceof Error ? err.message : String(err)}`);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    console.warn(`[kis] 연결 끊김 — ${delay}ms 후 재연결 (시도 ${this.attempt})`);
    this.retryTimer = setTimeout(() => void this.connect(onTick), delay);
    this.retryTimer.unref?.();
  }
}

// H0STCNT0 데이터 프레임 파싱(순수 함수 — WS·시각·상태 무관, 회귀 테스트 대상).
// raw = flag|tr_id|data_cnt|body. flag '0'(평문)/'1'(AES)만 데이터, 그 외(JSON 제어)는 빈 배열.
// body = '^' 구분 필드, 레코드당 46필드(RECORD_FIELDS)가 data_cnt개 연쇄(다건이면 46*n 슬라이스).
// 필드 인덱스는 돈 정확성 경로 — [0]=단축종목코드, [2]=현재가(체결가). 절대 바꾸지 말 것.
export function parseTradeFrame(raw: string): { symbol: string; price: number }[] {
  const flag = raw[0];
  if (flag !== "0" && flag !== "1") return []; // 제어 프레임(PINGPONG 등)은 데이터 아님
  const parts = raw.split("|");
  if (parts[1] !== TR_ID_TRADE || parts[3] === undefined) return []; // H0STCNT0 아니면 폐기(AES 체결통보 등)
  const count = Number(parts[2]) || 0;
  const f = parts[3].split("^");
  const records: { symbol: string; price: number }[] = [];
  for (let n = 0; n < count; n++) {
    const base = n * RECORD_FIELDS;
    const symbol = f[base + F_CODE];
    const price = Number(f[base + F_PRICE]);
    if (!symbol || !Number.isFinite(price)) continue;
    records.push({ symbol, price });
  }
  return records;
}

// 체결가(H0STCNT0) 등록 프레임. tr_type "1"=등록.
function subscribeFrame(approvalKey: string, trKey: string): string {
  return JSON.stringify({
    header: { approval_key: approvalKey, custtype: "P", tr_type: TR_TYPE_SUBSCRIBE, "content-type": "utf-8" },
    body: { input: { tr_id: TR_ID_TRADE, tr_key: trKey } },
  });
}
