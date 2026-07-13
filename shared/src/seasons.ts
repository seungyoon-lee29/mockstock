// 시즌 수명주기 — web의 lazy 생성 폴백과 worker 크론이 공용 호출(§4.1·§7.6).
// 서버 전용(schema 의존). 모든 상태 전이는 멱등·동시 호출 안전을 목표로 한다:
//  · 생성/리셋은 결정적 시즌 id + onConflict 로 이중 생성 차단.
//  · 확정은 seasons.status CAS 플립(active→finalized)을 게이트로 한 단일 트랜잭션 스윕.
//
// 금액 컬럼은 numeric. 여기서 만지는 값 중 현금·예약(원장)은 센트 정수로 정확히 다루고,
// 보유 평가액(finalValue·스냅샷 totalValue)은 마크투마켓이라 float 곱 후 센트로 반올림한다
// — Σ realizedPnl ≡ 현금 증감 불변식은 fillOrder 원장에서만 성립하면 되고 평가액은 별개다.

import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  accounts,
  instruments,
  orders,
  portfolioSnapshots,
  positions,
  seasonResults,
  seasons,
  users,
} from "./schema";
import {
  SEASON_END_HOUR_KST,
  SEASON_END_MINUTE_KST,
  SEASON_END_WEEKDAY,
  SEASON_START_WEEKDAY,
  SEED_MONEY,
} from "./rules";
import type { Market } from "./types";

type Db = PgDatabase<any, any, any>;

export interface SeasonConfig {
  /** 시즌 시드 현금(네이티브 통화). 미지정 시 SEED_MONEY[market](리그별 네이티브). */
  seedMoney?: number;
  /** 지정 시 고정 길이 롤링 시즌(단축 시즌 테스트, §4.1). 미지정 시 월간(KR=1일00:00→말일15:30 KST, US=1일→말일16:00 ET). */
  durationMs?: number;
}

export interface SeasonRow {
  id: string;
  market: "US" | "KR";
  startsAt: Date;
  endsAt: Date;
  seedMoney: string;
  status: "active" | "finalized";
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function seedMoneyOf(cfg: SeasonConfig, market: Market): number {
  return cfg.seedMoney ?? SEED_MONEY[market];
}

/** now(UTC)를 KST로 시프트해 'YYYY-MM-DD'(KST 날짜)를 얻는다. 스냅샷 date 키에 사용. */
function kstDateString(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 주간 시즌 경계. KR = 이번 주 월요일 00:00 KST → 금요일 15:30 KST(DST 없는 +9h 고정).
 * US = 이번 주 월요일 → 금요일 16:00 America/New_York(DST 자동).
 * export: 테스트·외부 경계 검증용.
 */
export function weeklyPeriod(market: Market, now: Date): { startsAt: Date; endsAt: Date } {
  const kst = new Date(now.getTime() + KST_OFFSET_MS); // KST 필드를 getUTC*로 읽기 위한 시프트
  const daysSinceStart = (kst.getUTCDay() - SEASON_START_WEEKDAY + 7) % 7;
  const startMondayUtc =
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - daysSinceStart) -
    KST_OFFSET_MS;

  if (market === "KR") {
    const endOffsetMs =
      (SEASON_END_WEEKDAY - SEASON_START_WEEKDAY) * DAY_MS +
      (SEASON_END_HOUR_KST * 60 + SEASON_END_MINUTE_KST) * 60 * 1000;
    return { startsAt: new Date(startMondayUtc), endsAt: new Date(startMondayUtc + endOffsetMs) };
  }

  // US: 그 주 금요일 16:00 America/New_York을 DST-aware로 산출.
  // startMondayUtc = 월요일 00:00 KST(= 일요일 15:00 UTC). 금요일 16:00 UTC는 항상 NY에서 금요일임.
  // (금 16:00 UTC = 금 12:00 EDT = 금 11:00 EST — 양쪽 모두 금요일 보장)
  const friAnchor = new Date(startMondayUtc + 4 * DAY_MS + KST_OFFSET_MS + 16 * 60 * 60 * 1000);
  const endsAt = closeET(friAnchor);
  return { startsAt: new Date(startMondayUtc), endsAt };
}

/**
 * 정오 UTC 앵커가 가리키는 뉴욕 현지 날짜의 16:00 America/New_York(DST 자동)을 UTC Date로 반환.
 * 주간(금요일)·월간(말일) 공용 — 앵커일이 EDT/EST 어느 쪽이든 그날 16:00 ET를 산출한다.
 * Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" }) 로 "GMT-4"/"GMT-5" 파싱.
 * KST 절대시각 하드코딩 없음 — US 경계는 반드시 tz 계산 경유(rules/worker.md).
 */
function closeET(dayNoonUtc: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZoneName: "shortOffset",
  }).formatToParts(dayNoonUtc);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  // "GMT-4" → -240분, "GMT-5" → -300분
  const tzStr = p.timeZoneName ?? "GMT-5"; // 파싱 실패 시 EST fallback
  const sign = tzStr.includes("-") ? -1 : 1;
  const [h, m = "0"] = tzStr.replace("GMT", "").replace("-", "").replace("+", "").split(":");
  const offsetMinutes = sign * (Number(h) * 60 + Number(m));
  // 그날 뉴욕 현지 날짜의 16:00 UTC = Date.UTC(y, mo, d, 16, 0) - offsetMinutes * 60_000
  return new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 16, 0) -
      offsetMinutes * 60_000,
  );
}

