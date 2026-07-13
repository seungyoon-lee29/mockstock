#!/usr/bin/env node
// Alpaca Market Data → 리플레이 JSON 수집·변환기 (recent-daily · recent-3d-minute 시나리오).
//
// worker/src/candles/alpaca.ts 의 인증·엔드포인트 관용구를 미러링한다:
//   - GET https://data.alpaca.markets/v2/stocks/{symbol}/bars
//   - 헤더 APCA-API-KEY-ID / APCA-API-SECRET-KEY, adjustment=split, feed=iex(무료),
//   - next_page_token 페이지네이션. Basic 플랜 최근 15분 SIP 제한 → end를 now-16분 클램프.
//
// 사용법:
//   node --env-file=worker/.env scripts/replay/alpaca-to-replay-json.mjs
//   node --env-file=worker/.env scripts/replay/alpaca-to-replay-json.mjs --selftest
//
// 산출:
//   web/public/replay/recent-daily/<SYMBOL>.json   (DailyCandle[] {date,o,h,l,c,v}) + manifest.json
//   web/public/replay/recent-3d-minute/<SYMBOL>.json (IntradayCandle[] {time,o,h,l,c,v}) + manifest.json

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

// ── 벤더 고정값 (alpaca.ts 상수 미러) ──────────────────────────────────────────
const DATA_BASE = "https://data.alpaca.markets";
const FEED = "iex"; // 무료 피드 — 저유동 종목 분봉 공백은 정직한 갭
const ADJUSTMENT = "split";
const END_CLAMP_MS = 16 * 60 * 1_000; // 최근 15분 SIP 제한 + 여유 1분
const PAGE_LIMIT = 10_000;
const US_TZ = "America/New_York"; // 일봉 date = 거래소 로컬 거래일

// ── 시나리오 파라미터 (replay.ts 레지스트리와 개념 일치 — 여기선 데이터 생성만) ──────────
const SYMBOLS = ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","AMD","NFLX","JPM","V","DIS","KO","UBER","SBUX"];
const DAILY_MONTHS = 9;       // 최근 ~9개월 일봉
const WARMUP_MONTHS = 1;      // playPeriod 앞 워밍업(초기 시세 컨텍스트)
const REPORT_TAIL_MONTHS = 2; // 재생 구간 이후 "실제 역사" 꼬리
const MINUTE_SESSIONS = 3;    // 분봉: 최근 N 거래일
const MINUTE_LOOKBACK_DAYS = 10; // 3거래일을 커버할 캘린더 범위(주말·휴장 여유)
const SESSION_MINUTES = 390;  // 정규장 1일 분봉 수(09:30~16:00 ET) — 분봉 밀도 기준
const SPARSE_PER_DAY = 100;   // 하루 <100봉이면 희소 경고(스펙: 5분봉 대안 고려)

// ── 인증 (env only — CLAUDE.md 하드코딩 금지, worker/.env 경유) ──────────────────
function keyId() { return process.env.ALPACA_API_KEY_ID || null; }
function keySecret() { return process.env.ALPACA_API_SECRET_KEY || null; }

const DEFAULT_OUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public", "replay");

/** UTC epoch ms → ET 로컬 날짜 "YYYY-MM-DD" (en-CA 포맷이 ISO 순서). */
function etDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: US_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** UTC epoch ms → ET 자정 기준 분(09:30=570). 정규장 필터용(DST 자동 — tz 계산 경유). */
const REG_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const REG_CLOSE_MIN = 16 * 60; // 16:00 ET
function etMinutes(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: US_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const h = Number(p.find((x) => x.type === "hour").value);
  const m = Number(p.find((x) => x.type === "minute").value);
  return h * 60 + m;
}
/** 정규장(09:30~16:00 ET, 시작라벨 기준 [570,960)) 봉만 — IEX 프리/포스트마켓 봉 제외. */
function isRegularSession(ms) {
  const t = etMinutes(ms);
  return t >= REG_OPEN_MIN && t < REG_CLOSE_MIN;
}

