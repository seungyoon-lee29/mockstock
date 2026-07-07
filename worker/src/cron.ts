// 크론 5종 — 전부 워커 node-cron(Vercel Cron 미사용, B7), 전부 timezone 'Asia/Seoul'(§7.6).
//  ① 시즌 리셋(월 08:30)  ② 확정 스윕(부팅 1회 + 매 N분)  ③ 일별 스냅샷(15:40)
//  ④ prevClose 갱신(07:30, prevCloseDate 멱등)  ⑤ 환율 갱신(09:00)
// 각 실행의 완료·실패를 Discord webhook(env DISCORD_WEBHOOK_URL)으로 통지, 없으면 콘솔.
// DATABASE_URL 없으면 스케줄 자체를 건너뛴다 — mock 로컬 데모(키 불필요)가 깨지지 않도록.
import cron from "node-cron";
import { sql } from "drizzle-orm";
import {
  ensureActiveSeason,
  finalizeDueSeasons,
  resetSeason,
  snapshotPortfolios,
  type SeasonConfig,
} from "@mockstock/shared";
import { instruments, minuteCandles } from "@mockstock/shared/schema";
import { getDb } from "./db";
import { updateFxRates } from "./fx";

const TZ = "Asia/Seoul";
const MINUTE_CANDLE_RETENTION_DAYS = Math.max(1, Number(process.env.MINUTE_CANDLE_RETENTION_DAYS ?? 30));

/** env 파라미터화(§4.1) — 단축 시즌·시드 조정을 코드 수정 없이. 미설정 시 주간/1,000만 기본. */
function seasonConfig(): SeasonConfig {
  return {
    durationMs: process.env.SEASON_DURATION_MS ? Number(process.env.SEASON_DURATION_MS) : undefined,
    seedMoney: process.env.SEASON_SEED_KRW ? Number(process.env.SEASON_SEED_KRW) : undefined,
  };
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
    console.warn("[cron] DATABASE_URL 미설정 — 시즌·정산·환율 크론 스킵(mock 로컬 데모 모드)");
    return;
  }
  const cfg = seasonConfig();
  const sweepMin = Math.max(1, Number(process.env.FINALIZE_SWEEP_MINUTES ?? 5));

  // 부팅 스윕(§4.1 수동 재트리거 런북) — 밀린 확정 처리 후 현재 시즌 보장. 멱등이라 반복 안전.
  void runNotified("부팅 스윕", async () => {
    const finalized = await finalizeDueSeasons(db);
    await ensureActiveSeason(db, cfg);
    return { finalized };
  });

  // ① 시즌 리셋 — 월 08:30(KR 개장 전).
  cron.schedule("30 8 * * 1", () => void runNotified("시즌 리셋", () => resetSeason(db, cfg)), { timezone: TZ });
  // ② 확정 스윕 — 매 N분(상태 기반 멱등). noOverlap 로 장기 실행 중 중복 발사 차단.
  cron.schedule(`*/${sweepMin} * * * *`, () => void runNotified("확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  // ③ 일별 스냅샷 — 15:40(당일 KR 종가 반영, MDD용 §4.2).
  cron.schedule("40 15 * * 1-5", () => void runNotified("일별 스냅샷", () => snapshotPortfolios(db)), { timezone: TZ });
  // ④ prevClose 갱신 — 07:30.
  cron.schedule("30 7 * * 1-5", () => void runNotified("prevClose 갱신", () => updatePrevClose(db)), { timezone: TZ });
  // ⑤ 환율 갱신 — 09:00(금 15:30 확정에 선행, §6.6).
  cron.schedule("0 9 * * 1-5", () => void runNotified("환율 갱신", () => updateFxRates(db)), { timezone: TZ });
  // ⑥ 분봉 보존 — 매일 04:20 KST(KR 이른 새벽·장외지만 US 정규장 14:20/15:20 ET와 겹침), N일 초과 prune.
  cron.schedule("20 4 * * *", () => void runNotified("분봉 prune", () => pruneMinuteCandles(db)), { timezone: TZ });

  console.log(`[cron] 등록 완료 (Asia/Seoul, 확정 스윕 매 ${sweepMin}분, 분봉 보존 ${MINUTE_CANDLE_RETENTION_DAYS}일)`);
}