/**
 * 월간(달력월) 시즌 경계 — 기본 시즌 단위.
 * startsAt = 그 달 1일 00:00 KST(UTC+9 고정 시프트로 y/mo 산출).
 * endsAt   = 말일 장 마감. KR = 말일 15:30 KST(SEASON_END_*_KST 재사용).
 *            US = 말일 16:00 America/New_York(closeET로 DST 자동).
 * 말일 = Date.UTC(y, mo+1, 0)의 날짜 → 연말 롤오버·윤년 2월 자동 처리.
 * export: 테스트·외부 경계 검증용.
 */
export function monthlyPeriod(market: Market, now: Date): { startsAt: Date; endsAt: Date } {
  const kst = new Date(now.getTime() + KST_OFFSET_MS); // KST 필드를 getUTC*로 읽기 위한 시프트
  const y = kst.getUTCFullYear();
  const mo = kst.getUTCMonth();
  const startsAt = new Date(Date.UTC(y, mo, 1) - KST_OFFSET_MS); // 1일 00:00 KST
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

  if (market === "KR") {
    // 말일 15:30 KST = Date.UTC(y, mo, lastDay, 15-9, 30) (SEASON_END_*_KST 재사용).
    const endsAt = new Date(
      Date.UTC(y, mo, lastDay, SEASON_END_HOUR_KST - 9, SEASON_END_MINUTE_KST),
    );
    return { startsAt, endsAt };
  }

  // US: 말일 정오 UTC 앵커로 closeET 호출 → 그날 16:00 ET(DST 자동).
  // 정오 UTC는 EDT/EST 어느 쪽이든 해당 뉴욕 날짜가 말일과 일치(경계 자정 미접근).
  const lastNoonUtc = new Date(Date.UTC(y, mo, lastDay, 12, 0));
  return { startsAt, endsAt: closeET(lastNoonUtc) };
}

/** 현재 시각이 속한 시즌의 결정적 경계 + id. 같은 기간+market엔 항상 같은 id → onConflict 로 멱등 생성. */
function currentPeriod(now: Date, cfg: SeasonConfig, market: Market): { id: string; startsAt: Date; endsAt: Date } {
  if (cfg.durationMs && cfg.durationMs > 0) {
    const startMs = Math.floor(now.getTime() / cfg.durationMs) * cfg.durationMs;
    return {
      id: `season_${new Date(startMs).toISOString()}:${market}`,
      startsAt: new Date(startMs),
      endsAt: new Date(startMs + cfg.durationMs),
    };
  }
  const { startsAt, endsAt } = monthlyPeriod(market, now);
  return { id: `season_${startsAt.toISOString()}:${market}`, startsAt, endsAt };
}

// numeric(_,2) 문자열 ↔ 센트 정수 (fillOrder 와 동일 규약 — 현금·예약을 정확히 합산).
function toCents(v: string): number {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const cents = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -cents : cents;
}
function fromCents(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const arr = m.get(key(it));
    if (arr) arr.push(it);
    else m.set(key(it), [it]);
  }
  return m;
}

/** 최대낙폭(%). values는 날짜순 스냅샷 totalValue. 표본 부족(<2)이면 0(§4.2 — 스냅샷 부족 시 0). */
export function maxDrawdownPct(values: number[]): number {
  if (values.length < 2) return 0;
  let peak = values[0];
  let mdd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd * 100;
}

type PriceMap = Map<string, number>;
interface PositionRow {
  market: "US" | "KR";
  symbol: string;
  qty: string;
}

async function loadPrices(db: Db): Promise<PriceMap> {
  const rows = await db
    .select({ market: instruments.market, symbol: instruments.symbol, lastPrice: instruments.lastPrice })
    .from(instruments);
  const m: PriceMap = new Map();
  for (const r of rows) if (r.lastPrice != null) m.set(`${r.market}:${r.symbol}`, Number(r.lastPrice));
  return m;
}

