// 크론 워커 node-cron(Vercel Cron 미사용, B7), 전부 timezone 'Asia/Seoul'(§7.6).
// 리그별 리셋(월 08:30/22:00) · 리그별 확정 마감창(KR 금 15:35~16:05 / US 토 05:05~06:05 KST) · 일별 스냅샷(15:40)
// 분봉 prune(매일 04:20) · 각 실행의 완료·실패를 Discord webhook(env DISCORD_WEBHOOK_URL)으로 통지, 없으면 콘솔.
// DATABASE_URL 없으면 스케줄 자체를 건너뛴다 — mock 로컬 데모(키 불필요)가 깨지지 않도록.
import cron from "node-cron";
import { sql } from "drizzle-orm";
import {
  ensureActiveSeason,
  finalizeDueSeasons,
  resetSeason,
  snapshotPortfolios,
  type Market,
  type SeasonConfig,
} from "@mockstock/shared";
import { instruments, minuteCandles } from "@mockstock/shared/schema";
import { getDb } from "./db";
import { bootBackfillDailyCandles, syncDailyCandles } from "./candles/dailySync";
import { syncSharesOutstanding } from "./sharesOutstanding";

const TZ = "Asia/Seoul";
const MINUTE_CANDLE_RETENTION_DAYS = Math.max(1, Number(process.env.MINUTE_CANDLE_RETENTION_DAYS ?? 30));

/** env 파라미터화(§4.1) — 단축 시즌·시드 조정을 코드 수정 없이. 미설정 시 주간/1,000만 기본. */
function seasonConfig(): SeasonConfig {
  return {
    durationMs: process.env.SEASON_DURATION_MS ? Number(process.env.SEASON_DURATION_MS) : undefined,
    seedMoney: process.env.SEASON_SEED_KRW ? Number(process.env.SEASON_SEED_KRW) : undefined,
  };
}

/**
 * SEASON_SEED_KRW는 KR 리그 한정 env — US 시즌은 seedMoney를 undefined로 두어
 * SEED_MONEY.US 기본값을 타게 한다. durationMs 등 다른 cfg 값은 양 리그 공통 적용.
 */
function cfgFor(cfg: SeasonConfig, market: Market): SeasonConfig {
  if (market === "KR") return cfg;
  const { seedMoney: _omit, ...rest } = cfg;
  return rest;
}

async function notify(text: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log(`[cron] ${text}`);
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  } catch (e) {
    console.error("[cron] Discord 통지 실패", e);
  }
}

