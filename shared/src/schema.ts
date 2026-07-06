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

/** 주간 시즌. 경계는 env 파라미터화(A15) — 단축 시즌으로 풀사이클 테스트. */
export const seasons = pgTable("seasons", {
  id: text("id").primaryKey(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  seedMoney: numeric("seed_money", { precision: 18, scale: 2 }).notNull(),
  status: seasonStatusEnum("status").notNull().default("active"),
});

/** 시즌별 현금 계좌. cashKrw는 예약분(A5) 차감 후 순액. 중간 합류 시 lazy upsert(A3). */
export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    cashKrw: numeric("cash_krw", { precision: 18, scale: 2 }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.seasonId] }),
    check("cash_krw_non_negative", sql`${t.cashKrw} >= 0`),
  ],
);

/** 시즌별 보유. costBasisKrw는 총 취득원가(KRW), realizedPnl은 환차손익 포함(B12). */
export const positions = pgTable(
  "positions",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    market: marketEnum("market").notNull(),
    symbol: text("symbol").notNull(),
    qty: numeric("qty", { precision: 20, scale: 6 }).notNull(),
    // 주당 평단가가 아니라 총 취득원가(KRW). 평단가는 costBasisKrw/qty 파생 표시.
    // 매도 시 수량 비례 원가만 차감 → 라운딩 누적 없이 Σ realizedPnl ≡ 현금 증감 성립(B12).
    costBasisKrw: numeric("cost_basis_krw", { precision: 18, scale: 2 }).notNull(),
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
    fxRate: numeric("fx_rate", { precision: 12, scale: 4 }), // 접수/체결 시점 환율 고정(A5)
    // 매수 지정가 접수 시 cashKrw에서 차감·예약한 원본 금액. 취소/만료/체결 차액 환불의
    // 단일 진실 원본 — 환불은 항상 이 값 기준(재계산 금지, 라운딩/환율 재조회로 인한 누수 방지).
    reservedKrw: numeric("reserved_krw", { precision: 18, scale: 2 }),
    status: orderStatusEnum("status").notNull().default("open"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    filledAt: timestamp("filled_at", { withTimezone: true }),
  },
  (t) => [
    // 접수 중복 차단은 유저 스코프 — 전역 유니크 금지(다른 유저의 우연한 키 충돌 방지).
    uniqueIndex("orders_user_idempotency_uq").on(t.userId, t.idempotencyKey),
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

/** 수익률 그래프·MDD 타이브레이커(A1) 원천. totalValueKrw는 예약 현금 포함(B11). */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seasonId: text("season_id").notNull().references(() => seasons.id),
    date: date("date").notNull(),
    totalValueKrw: numeric("total_value_krw", { precision: 18, scale: 2 }).notNull(),
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

/** 환율 단일 로우 per 통화쌍. 일 1회 갱신, 빈 응답 시 직전 값 유지(B8). */
export const fxRates = pgTable("fx_rates", {
  pair: text("pair").primaryKey(), // "USDKRW"
  rate: numeric("rate", { precision: 12, scale: 4 }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

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