/** 보유 평가액(네이티브 센트). lastPrice 없는 종목은 평가 불가로 제외. 리그별 네이티브 통화 — fxRate 불필요(A3에서 리그 분리). */
function holdingsCents(rows: PositionRow[], prices: PriceMap): number {
  let sum = 0;
  for (const p of rows) {
    const price = prices.get(`${p.market}:${p.symbol}`);
    if (price == null) continue;
    sum += Number(p.qty) * price;
  }
  return Math.round(sum * 100);
}

/**
 * active 시즌이 없으면 현재 기간 시즌을 생성한다(멱등·동시 호출 안전).
 * 아직 만료 전(endsAt>now)인 active 시즌이 있으면 그대로 반환 — 재차감/재설정 없음.
 */
export async function ensureActiveSeason(db: Db, cfg: SeasonConfig, market: Market): Promise<SeasonRow> {
  const now = new Date();
  const [live] = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.status, "active"), eq(seasons.market, market), gt(seasons.endsAt, now)))
    .orderBy(desc(seasons.startsAt))
    .limit(1);
  if (live) return live as SeasonRow;

  const p = currentPeriod(now, cfg, market);
  await db
    .insert(seasons)
    .values({
      id: p.id,
      market,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      seedMoney: seedMoneyOf(cfg, market).toFixed(2),
      status: "active",
    })
    .onConflictDoNothing({ target: seasons.id }); // 동시 생성 시 두 번째는 no-op
  const [s] = await db.select().from(seasons).where(eq(seasons.id, p.id));
  return s as SeasonRow;
}

/**
 * 월 1일 리셋 — 신규 시즌 row(멱등) + 직전 시즌 로스터를 신규 시즌으로 이관·시드 재설정.
 * 신규 시즌은 per-season이라 포지션 없는 클린 슬레이트 → 재설정은 계좌 현금만 seed 로.
 * 직전 시즌은 같은 market으로 한정 — 교차 리그 로스터 오염 차단.
 * ponytail: 재설정은 월간 크론(장 개장 전) 전제. 멱등 재실행 안전, 개장 후 매매 중 호출은 상정하지 않음.
 */
export async function resetSeason(db: Db, cfg: SeasonConfig, market: Market): Promise<SeasonRow> {
  const season = await ensureActiveSeason(db, cfg, market);
  const seedStr = seedMoneyOf(cfg, market).toFixed(2);
  // 직전 시즌은 같은 리그(market)만 — 교차 리그 로스터 오염 차단.
  const [prior] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(ne(seasons.id, season.id), eq(seasons.market, market)))
    .orderBy(desc(seasons.startsAt))
    .limit(1);
  if (prior) {
    const roster = await db
      .selectDistinct({ userId: accounts.userId })
      .from(accounts)
      .where(eq(accounts.seasonId, prior.id));
    if (roster.length) {
      await db
        .insert(accounts)
        .values(roster.map((r) => ({ userId: r.userId, seasonId: season.id, cash: seedStr })))
        .onConflictDoUpdate({
          target: [accounts.userId, accounts.seasonId],
          set: { cash: seedStr },
        });
    }
  }
  return season;
}

/**
 * 상태 기반 멱등 확정 스윕 — endsAt 경과 & status='active' 시즌을 확정한다(§4.1 순서 엄수).
 * 부팅 시·매 N분 호출. 확정된 시즌 id 배열 반환.
 */
export async function finalizeDueSeasons(db: Db): Promise<string[]> {
  const now = new Date();
  const due = await db
    .select({ id: seasons.id, seedMoney: seasons.seedMoney })
    .from(seasons)
    .where(and(eq(seasons.status, "active"), lte(seasons.endsAt, now)));
  const done: string[] = [];
  for (const s of due) {
    if (await finalizeOne(db, s.id, s.seedMoney)) done.push(s.id);
  }
  return done;
}

