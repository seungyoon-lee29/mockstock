// DB 스키마 (drizzle · Postgres/Neon) — web·worker 공용.
// ponytail: T02가 최종화 + 첫 마이그레이션. 금액은 전부 numeric(float 금지),
// 정합성 최후 방어선으로 CHECK 제약을 건다(B12). Better Auth는 자체 세션/계정
// 테이블을 adapter로 생성하므로, 아래 users 확장은 T03에서 Better Auth 스키마와 정합.
import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  numeric,
  jsonb,
  timestamp,
  date,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

export const marketEnum = pgEnum("market", ["US", "KR"]);
export const currencyEnum = pgEnum("currency", ["USD", "KRW"]);
export const sideEnum = pgEnum("side", ["buy", "sell"]);
export const orderTypeEnum = pgEnum("order_type", ["market", "limit"]);
export const orderStatusEnum = pgEnum("order_status", [
  "open",
  "filled",
  "cancelled",
  "expired",
  "rejected",
]);
export const seasonStatusEnum = pgEnum("season_status", ["active", "finalized"]);

/** 앱 사용자. isBot = 공개 벤치마크 봇(공식 순위·뱃지 제외, A2). */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  // name·email은 nullable 유지 — 봇 시드·게스트는 email 없이 생성(Better Auth는 소셜 로그인 시 값 채움).
  name: text("name"),
  email: text("email").unique(),
  // Better Auth user 모델 필수 필드(T03). 봇/게스트 시드는 default로 흡수.
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  isBot: boolean("is_bot").notNull().default(false),
  // Better Auth anonymous 플러그인의 isAnonymous 필드와 정합(게스트 세션). 정식 로그인 전환 시 false로 승격.
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** 주간 시즌. 리그 ≡ 시장 1:1 — id = <isoStart>:US / :KR, seedMoney·seed는 리그별 네이티브. */
export const seasons = pgTable("seasons", {
  id: text("id").primaryKey(),
  market: marketEnum("market").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  seedMoney: numeric("seed_money", { precision: 18, scale: 2 }).notNull(),
  status: seasonStatusEnum("status").notNull().default("active"),
});

/** 시즌별 현금 계좌. cash는 예약분 차감 후 순액. 리그별 네이티브 통화(통화는 시즌 market이 함의; toCents/fromCents 사용). */
export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    cash: numeric("cash", { precision: 18, scale: 2 }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.seasonId] }),
    check("cash_non_negative", sql`${t.cash} >= 0`),
  ],
);

/** 시즌별 보유. costBasis는 총 취득원가(네이티브 통화), realizedPnl은 네이티브 손익(B12). */
export const positions = pgTable(
  "positions",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    market: marketEnum("market").notNull(),
    symbol: text("symbol").notNull(),
    qty: numeric("qty", { precision: 20, scale: 6 }).notNull(),
    // 리그별 네이티브 총 취득원가; toCents/fromCents 사용. 매도 시 수량 비례 원가만 차감 → Σ realizedPnl ≡ cash.
    costBasis: numeric("cost_basis", { precision: 18, scale: 2 }).notNull(),
    realizedPnl: numeric("realized_pnl", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.seasonId, t.market, t.symbol] }),
    check("qty_non_negative", sql`${t.qty} >= 0`),
  ],
);

/** 주문 = 체결 로그. 즉시체결(market)·미체결(limit). idempotencyKey로 접수 중복 차단. */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    market: marketEnum("market").notNull(),
    symbol: text("symbol").notNull(),
    side: sideEnum("side").notNull(),
    type: orderTypeEnum("type").notNull(),
    qty: numeric("qty", { precision: 20, scale: 6 }).notNull(),
    limitPrice: numeric("limit_price", { precision: 18, scale: 2 }),
    filledPrice: numeric("filled_price", { precision: 18, scale: 2 }),
    // 매수 지정가 접수 시 cash에서 차감·예약한 네이티브 원본 금액. 취소/만료/체결 차액 환불의 단일 진실 원본.
    reserved: numeric("reserved", { precision: 18, scale: 2 }),
    status: orderStatusEnum("status").notNull().default("open"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    filledAt: timestamp("filled_at", { withTimezone: true }),
  },
  (t) => [
    // 접수 중복 차단은 (유저, 시즌) 스코프 — 리그 간 같은 키 충돌 차단(season_id가 market 인코딩, BLOCKER).
    uniqueIndex("orders_user_season_idempotency_uq").on(t.userId, t.seasonId, t.idempotencyKey),
    // D4 인기 순위(당일 체결 건수, 리그 스코프) 집계용 — filled만 대상이라 partial index.
    index("orders_season_filled_symbol_idx")
      .on(t.seasonId, t.filledAt, t.symbol)
      .where(sql`${t.status} = 'filled'`),
  ],
);