/** bars 공통 fetch — end는 now-16분 클램프, next_page_token 전 페이지 순회(sort=asc). 레이트리밋 대비 페이지 간 소휴식. */
async function fetchBars(symbol, timeframe, startMs, endMs) {
  const clampedEnd = Math.min(endMs, Date.now() - END_CLAMP_MS);
  if (clampedEnd <= startMs) return [];
  const bars = [];
  let pageToken = null;
  do {
    const url = new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(clampedEnd).toISOString());
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("feed", FEED);
    url.searchParams.set("adjustment", ADJUSTMENT);
    url.searchParams.set("sort", "asc"); // 전 페이지 순회 → 오름차순 그대로 축적
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": keyId(), "APCA-API-SECRET-KEY": keySecret() },
    });
    if (res.status === 429) { // 무료 200/분 — 백오프 후 같은 페이지 재시도
      await sleep(3_000);
      continue;
    }
    if (!res.ok) throw new Error(`${symbol} ${timeframe}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const json = await res.json();
    bars.push(...(json.bars ?? []));
    pageToken = json.next_page_token ?? null;
    if (pageToken) await sleep(350); // 레이트리밋 여유(무료 200/분 → ~3.3/s)
  } while (pageToken);
  return bars;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 일봉 매핑 — date=ET 로컬 거래일. Alpaca 1Day t는 ET 자정(RFC3339). */
function toDaily(bars) {
  return bars.map((b) => ({ date: etDate(Date.parse(b.t)), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}
/** 분봉 매핑 — time=epoch 초(shared IntradayCandle 계약). */
function toIntraday(bars) {
  return bars.map((b) => ({ time: Math.floor(Date.parse(b.t) / 1_000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

/** OHLC sanity — 나쁜 데이터로 리플레이 오염 금지(stooq 변환기와 동일 규약). */
function sanityDaily(rows, symbol) {
  let prev = null;
  for (const r of rows) {
    if (!(r.o > 0 && r.h > 0 && r.l > 0 && r.c > 0)) throw new Error(`${symbol} ${r.date}: OHLC>0 위반`);
    if (!(r.l <= r.o && r.l <= r.c && r.l <= r.h && r.o <= r.h && r.c <= r.h)) throw new Error(`${symbol} ${r.date}: OHLC 관계 위반`);
    if (r.v < 0) throw new Error(`${symbol} ${r.date}: 거래량 음수`);
    if (prev != null && r.date <= prev) throw new Error(`${symbol} ${r.date}: 날짜 비단조/중복(이전 ${prev})`);
    prev = r.date;
  }
}
function sanityIntraday(rows, symbol) {
  let prev = null;
  for (const r of rows) {
    if (!(r.o > 0 && r.h > 0 && r.l > 0 && r.c > 0)) throw new Error(`${symbol} @${r.time}: OHLC>0 위반`);
    if (!(r.l <= r.o && r.l <= r.c && r.l <= r.h && r.o <= r.h && r.c <= r.h)) throw new Error(`${symbol} @${r.time}: OHLC 관계 위반`);
    if (prev != null && r.time <= prev) throw new Error(`${symbol} @${r.time}: time 비단조/중복(이전 ${prev})`);
    prev = r.time;
  }
}

// ── 시나리오 A: recent-daily ──────────────────────────────────────────────────
async function buildDaily(outRoot) {
  const outDir = join(outRoot, "recent-daily");
  mkdirSync(outDir, { recursive: true });
  const now = Date.now();
  const startMs = monthsAgo(now, DAILY_MONTHS);
  console.log(`\n=== recent-daily (최근 ${DAILY_MONTHS}개월 일봉) ===`);

  const perSymbol = [];
  let globalStart = null, globalEnd = null;
  for (const symbol of SYMBOLS) {
    const bars = await fetchBars(alpacaSym(symbol), "1Day", startMs, now);
    const rows = toDaily(bars);
    sanityDaily(rows, symbol);
    if (rows.length === 0) throw new Error(`${symbol}: 일봉 0개`);
    writeFileSync(join(outDir, `${symbol}.json`), JSON.stringify(rows));
    const s = rows[0].date, e = rows[rows.length - 1].date;
    if (!globalStart || s < globalStart) globalStart = s;
    if (!globalEnd || e > globalEnd) globalEnd = e;
    perSymbol.push({ symbol, count: rows.length, start: s, end: e });
    console.log(`  ✓ ${symbol.padEnd(6)} ${String(rows.length).padStart(4)}일  ${s}~${e}`);
    await sleep(350);
  }

  // playPeriod/reportTailPeriod 파생 — 실제 받은 범위 기준.
  // warmup(앞 1개월)은 재생 전 컨텍스트, reportTail(뒤 2개월)은 "실제 역사" 꼬리.
  const playStart = addMonthsIso(globalStart, WARMUP_MONTHS);
  const reportStart = addMonthsIso(globalEnd, -REPORT_TAIL_MONTHS);
  const manifest = {
    id: "recent-daily",
    name: "최근 시장 (일봉)",
    description: "최근 약 9개월 실제 일봉을 배속으로 재생하며 훈련합니다. 특정 사건이 아닌 '지금의 시장'입니다.",
    granularity: "day",
    dataPeriod: { start: globalStart, end: globalEnd, note: `warmup ${WARMUP_MONTHS}개월 포함 — 초기 시세 컨텍스트용` },
    playPeriod: { start: playStart, end: reportStart },
    reportTailPeriod: { start: reportStart, end: globalEnd },
    symbols: { US: SYMBOLS },
    source: { provider: "Alpaca", note: `data.alpaca.markets /v2/stocks/{sym}/bars 1Day feed=${FEED} adjustment=${ADJUSTMENT}`, fetchedAt: etDate(now) },
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  범위 ${globalStart}~${globalEnd} | play ${playStart}~${reportStart} | tail ${reportStart}~${globalEnd}`);
  return perSymbol;
}