async function finalizeOne(db: Db, seasonId: string, seedStr: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // ① status CAS 플립. 0행이면 다른 스윕이 선점 → 전체 중단(이중 실행 차단).
    const flipped = await tx
      .update(seasons)
      .set({ status: "finalized" })
      .where(and(eq(seasons.id, seasonId), eq(seasons.status, "active")))
      .returning({ id: seasons.id });
    if (flipped.length === 0) return false;

    // ② open 주문 전량 expire + 예약 환불(매수 지정가 reserved만). RETURNING 값으로만 환불(재조회 금지).
    const expired = await tx
      .update(orders)
      .set({ status: "expired" })
      .where(and(eq(orders.seasonId, seasonId), eq(orders.status, "open")))
      .returning({ userId: orders.userId, reserved: orders.reserved });
    for (const o of expired) {
      if (o.reserved != null) {
        await tx
          .update(accounts)
          .set({ cash: sql`${accounts.cash} + ${o.reserved}::numeric` })
          .where(and(eq(accounts.userId, o.userId), eq(accounts.seasonId, seasonId)));
      }
    }

    // ③ finalValue = cash(환불 반영) + Σ(qty×lastPrice). 네이티브 통화 — fxRate 불필요(리그 분리 완료後).
    const prices = await loadPrices(tx);
    const accs = await tx
      .select({ userId: accounts.userId, cash: accounts.cash })
      .from(accounts)
      .where(eq(accounts.seasonId, seasonId));
    const posRows = await tx
      .select({ userId: positions.userId, market: positions.market, symbol: positions.symbol, qty: positions.qty })
      .from(positions)
      .where(eq(positions.seasonId, seasonId));
    const snaps = await tx
      .select({ userId: portfolioSnapshots.userId, totalValue: portfolioSnapshots.totalValue })
      .from(portfolioSnapshots)
      .where(eq(portfolioSnapshots.seasonId, seasonId))
      .orderBy(portfolioSnapshots.date);

    // 봇 제외(공식 순위·뱃지, A2) — 로스터 중 isBot 만 집합으로.
    const roster = accs.map((a) => a.userId);
    const bots = roster.length
      ? new Set(
          (
            await tx
              .select({ id: users.id })
              .from(users)
              .where(and(inArray(users.id, roster), eq(users.isBot, true)))
          ).map((u) => u.id),
        )
      : new Set<string>();

    const posByUser = groupBy(posRows, (p) => p.userId);
    const snapByUser = groupBy(snaps, (s) => s.userId);
    const seedCents = toCents(seedStr);

    // ④ 랭킹 — returnPct desc, 동률 시 mdd asc. 봇 제외.
    const ranked = accs
      .filter((a) => !bots.has(a.userId))
      .map((a) => {
        const finalCents = toCents(a.cash) + holdingsCents(posByUser.get(a.userId) ?? [], prices);
        return {
          userId: a.userId,
          finalCents,
          returnPct: seedCents > 0 ? ((finalCents - seedCents) / seedCents) * 100 : 0,
          mdd: maxDrawdownPct((snapByUser.get(a.userId) ?? []).map((s) => Number(s.totalValue))),
        };
      })
      .sort((x, y) => y.returnPct - x.returnPct || x.mdd - y.mdd);

    if (ranked.length) {
      await tx
        .insert(seasonResults)
        .values(
          ranked.map((r, i) => ({
            seasonId,
            userId: r.userId,
            rank: i + 1,
            returnPct: r.returnPct.toFixed(2),
            mdd: r.mdd.toFixed(2),
            finalValue: fromCents(r.finalCents),
          })),
        )
        .onConflictDoNothing();
    }
    return true;
  });
}

/**
 * 일별 스냅샷(MDD 원천, §4.1·§4.2). live 시즌 각 계좌:
 *   totalValue = cash + Σ open매수 예약 현금 + Σ(qty×lastPrice).  네이티브 통화(예약 현금 포함, §4.1)
 * 같은 날 재실행은 upsert 덮어쓰기(멱등). 스냅샷 행 수 반환.
 */
export async function snapshotPortfolios(db: Db): Promise<number> {
  const now = new Date();
  const live = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.status, "active"), lte(seasons.startsAt, now), gt(seasons.endsAt, now)));
  if (live.length === 0) return 0;

  const prices = await loadPrices(db);
  const date = kstDateString(now);
  let count = 0;
  for (const s of live) {
    const accs = await db
      .select({ userId: accounts.userId, cash: accounts.cash })
      .from(accounts)
      .where(eq(accounts.seasonId, s.id));
    const posRows = await db
      .select({ userId: positions.userId, market: positions.market, symbol: positions.symbol, qty: positions.qty })
      .from(positions)
      .where(eq(positions.seasonId, s.id));
    const openBuys = await db
      .select({ userId: orders.userId, reserved: orders.reserved })
      .from(orders)
      .where(and(eq(orders.seasonId, s.id), eq(orders.status, "open"), eq(orders.side, "buy")));

    const posByUser = groupBy(posRows, (p) => p.userId);
    const reservedByUser = new Map<string, number>();
    for (const o of openBuys) {
      if (o.reserved != null) {
        reservedByUser.set(o.userId, (reservedByUser.get(o.userId) ?? 0) + toCents(o.reserved));
      }
    }

    for (const a of accs) {
      const totalCents =
        toCents(a.cash) +
        (reservedByUser.get(a.userId) ?? 0) +
        holdingsCents(posByUser.get(a.userId) ?? [], prices);
      const total = fromCents(totalCents);
      await db
        .insert(portfolioSnapshots)
        .values({ userId: a.userId, seasonId: s.id, date, totalValue: total })
        .onConflictDoUpdate({
          target: [portfolioSnapshots.userId, portfolioSnapshots.seasonId, portfolioSnapshots.date],
          set: { totalValue: total },
        });
      count++;
    }
  }
  return count;
}
