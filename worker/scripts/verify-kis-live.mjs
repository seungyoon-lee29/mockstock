// KIS 키/도메인 검증 스모크 — 실전 키로 전환한 뒤 일·분봉이 실제로 동작하는지 1회 확인용.
// 실행: node worker/scripts/verify-kis-live.mjs   (worker/.env 를 읽는다)
//
// 두 TR을 친다:
//   · 지수 일봉 FHPUP02120000  — KR 지수 라인차트 소스. newest 날짜가 '오늘 근처'면 실데이터.
//   · 종목 분봉 FHKST03010230  — 모의(VTS) 키를 실전 도메인에서 쓰면 EGW02004로 거부되는 카나리.
// 둘 다 rt_cd=0 이고 지수 newest 날짜가 최근이면 실전 키+실전 도메인 정상. 시크릿은 출력하지 않는다.
import fs from "node:fs";

const envPath = new URL("../.env", import.meta.url);
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const BASE = env.KIS_REST_BASE || "https://openapi.koreainvestment.com:9443";
const KEY = env.KIS_APP_KEY;
const SECRET = env.KIS_APP_SECRET;
const isVts = BASE.includes("openapivts");
console.log(`도메인: ${BASE} (${isVts ? "모의투자 VTS" : "실전 LIVE"})`);

if (!KEY || !SECRET) {
  console.log("✗ KIS_APP_KEY / KIS_APP_SECRET 미설정");
  process.exit(1);
}

const tok = await fetch(`${BASE}/oauth2/tokenP`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ grant_type: "client_credentials", appkey: KEY, appsecret: SECRET }),
})
  .then((r) => r.json())
  .catch((e) => ({ err: e.message }));
const AT = tok.access_token;
console.log(`tokenP: ${AT ? "OK" : "✗ " + JSON.stringify(tok)}`);
if (!AT) process.exit(1);

const ymd = (d) => new Date(d).toISOString().slice(0, 10).replaceAll("-", "");
const now = Date.now();

async function call(label, tr, path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${AT}`,
      appkey: KEY,
      appsecret: SECRET,
      tr_id: tr,
      custtype: "P",
    },
  });
  const j = await res.json();
  const rows = j.output2 || [];
  console.log(`${label} (${tr}): HTTP ${res.status} rt_cd=${j.rt_cd} ${j.msg1 || ""} rows=${rows.length}`);
  return { ok: j.rt_cd === "0", rows, msg: j.msg1, code: j.msg_cd };
}

// 지수 일봉 — newest 날짜 확인.
const idx = await call("지수 일봉", "FHPUP02120000", "/uapi/domestic-stock/v1/quotations/inquire-index-daily-price", {
  FID_COND_MRKT_DIV_CODE: "U",
  FID_INPUT_ISCD: "0001",
  FID_INPUT_DATE_1: ymd(now - 30 * 86400000),
  FID_INPUT_DATE_2: ymd(now),
  FID_PERIOD_DIV_CODE: "D",
});
const newest = idx.rows[0]?.stck_bsop_date;
if (newest) {
  const daysOld = Math.round((now - Date.parse(`${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6, 8)}`)) / 86400000);
  console.log(`  newest=${newest} (${daysOld}일 전) → ${daysOld <= 5 ? "캘린더-현재(실데이터)" : "시프트됨(모의 시뮬레이션)"}`);
}

await new Promise((r) => setTimeout(r, 700)); // KIS 2/s 여유

// 종목 분봉 — 모의키/실전도메인 카나리(EGW02004면 아직 모의 키).
const min = await call("종목 분봉", "FHKST03010230", "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice", {
  FID_COND_MRKT_DIV_CODE: "J",
  FID_INPUT_ISCD: "005930",
  FID_INPUT_DATE_1: ymd(now),
  FID_INPUT_HOUR_1: "153000",
  FID_PW_DATA_INCU_YN: "N",
  FID_FAKE_TICK_INCU_YN: "N",
});

console.log("\n== 판정 ==");
if (idx.ok && min.ok && newest && (now - Date.parse(`${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6, 8)}`)) / 86400000 <= 5) {
  console.log("✓ 실전 키+실전 도메인 정상 — KR 캔들이 캘린더-현재. US(Alpaca)와 날짜 정렬됨.");
} else if (min.code === "EGW02004") {
  console.log("✗ 분봉 EGW02004 — 모의(VTS) 키를 실전 도메인에서 사용 중. 실전 앱키로 교체 필요.");
} else {
  console.log("△ 부분 동작 — 위 rt_cd/newest 확인. 모의 키면 지수 일봉만 시뮬레이션 데이터로 통과함.");
}