// ── 시나리오 B: recent-3d-minute ──────────────────────────────────────────────
async function buildMinute(outRoot) {
  const outDir = join(outRoot, "recent-3d-minute");
  mkdirSync(outDir, { recursive: true });
  const now = Date.now();
  const startMs = now - MINUTE_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000;
  console.log(`\n=== recent-3d-minute (최근 ${MINUTE_SESSIONS}거래일 1분봉) ===`);

  const perSymbol = [];
  let globalStart = null, globalEnd = null;
  const densities = [];
  for (const symbol of SYMBOLS) {
    const bars = await fetchBars(alpacaSym(symbol), "1Min", startMs, now);
    let rows = toIntraday(bars);
    // 정규장(09:30~16:00 ET)만 — IEX 프리/포스트마켓 봉 제외(리플레이는 개장~마감 세션 기준).
    rows = rows.filter((r) => isRegularSession(r.time * 1_000));
    // 최근 MINUTE_SESSIONS 거래일만 — ET 로컬 날짜로 그룹핑해 마지막 N일 유지.
    const days = [...new Set(rows.map((r) => etDate(r.time * 1_000)))].sort();
    const keepDays = new Set(days.slice(-MINUTE_SESSIONS));
    rows = rows.filter((r) => keepDays.has(etDate(r.time * 1_000)));
    sanityIntraday(rows, symbol);
    if (rows.length === 0) throw new Error(`${symbol}: 분봉 0개`);
    writeFileSync(join(outDir, `${symbol}.json`), JSON.stringify(rows));
    const s = etDate(rows[0].time * 1_000), e = etDate(rows[rows.length - 1].time * 1_000);
    if (!globalStart || s < globalStart) globalStart = s;
    if (!globalEnd || e > globalEnd) globalEnd = e;
    const perDay = rows.length / keepDays.size;
    densities.push(perDay);
    perSymbol.push({ symbol, count: rows.length, days: keepDays.size, perDay, start: s, end: e });
    const flag = perDay < SPARSE_PER_DAY ? " ⚠희소" : "";
    console.log(`  ✓ ${symbol.padEnd(6)} ${String(rows.length).padStart(5)}봉 / ${keepDays.size}일 = ${perDay.toFixed(0)}/일 (기준 ${SESSION_MINUTES})${flag}  ${s}~${e}`);
    await sleep(350);
  }

  const manifest = {
    id: "recent-3d-minute",
    name: "최근 3거래일 (분봉)",
    description: "최근 3거래일 1분봉을 재생하며 초단기 매매를 훈련합니다.",
    granularity: "minute",
    dataPeriod: { start: globalStart, end: globalEnd },
    // 분봉은 전체 배열 재생(index 0..last) — playPeriod는 표시용 메타로만 채운다(플레이어가 무시).
    playPeriod: { start: globalStart, end: globalEnd },
    symbols: { US: SYMBOLS },
    source: { provider: "Alpaca", note: `data.alpaca.markets /v2/stocks/{sym}/bars 1Min feed=${FEED} adjustment=${ADJUSTMENT}`, fetchedAt: etDate(now) },
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const avg = densities.reduce((a, b) => a + b, 0) / densities.length;
  const sparse = densities.filter((d) => d < SPARSE_PER_DAY).length;
  console.log(`  범위 ${globalStart}~${globalEnd} | 평균 밀도 ${avg.toFixed(0)}/일 (정규장 ${SESSION_MINUTES}) | 희소(<${SPARSE_PER_DAY}) ${sparse}/${SYMBOLS.length}종목`);
  if (sparse > SYMBOLS.length / 2) console.log(`  ⚠ 절반 이상 희소 — 5분봉 집계 대안 고려(aggregateIntraday(rows,5)).`);
  return perSymbol;
}

// META: 2020 티커는 FB였으나 최근 데이터는 META로 승계됨 — 심볼 그대로.
function alpacaSym(symbol) { return symbol; }

// ── 날짜 헬퍼 (월 산술 — ET 무관 근사, 범위 파생용) ─────────────────────────────
function monthsAgo(ms, months) {
  const d = new Date(ms);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}
/** "YYYY-MM-DD"에 months(음수 가능) 더한 ISO 날짜. */
function addMonthsIso(iso, months) {
  const [y, m, day] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, day));
  return d.toISOString().slice(0, 10);
}

