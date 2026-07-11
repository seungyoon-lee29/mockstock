// KIS REST 클라이언트 (KR 과거 캔들 백필·일봉 동기화 — 멀티 타임프레임 v2 배치 B).
// tokenP 매니저는 feeds/kis.ts의 WS approval_key와 **완전 분리**(별도 자격 경로, 상호작용 없음).
//  - 24h 인메모리 캐시 + 재발급 1분 스로틀(EGW00133 가드) + 401 시 1회 갱신 재시도.
//  - 레이트: KIS_REST_RPS(기본 2 — 실측 계정 한도 초당 2건) — 최소 간격 직렬화로 초당 호출 상한(토큰버킷 등가).
//    초과 시 KIS는 EGW00201("초당 거래건수 초과")을 HTTP 500으로 거부 — kisGet이 1회 재시도.
//  - 키(KIS_APP_KEY/SECRET) 부재 시 모듈 비활성 — 호출부는 빈 배열을 받는다(fail-soft).
// 도메인은 KIS_REST_BASE(기본 실전). 모의(VTS) 앱키는 실전 도메인에서 분봉 TR(FHKST03010230)이
// EGW02004로 거부됨(일봉은 허용) — 모의 키면 KIS_REST_BASE를 VTS(openapivts...:29443)로 설정할 것.
// VTS 도메인에서 일·분봉 모두 정상 동작 실측(2026-07-11).
import type { DailyCandle, IntradayCandle } from "@mockstock/shared";

/** env 정수 파서(지연 읽기 — 테스트에서 env 주입 가능). 비수치·미설정은 기본값. */
export function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1_000; // access_token 24h 캐시(KIS 발급 주기와 동일)
const REISSUE_THROTTLE_MS = 60_000; // 재발급 1분 스로틀 — EGW00133(1분내 재발급 거부) 가드
const TOKEN_PATH = "/oauth2/tokenP";
const DAILY_PATH = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"; // FHKST03010100
const MINUTES_PATH = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice"; // FHKST03010230
const KIS_REST_BASE_DEFAULT = "https://openapi.koreainvestment.com:9443"; // 실전 도메인

function restBase(): string {
  return process.env.KIS_REST_BASE || KIS_REST_BASE_DEFAULT;
}
function appKey(): string | null {
  return process.env.KIS_APP_KEY || null;
}
function appSecret(): string | null {
  return process.env.KIS_APP_SECRET || null;
}

/** 키 존재 여부 — false면 fetch류가 전부 빈 배열(호출부 fail-soft). */
export function isKisRestEnabled(): boolean {
  return !!(appKey() && appSecret());
}

// ── tokenP 매니저 (모듈 상태 — WS approval_key와 무관) ─────────────────────
let token: string | null = null;
let tokenAt = 0;
let lastIssueAt = 0;
let issuing: Promise<string> | null = null;
let nextCallAt = 0; // 레이트 리미터 커서

/** 테스트 전용 — 토큰·스로틀·레이트 상태 초기화. */
export function _resetKisRestForTest(): void {
  token = null;
  tokenAt = 0;
  lastIssueAt = 0;
  issuing = null;
  nextCallAt = 0;
}

