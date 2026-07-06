// 공개 벤치마크 봇 (T07 · PRD §4.3) — 리더보드 공백 방지 + 체결 엔진 상시 자가 테스트.
//  · 부팅 시 봇 유저 멱등 시드(is_bot=true, 이름에 전략 노출 → BOT 배지·기준선용).
//  · 매 BOT_INTERVAL_SEC 마다 각 봇이 시세북 가격으로 market 주문 insert + fillOrder 직접 호출.
//    (체결 엔진을 web과 동일 경로로 계속 두드려 회귀 감지 — §4.3)
//  · 열린 시장만 거래: mock 틱(source==='mock')은 open 간주, 실피드는 marketSession 판정.
//  · over-limit·insufficient-cash·insufficient-qty 거절은 정상 흐름 — 스킵(로그만).
//  · DATABASE_URL 없으면 봇 비활성(경고) — 키 없는 mock 로컬 데모(npm run dev:worker) 무손상.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  UNIVERSE,
  keyOf,
  ensureActiveSeason,
  FX_PAIR_USDKRW,
  type Market,
  type Side,
  type Tick,
  type UniverseEntry,
  type SeasonConfig,
  type SeasonRow,
} from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import { fillOrder } from "@mockstock/shared/fillOrder";
import { accounts, fxRates, orders, positions, users } from "@mockstock/shared/schema";
import { getDb } from "./db";
import type { PriceBook } from "./priceBook";

type Db = PgDatabase<any, any, any>;
type Strategy = "random" | "momentum" | "index";
interface BotDef {
  id: string;
  name: string;
  strategy: Strategy;
}

// 전략 1개당 봇 1개(기본). BOT_COUNT>3 이면 번호를 붙여 순환(랜덤봇 2 …).
const STRATEGIES: { key: Strategy; name: string }[] = [
  { key: "random", name: "랜덤봇" },
  { key: "momentum", name: "모멘텀봇" },
  { key: "index", name: "인덱스봇" },
];

/** 인덱스봇 홀딩 대상 = 시총 상위 근사. 유니버스 배열 순서가 시총 순 근사이므로 시장별 상위 N. */
const TOPCAP_N = 5;
const TOPCAP_KEYS = new Set<string>(
  (["KR", "US"] as Market[]).flatMap((m) =>
    UNIVERSE.filter((e) => e.market === m)
      .slice(0, TOPCAP_N)
      .map((e) => keyOf(e.market, e.symbol)),
  ),
);

const DEFAULT_BOT_COUNT = 3; // 미설정 시 전략별 1개 (§4.3)