/** 크론 잡 실행 + 완료/실패 통지(무감지 실패 방지·하트비트 겸용, §7.6 R5). */
async function runNotified(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    await notify(`✅ ${name} 완료${result != null ? ` — ${JSON.stringify(result)}` : ""}`);
  } catch (e) {
    console.error(`[cron] ${name} 실패`, e);
    await notify(`🚨 ${name} 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** ④ prevClose 갱신 — lastPrice 를 prevClose 로 승격. prevCloseDate 가드로 하루 1회 멱등. */
async function updatePrevClose(db: NonNullable<ReturnType<typeof getDb>>): Promise<void> {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // KST 날짜
  await db
    .update(instruments)
    .set({ prevClose: sql`${instruments.lastPrice}`, prevCloseDate: today })
    .where(
      sql`${instruments.lastPrice} is not null and ${instruments.prevCloseDate} is distinct from ${today}::date`,
    );
}

/** ⑥ 분봉 보존 — minute_candles 에서 N일(env, 기본 30) 초과 로우 prune(무한 성장 방지). */
async function pruneMinuteCandles(
  db: NonNullable<ReturnType<typeof getDb>>,
): Promise<{ deleted: number | null; retentionDays: number }> {
  const cutoff = new Date(Date.now() - MINUTE_CANDLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await db.delete(minuteCandles).where(sql`${minuteCandles.ts} < ${cutoff}`);
  return { deleted: (res as { rowCount?: number }).rowCount ?? null, retentionDays: MINUTE_CANDLE_RETENTION_DAYS };
}

export function startCron(): void {
  const db = getDb();
  if (!db) {
    console.warn("[cron] DATABASE_URL 미설정 — 시즌·정산 크론 스킵(mock 로컬 데모 모드)");
    return;
  }
  const cfg = seasonConfig();

  // 부팅 스윕(§4.1 수동 재트리거 런북) — 밀린 확정 처리 후 현재 시즌 보장. 멱등이라 반복 안전.
  void runNotified("부팅 스윕", async () => {
    const finalized = await finalizeDueSeasons(db);
    await ensureActiveSeason(db, cfgFor(cfg, "KR"), "KR");
    await ensureActiveSeason(db, cfgFor(cfg, "US"), "US");
    return { finalized };
  });

  // 일봉 부팅 백필(멀티 타임프레임 v2) — 심볼별 max(date) 갭만 보충(기본 730일, 멱등).
  // 부팅 1회 버스트라 B13과 양립. 키 전무+테이블 빈 상태면 내부에서 Discord 1회 경고.
  void runNotified("일봉 부팅 백필", () => bootBackfillDailyCandles(db, notify));

  // 상장주식수 부팅 적재 — NULL 종목만(1회 버스트, B13 양립). 시총 표시 데이터 레이어.
  // 키 없으면 내부 no-op(fail-soft). 주간 크론이 이후 slow-drift 갱신.
  void runNotified("상장주식수 부팅 적재", () => syncSharesOutstanding(db, { onlyMissing: true }));

  // ① KR 리셋 — 월 08:30 KST(KR 개장 전). US 리셋 — 월 22:00 KST(≈미 동부 월 09:00 여름 개장 전).
  cron.schedule("30 8 * * 1", () => void runNotified("KR 시즌 리셋", () => resetSeason(db, cfgFor(cfg, "KR"), "KR")), { timezone: TZ });
  cron.schedule("0 22 * * 1", () => void runNotified("US 시즌 리셋", () => resetSeason(db, cfgFor(cfg, "US"), "US")), { timezone: TZ });
  // ② 확정 스윕 — 각 리그 마감창에서만(상시 5분 스윕 금지, Neon 보존 B13). endsAt<=now & active 를 스캔하는
  //    상태 기반 멱등 스윕이라 다운타임에도 다음 창에서 밀린 시즌을 잡는다. noOverlap 로 중복 발사 차단.
  //    KR: 금 15:35~16:05 매 5분(15:30 마감 직후). US: 토 05:05~06:05 매 5분(≈금 16:00 ET 마감 직후, DST 여유).
  cron.schedule("35-59/5 15 * * 5", () => void runNotified("KR 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  cron.schedule("0-5 16 * * 5", () => void runNotified("KR 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  cron.schedule("5-59/5 5 * * 6", () => void runNotified("US 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  cron.schedule("0-5 6 * * 6", () => void runNotified("US 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  // ③ 일별 스냅샷 — 월~금 15:40(KR 종가 + 전일 US 종가 반영, 양 리그 live 시즌 공통).
  //    금요일 종가는 finalize의 finalValue에만 반영(MDD 마지막 1일 미표본 — 알려진 한계).
  //    US 토 스냅샷 슬롯(06:10) 폐지: US 시즌은 토 06:05까지 확정되고 장중 KST 주간은 US 장이 닫혀 있어
  //    화~금 실행분이 15:40과 동일 값이므로 구조적 no-op이다.
  cron.schedule("40 15 * * 1-5", () => void runNotified("스냅샷", () => snapshotPortfolios(db)), { timezone: TZ });
  // ⑦ daily_candles 동기화(멀티 타임프레임 v2) — 마감 후 기존 슬롯 편승, 멱등 upsert.
  //    KR: 15:40 스냅샷 슬롯 동시각(KR 15:30 마감 직후). US: 07:30 화~토(US 마감 05~06시 KST 이후,
  //    DST 여유 — 토요일 실행이 금요일 세션을 커버). 키 없으면 내부 no-op(fail-soft).
  cron.schedule("40 15 * * 1-5", () => void runNotified("KR 일봉 동기화", () => syncDailyCandles(db, "KR")), { timezone: TZ, noOverlap: true });
  cron.schedule("30 7 * * 2-6", () => void runNotified("US 일봉 동기화", () => syncDailyCandles(db, "US")), { timezone: TZ, noOverlap: true });
  // ④ prevClose 갱신 — 07:30.
  cron.schedule("30 7 * * 1-5", () => void runNotified("prevClose 갱신", () => updatePrevClose(db)), { timezone: TZ });
  // ⑧ 상장주식수 주간 갱신 — 일 06:30 KST(양 시장 휴장, 마감창 밖). 느린 펀더멘털이라 주 1회로 충분.
  //    전 종목 재조회(발행·감자 반영). 키 없으면 내부 no-op. KIS는 kisRest throttle이 2 req/s 페이싱.
  cron.schedule("30 6 * * 0", () => void runNotified("상장주식수 주간 갱신", () => syncSharesOutstanding(db)), { timezone: TZ, noOverlap: true });
  // ⑤ 분봉 보존 — 매일 04:20 KST, N일 초과 prune.
  cron.schedule("20 4 * * *", () => void runNotified("분봉 prune", () => pruneMinuteCandles(db)), { timezone: TZ });

  console.log(`[cron] 등록 완료 (Asia/Seoul, 확정=리그별 마감창, 분봉 보존 ${MINUTE_CANDLE_RETENTION_DAYS}일)`);
}