async function issueToken(): Promise<string> {
  lastIssueAt = Date.now();
  await throttle(); // tokenP도 초당 건수에 포함 — 슬롯을 선점해 직후 TR과 같은 초에 몰리지 않게
  const res = await fetch(`${restBase()}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey(), appsecret: appSecret() }),
  });
  if (!res.ok) throw new Error(`kis tokenP HTTP ${res.status}`); // 본문(키 포함 가능)은 로그 금지(B6)
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("kis tokenP access_token 응답 없음");
  token = json.access_token;
  tokenAt = Date.now();
  return token;
}

async function getToken(): Promise<string> {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  if (issuing) return issuing; // 동시 요청 합치기 — 중복 발급 방지
  if (Date.now() - lastIssueAt < REISSUE_THROTTLE_MS) {
    if (token) return token; // 스로틀 중엔 만료 임박 토큰이라도 재사용(EGW00133 회피)
    throw new Error("kis tokenP 재발급 스로틀 중(1분) — 잠시 후 재시도");
  }
  issuing = issueToken().finally(() => {
    issuing = null;
  });
  return issuing;
}

function restIntervalMs(): number {
  return 1_000 / envInt("KIS_REST_RPS", 2);
}

/** KIS_REST_RPS 기반 최소 간격 직렬화 — 초당 호출 수 상한(토큰버킷 등가, 버스트 없음). */
async function throttle(): Promise<void> {
  const interval = restIntervalMs();
  const now = Date.now();
  const at = Math.max(now, nextCallAt);
  nextCallAt = at + interval;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** 에러 응답 본문에서 msg_cd/msg1 추출 — JSON이 아니면 빈 값(TR 응답 한정, tokenP 본문엔 사용 금지). */
function parseKisErrorBody(text: string): { msgCd: string; msg1: string } {
  try {
    const j = JSON.parse(text) as { msg_cd?: string; msg1?: string };
    return { msgCd: j.msg_cd ?? "", msg1: j.msg1 ?? "" };
  } catch {
    return { msgCd: "", msg1: "" };
  }
}

/** 공통 GET — 인증 헤더 + 401 시 토큰 1회 갱신 재시도 + EGW00201 1회 재시도 + rt_cd 검사. */
async function kisGet(path: string, trId: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let tok = await getToken(); // 토큰 먼저 — 발급 지연이 fetch 간 간격을 압축하지 않게 스로틀은 fetch 직전에
  const url = new URL(restBase() + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = (t: string) => ({
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${t}`,
    appkey: appKey()!,
    appsecret: appSecret()!,
    tr_id: trId,
    custtype: "P", // 개인
  });
  await throttle();
  let res = await fetch(url, { headers: headers(tok) });
  if (res.status === 401) {
    token = null; // 무효화 → 1회 갱신 재시도(스로틀 내 재발급이면 getToken이 던짐 — 그대로 전파)
    tok = await getToken();
    await throttle();
    res = await fetch(url, { headers: headers(tok) });
  }
  if (!res.ok) {
    let { msgCd, msg1 } = parseKisErrorBody(await res.text().catch(() => ""));
    if (msgCd === "EGW00201") {
      // 초당 건수 초과(HTTP 500) — 고정 대기 후 1회만 재시도. 재시도도 throttle 경유(2/초 불변식 유지)
      await new Promise((r) => setTimeout(r, envInt("KIS_RETRY_WAIT_MS", 1_100)));
      await throttle();
      res = await fetch(url, { headers: headers(tok) });
      if (!res.ok) ({ msgCd, msg1 } = parseKisErrorBody(await res.text().catch(() => "")));
    }
    if (!res.ok) throw new Error(`kis ${trId} HTTP ${res.status} ${msgCd} ${msg1}`.trim());
  }
  const json = (await res.json()) as { rt_cd?: string; msg_cd?: string; msg1?: string };
  if (json.rt_cd !== undefined && json.rt_cd !== "0") {
    throw new Error([`kis ${trId} rt_cd=${json.rt_cd}`, json.msg_cd, json.msg1].filter(Boolean).join(" "));
  }
  return json as Record<string, unknown>;
}

/** "YYYYMMDD" → "YYYY-MM-DD". */
function isoDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** KST "YYYYMMDD"+"HHMMSS" → epoch 초 (KST = UTC+9 고정, DST 없음). */
function kstEpochSec(ymd: string, hms: string): number {
  return (
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(4, 6)) - 1,
      Number(ymd.slice(6, 8)),
      Number(hms.slice(0, 2)) - 9,
      Number(hms.slice(2, 4)),
      Number(hms.slice(4, 6)),
    ) / 1_000
  );
}

type KisDailyRow = {
  stck_bsop_date?: string; // 영업일자 YYYYMMDD
  stck_oprc?: string; // 시가
  stck_hgpr?: string; // 고가
  stck_lwpr?: string; // 저가
  stck_clpr?: string; // 종가
  acml_vol?: string; // 누적거래량
};