/** BOT_COUNT 파싱 — 0은 "봇 완전 비활성"의 유효값(미설정·비정상 값만 기본값). */
export function botCountOf(raw: string | undefined): number {
  const v = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : DEFAULT_BOT_COUNT;
}

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}
function envFloat(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** cron.ts seasonConfig() 와 동일 규약 — 봇/크론이 같은 시즌 경계를 잡도록(id 불일치 방지). */
function seasonConfig(): SeasonConfig {
  return {
    durationMs: process.env.SEASON_DURATION_MS ? Number(process.env.SEASON_DURATION_MS) : undefined,
    seedMoney: process.env.SEASON_SEED_KRW ? Number(process.env.SEASON_SEED_KRW) : undefined,
  };
}

export function buildBots(count: number): BotDef[] {
  const bots: BotDef[] = [];
  for (let i = 0; i < count; i++) {
    const s = STRATEGIES[i % STRATEGIES.length];
    const n = Math.floor(i / STRATEGIES.length); // 순환 회차(0=원본)
    bots.push({
      id: `bot_${s.key}${n ? `_${n + 1}` : ""}`,
      name: n ? `${s.name} ${n + 1}` : s.name,
      strategy: s.key,
    });
  }
  return bots;
}

interface Priced {
  entry: UniverseEntry;
  tick: Tick;
}
interface Intent {
  entry: UniverseEntry;
  tick: Tick;
  side: Side;
  qty: number;
}

/** 시세북에 현재가가 있고 시장이 열린 심볼만. mock 틱은 open 간주(§7.5), 실피드는 캘린더 판정. */
function tradeable(book: PriceBook): Priced[] {
  const now = new Date();
  const out: Priced[] = [];
  for (const entry of UNIVERSE) {
    const tick = book.get(entry.market, entry.symbol);
    if (!tick) continue;
    const open = tick.source === "mock" || isMarketOpen(entry.market, now);
    if (open) out.push({ entry, tick });
  }
  return out;
}

function fxOf(market: Market, usdKrw: number): number {
  return market === "US" ? usdKrw : 1; // KR은 원화 그대로
}

/** 주문 예산(KRW)으로 살 수 있는 정수 주수. US인데 환율 없으면 0(스킵). */
export function buyQty(p: Priced, usdKrw: number, budgetKrw: number): number {
  const fx = fxOf(p.entry.market, usdKrw);
  if (fx <= 0) return 0;
  const priceKrw = p.tick.price * fx;
  return priceKrw > 0 ? Math.floor(budgetKrw / priceKrw) : 0;
}

function heldQty(holdings: Map<string, number>, userId: string, entry: UniverseEntry): number {
  return holdings.get(`${userId}|${keyOf(entry.market, entry.symbol)}`) ?? 0;
}

/** 전략별 주문 의도(0~2건). 매수 qty는 예산 기준, 매도 qty는 보유 전량. */
export function decide(
  bot: BotDef,
  market: Priced[],
  holdings: Map<string, number>,
  usdKrw: number,
  budgetKrw: number,
): Intent[] {
  if (bot.strategy === "random") {
    // 유니버스 균등 추첨. 보유 종목이면 일부 확률로 매도(체결 엔진 매도 경로 자가 테스트).
    const pick = market[Math.floor(Math.random() * market.length)];
    if (!pick) return [];
    const held = heldQty(holdings, bot.id, pick.entry);
    if (held > 0 && Math.random() < 0.4) return [{ ...pick, side: "sell", qty: held }];
    const qty = buyQty(pick, usdKrw, budgetKrw);
    return qty >= 1 ? [{ ...pick, side: "buy", qty }] : [];
  }

  if (bot.strategy === "momentum") {
    // 직전 등락률 = (현재가 − seedPrice)/seedPrice (seedPrice≈전일종가·mock 평균회귀 기준).
    const scored = market.map((p) => ({ ...p, chg: (p.tick.price - p.entry.seedPrice) / p.entry.seedPrice }));
    const intents: Intent[] = [];
    // 하락 보유분 하나 매도(포지션 회전).
    for (const s of scored) {
      if (s.chg >= 0) continue;
      const held = heldQty(holdings, bot.id, s.entry);
      if (held > 0) {
        intents.push({ entry: s.entry, tick: s.tick, side: "sell", qty: held });
        break;
      }
    }
    // 등락률 상위 매수.
    const top = scored.filter((s) => s.chg > 0).sort((a, b) => b.chg - a.chg)[0];
    if (top) {
      const qty = buyQty(top, usdKrw, budgetKrw);
      if (qty >= 1) intents.push({ entry: top.entry, tick: top.tick, side: "buy", qty });
    }
    return intents;
  }

  // index — 시총 상위 홀딩(리밸런싱 없음). 상위 N 중 하나 매수 → 40% 상한 도달 후 자연 유지.
  const candidates = market.filter((p) => TOPCAP_KEYS.has(keyOf(p.entry.market, p.entry.symbol)));
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (!pick) return [];
  const qty = buyQty(pick, usdKrw, budgetKrw);
  return qty >= 1 ? [{ ...pick, side: "buy", qty }] : [];
}

/** market 주문 insert + fillOrder 직접 호출(web 시장가와 동일 경로). 거절은 정상 — 로그만. */
async function place(db: Db, bot: BotDef, seasonId: string, it: Intent, usdKrw: number): Promise<void> {
  const fx = fxOf(it.entry.market, usdKrw);
  const orderId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    userId: bot.id,
    seasonId,
    market: it.entry.market,
    symbol: it.entry.symbol,
    side: it.side,
    type: "market",
    qty: String(it.qty),
    fxRate: String(fx),
    idempotencyKey: orderId, // 봇은 재시도 없음 — 주문 id를 그대로 멱등키로
  });
  const res = await fillOrder(db, {
    orderId,
    userId: bot.id,
    seasonId,
    market: it.entry.market,
    symbol: it.entry.symbol,
    side: it.side,
    orderType: "market",
    qty: it.qty,
    filledPrice: it.tick.price,
    fxRate: fx,
  });
  if (!res.ok) console.log(`[bots] ${bot.name} ${it.side} ${it.entry.symbol} 스킵: ${res.reason}`);
}