/** 금요일 확정 랭킹. 봇 제외(WHERE is_bot=false, A2). */
export const seasonResults = pgTable(
  "season_results",
  {
    seasonId: text("season_id").notNull().references(() => seasons.id),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    returnPct: numeric("return_pct", { precision: 8, scale: 2 }).notNull(),
    mdd: numeric("mdd", { precision: 8, scale: 2 }).notNull(),
    finalValue: numeric("final_value", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.seasonId, t.userId] })],
);

/** 종목 마스터. lastPrice는 워커 재시작 워밍용 영속화(B1), prevClose는 07:30 크론 갱신(B7). */
export const instruments = pgTable(
  "instruments",
  {
    market: marketEnum("market").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    currency: currencyEnum("currency").notNull(),
    prevClose: numeric("prev_close", { precision: 18, scale: 2 }),
    prevCloseDate: date("prev_close_date"),
    lastPrice: numeric("last_price", { precision: 18, scale: 2 }),
    lastPriceAt: timestamp("last_price_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.market, t.symbol] })],
);

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    market: marketEnum("market").notNull(),
    symbol: text("symbol").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.market, t.symbol] })],
);

/** 수익률 그래프·MDD 타이브레이커(A1) 원천. totalValue는 예약 현금 포함(B11). */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    date: date("date").notNull(),
    // 리그별 네이티브 총자산(예약 현금 포함). 리그는 seasonId가 인코딩 → MDD·수익률 리그별 산출.
    totalValue: numeric("total_value", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seasonId, t.date] })],
);

/** 리플레이 성적(개인 기록만, 결정 #8). 게스트는 insert 생략 → userId nullable(A11). */
export const replaySessions = pgTable("replay_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  scenarioId: text("scenario_id").notNull(),
  returnPct: numeric("return_pct", { precision: 8, scale: 2 }),
  mdd: numeric("mdd", { precision: 8, scale: 2 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/**
 * 실시간 틱→1분 캔들 축적(P3-①, 멀티 타임프레임 차트). 워커가 장중에만 write(Neon 보존, B13),
 * web 종목상세가 백필 조회. v=집계 틱 수(피드가 거래량 미제공 → 체결 건수 대용). 보존 크론이 N일 초과 prune.
 * PK(market,symbol,ts)가 (market,symbol,ts) 범위 조회 인덱스를 겸함 → 별도 index 불필요.
 */
export const minuteCandles = pgTable(
  "minute_candles",
  {
    market: marketEnum("market").notNull(),
    symbol: text("symbol").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(), // 분 버킷 시작
    o: numeric("o", { precision: 18, scale: 2 }).notNull(),
    h: numeric("h", { precision: 18, scale: 2 }).notNull(),
    l: numeric("l", { precision: 18, scale: 2 }).notNull(),
    c: numeric("c", { precision: 18, scale: 2 }).notNull(),
    v: numeric("v", { precision: 20, scale: 0 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.market, t.symbol, t.ts] })],
);

/**
 * AI 투자 성향 요약 캐시 (§D8, 0005). 시즌×유저당 1로우 — GET lazy 생성.
 * status: 'pending'(생성 중 placeholder·lease) → 'ok' | 'insufficient'(체결 부족) | 'failed'(LLM 오류).
 * pending placeholder 단계에서는 summary/traits/model/input_hash 전부 NULL(계약).
 * - generation_started_at: lease 시각 — 만료(PROFILE_LEASE_MS) 후 다른 요청이 takeover.
 * - retry_after: insufficient/failed 재시도 허용 시각(즉시 재시도 폭주 차단).
 * - input_hash: 통계 직렬화 해시 — 불일치 시에만 재생성(가드 ③).
 * - model: LLM 생성 시 모델 id, 규칙 폴백이면 NULL → aiGenerated 파생.
 */
export const investmentProfiles = pgTable(
  "investment_profiles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "ok", "insufficient", "failed"] })
      .notNull()
      .default("pending"),
    summary: text("summary"),
    traits: jsonb("traits").$type<string[]>(),
    model: text("model"),
    inputHash: text("input_hash"),
    generationStartedAt: timestamp("generation_started_at", { withTimezone: true }),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seasonId] })],
);

// ── Better Auth adapter 테이블 (T03) ──────────────────────────────────────────
// user 모델은 위 `users` 테이블 재사용(auth.ts schema 매핑). session/account/verification은
// `auth_` 프리픽스로 — 도메인 accounts(시즌 계좌)와 Better Auth account(소셜 연동) 이름 충돌 회피(PRD §9).
// 컬럼 구조는 Better Auth v1.6 코어 스키마 계약 그대로(임의 변경 금지).

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_user_id_idx").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("auth_account_user_id_idx").on(t.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);