/**
 * 국내주식 기간별시세 일봉(FHKST03010100, FID_PERIOD_DIV_CODE=D, 수정주가 FID_ORG_ADJ_PRC=0).
 * 콜당 최대 100건(최신부터 역순) — 반환은 날짜 오름차순 DailyCandle[]. 키 없으면 [].
 */
export async function fetchKrDaily(symbol: string, fromYmd: string, toYmd: string): Promise<DailyCandle[]> {
  if (!isKisRestEnabled()) return [];
  const json = await kisGet(DAILY_PATH, "FHKST03010100", {
    FID_COND_MRKT_DIV_CODE: "J", // 주식
    FID_INPUT_ISCD: symbol,
    FID_INPUT_DATE_1: fromYmd,
    FID_INPUT_DATE_2: toYmd,
    FID_PERIOD_DIV_CODE: "D",
    FID_ORG_ADJ_PRC: "0", // 0=수정주가
  });
  const rows = (json.output2 ?? []) as KisDailyRow[];
  const out: DailyCandle[] = [];
  for (const r of rows) {
    if (!r?.stck_bsop_date) continue; // KIS는 빈 로우({})로 패딩하는 경우가 있음 — 방어
    const o = Number(r.stck_oprc);
    const h = Number(r.stck_hgpr);
    const l = Number(r.stck_lwpr);
    const c = Number(r.stck_clpr);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    const v = Number(r.acml_vol);
    out.push({ date: isoDate(r.stck_bsop_date), o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1)); // 역순 응답 → 오름차순
  return out;
}

type KisMinuteRow = {
  stck_bsop_date?: string; // 영업일자 YYYYMMDD
  stck_cntg_hour?: string; // 체결시간 HHMMSS(분봉 라벨)
  stck_oprc?: string;
  stck_hgpr?: string;
  stck_lwpr?: string;
  stck_prpr?: string; // 분봉 종가(현재가)
  cntg_vol?: string; // 분 거래량
};

/**
 * 주식일별분봉조회(FHKST03010230) — dateYmd 하루 안에서 hhmmss 이하 최근 120건(역순).
 * 반환은 time(epoch 초) 오름차순 IntradayCandle[]. 키 없으면 [].
 * 시간 라벨: stck_cntg_hour는 **버킷 시작 라벨**(확정 — 2026-07-10분 VTS 실호출에서
 * 개장 경계 로우가 090000으로 시작, 개장 동시호가 거래량 포함. 종료 라벨이면 최소가 090100이어야 함).
 * 따라서 kstEpochSec 그대로 사용, 60초 보정 불필요. VTS 실측 — 실전 도메인 동일성 미확인.
 */
export async function fetchKrMinutes(symbol: string, dateYmd: string, hhmmss: string): Promise<IntradayCandle[]> {
  if (!isKisRestEnabled()) return [];
  const json = await kisGet(MINUTES_PATH, "FHKST03010230", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: symbol,
    FID_INPUT_DATE_1: dateYmd,
    FID_INPUT_HOUR_1: hhmmss,
    // 아래 2개 필드명은 의미 미검증 — rt_cd 0으로 호출은 성공하나(2026-07-11 VTS) 게이트웨이가
    // 미지 파라미터를 조용히 무시해도 같은 결과. 확정하려면 Y/N 토글 응답 비교 필요.
    FID_PW_DATA_INCU_YN: "N", // 의도: 과거 데이터 미포함
    FID_FAKE_TICK_INCU_YN: "N", // 의도: 허봉 미포함
  });
  const rows = (json.output2 ?? []) as KisMinuteRow[];
  const out: IntradayCandle[] = [];
  for (const r of rows) {
    if (!r?.stck_bsop_date || !r.stck_cntg_hour) continue;
    const o = Number(r.stck_oprc);
    const h = Number(r.stck_hgpr);
    const l = Number(r.stck_lwpr);
    const c = Number(r.stck_prpr);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    const v = Number(r.cntg_vol);
    out.push({ time: kstEpochSec(r.stck_bsop_date, r.stck_cntg_hour), o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  out.sort((a, b) => a.time - b.time); // 역순 응답 → 오름차순
  return out;
}