async function loadHoldings(db: Db, seasonId: string, botIds: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: positions.userId, market: positions.market, symbol: positions.symbol, qty: positions.qty })
    .from(positions)
    .where(and(eq(positions.seasonId, seasonId), inArray(positions.userId, botIds)));
  const m = new Map<string, number>();
  for (const r of rows) m.set(`${r.userId}|${keyOf(r.market, r.symbol)}`, Number(r.qty));
  return m;
}

/** USDKRW 캐시(5분). 없으면 0 → US 주문은 스킵(환율 없이 체결 금지, B8). */
async function usdKrwOf(db: Db, cache: { rate: number; at: number }): Promise<number> {
  if (Date.now() - cache.at < 5 * 60 * 1000) return cache.rate;
  const [row] = await db.select({ rate: fxRates.rate }).from(fxRates).where(eq(fxRates.pair, FX_PAIR_USDKRW));
  cache.rate = row ? Number(row.rate) : 0;
  cache.at = Date.now();
  return cache.rate;
}

/**
 * 봇 루프 기동. BOT_INTERVAL_SEC·BOT_COUNT·BOT_ORDER_PCT 는 §4.3 "3분 관전 중 순위 변동 ≥1회"
 * 튜닝 레버 — 데모 조정을 코드 수정 없이 env로. DATABASE_URL 없으면 비활성(경고).
 */
export function startBots(book: PriceBook): void {
  const count = botCountOf(process.env.BOT_COUNT);
  if (count === 0) {
    console.log("[bots] BOT_COUNT=0 — 봇 비활성");
    return;
  }

  const db = getDb();
  if (!db) {
    console.warn("[bots] DATABASE_URL 미설정 — 봇 비활성(mock 로컬 데모 모드)");
    return;
  }

  const bots = buildBots(count);
  const intervalSec = envInt("BOT_INTERVAL_SEC", 45);
  const orderPct = envFloat("BOT_ORDER_PCT", 0.1);
  const cfg = seasonConfig();
  const botIds = bots.map((b) => b.id);
  const fxCache = { rate: 0, at: 0 };
  let seededUsers = false;
  let seededSeason: string | null = null;
  let running = false;

  // 봇별 이름이 달라 values 일괄 + 단일 set 이 불가 → 개별 멱등 upsert(전략 노출 배지 최신화).
  async function seedUsersEach(): Promise<void> {
    for (const b of bots) {
      await db!
        .insert(users)
        .values({ id: b.id, name: b.name, isBot: true })
        .onConflictDoUpdate({ target: users.id, set: { name: b.name, isBot: true } });
    }
  }

  async function seedAccounts(season: SeasonRow): Promise<void> {
    await db!
      .insert(accounts)
      .values(bots.map((b) => ({ userId: b.id, seasonId: season.id, cashKrw: season.seedMoney })))
      .onConflictDoNothing(); // 이미 있으면 유지(리셋 크론이 시드 재설정 담당)
  }

  async function loop(): Promise<void> {
    if (running) return;
    // 닫힌 시장이면 DB 안 건드림(Neon autosuspend 보존, B13) — 인메모리 시세북만 확인.
    const market = tradeable(book);
    if (market.length === 0) return;

    running = true;
    try {
      const season = await ensureActiveSeason(db!, cfg);
      if (!seededUsers) {
        await seedUsersEach();
        seededUsers = true;
      }
      if (seededSeason !== season.id) {
        await seedAccounts(season);
        seededSeason = season.id;
      }

      const usdKrw = await usdKrwOf(db!, fxCache);
      const budgetKrw = Number(season.seedMoney) * orderPct;
      const holdings = await loadHoldings(db!, season.id, botIds);
      for (const bot of bots) {
        for (const it of decide(bot, market, holdings, usdKrw, budgetKrw)) {
          await place(db!, bot, season.id, it, usdKrw);
        }
      }
    } catch (e) {
      console.error("[bots] 루프 오류", e);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void loop(), intervalSec * 1000);
  timer.unref?.();
  setTimeout(() => void loop(), 2000).unref?.(); // 데모 초기 반응 — 기동 직후 1회 선실행
  console.log(`[bots] ${bots.length}개 기동 (매 ${intervalSec}s, 주문 시드 대비 ${orderPct * 100}%)`);
}