// ── 자체검증 (네트워크 없이 순수 로직만) ────────────────────────────────────────
function selftest() {
  // 매핑
  assert.deepEqual(
    toDaily([{ t: "2026-01-05T05:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }]),
    [{ date: "2026-01-05", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
    "일봉 매핑 불일치",
  );
  const iso = toIntraday([{ t: "2026-01-05T14:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
  assert.equal(iso[0].time, Math.floor(Date.parse("2026-01-05T14:30:00Z") / 1000), "분봉 time epoch 불일치");
  // sanity throw
  assert.throws(() => sanityDaily([{ date: "2026-01-05", o: 10, h: 9, l: 8, c: 9.5, v: 1 }], "X"), /OHLC 관계/);
  assert.throws(() => sanityIntraday([{ time: 2, ...ohlc() }, { time: 1, ...ohlc() }], "X"), /비단조/);
  // 월 산술
  assert.equal(addMonthsIso("2026-03-15", 1), "2026-04-15", "월+1 오류");
  assert.equal(addMonthsIso("2026-03-15", -2), "2026-01-15", "월-2 오류");
  console.log("셀프테스트 통과 ✓ (매핑·sanity·월산술 6건)");
}
function ohlc() { return { o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }; }

// ── entrypoint ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest();
} else {
  if (!keyId() || !keySecret()) {
    console.error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY 필요 — node --env-file=worker/.env 로 실행하세요.");
    process.exit(1);
  }
  const outRoot = DEFAULT_OUT_ROOT;
  // --minute-only: 분봉 시나리오만 재생성(일봉 재fetch 생략 — 세션 필터 반영 재실행 등).
  const run = argv.includes("--minute-only")
    ? buildMinute(outRoot)
    : buildDaily(outRoot).then(() => buildMinute(outRoot));
  run.then(() => console.log("\n완료 ✓")).catch((e) => { console.error(`오류: ${e.message}`); process.exit(1); });
}
