# US·KR 리그 분리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시즌·계좌·주문·스냅샷을 시장 한정(market-qualified)으로 쪼개 US(USD $10,000)·KR(KRW ₩10,000,000)를 네이티브 통화 지갑 2개로 독립 운영하고, `fxRate` 환산 항을 게임 로직에서 완전히 제거한다.

**Architecture:** 의존 루트 **A(shared 계약)**가 스키마·상수·`fillOrder`·시즌 수명주기를 시장 인지로 확정하고 drizzle 마이그레이션을 생성한다. typecheck 게이트 후 **B(worker)**·**C(web API)**·**D(web UI)**가 서로소 파일 집합을 병렬 구현하고, **E**가 클린 컷오버 런북과 문서를 정리한다. 리그 ≡ 시장 1:1이라 `Σ realizedPnl ≡ cash` 불변식이 리그별 단일 통화로 단순해진다.

**Tech Stack:** TypeScript · drizzle-orm(Postgres/Neon) · Next.js 16(App Router) · node-cron 워커 · node:test + PGlite.

## Global Constraints
- **금액은 전부 `numeric`(float 금지).** `numeric(18,2)`는 USD 센트·KRW 정수원을 양쪽 다 담는다(현행 유지). 회계는 `fillOrder`가 센트 정수로 강제.
- **체결은 `shared/fillOrder()` 단일 함수로만.** web(시장가)·worker(지정가)·bots가 같은 함수를 호출한다. 체결 로직을 두 벌 만들지 말 것.
- **정확히-한-번(B10)**: `fillOrder` 첫 문장은 CAS(`UPDATE orders SET status='filled' … WHERE id=$1 AND status='open' RETURNING reserved`). 영향 0행이면 이후 전부 스킵. 현금 차감도 `SET cash = cash - $x WHERE cash >= $x` 조건부 원자 UPDATE.
- **리그별 회계 불변식**: `cash + Σ costBasis ≡ seed + Σ realizedPnl`(네이티브 통화, US·KR 각각). 교차 통화 항 제거로 fxRate 없이 성립.
- **멱등키 스코프**: `UNIQUE(user_id, season_id, key)`. 시즌이 season_id에 market을 인코딩하므로 리그 간 키 충돌 차단. 중복 접수는 에러가 아니라 원본 결과 재생.
- **신뢰 경계**: 클라이언트 입력은 `market`·`symbol`·`side`·`qty`·`limitPrice`·`idempotencyKey` 6개뿐. `userId`=세션, `seasonId`=서버가 주문 market으로 도출, 체결가=워커 스냅샷/매칭 도달가.
- **상승 빨강 / 하락 파랑**(한국 관례). **UI 텍스트는 한국어**. 금액·수량 포맷은 `web/src/lib/market/format.ts`(이미 `currency` 파라미터 받음) 사용.
- **하드코딩 금지** — URL·시크릿·매직 넘버·정책 값은 env·설정·`shared/` 상수로만. 코드 인라인 금지.
- **cron TZ Asia/Seoul**: 모든 `cron.schedule(...)`에 `{ timezone: 'Asia/Seoul' }` 필수(Railway=UTC라 누락 시 9h 어긋남).
- **Neon autosuspend(B13)**: DB 접근은 장중 한정. 확정·스냅샷은 각 시장 마감 직후 좁은 시간창에서만(상시 5분 스윕 금지).
- **자격증명 경계(B6/B14)**: `KIS_*`·`FINNHUB_*`·`DATA_GO_KR_*` 키는 워커 env에만. web에 두지 말 것.
- **Next.js 16 주의**: 학습 데이터와 다르다. 코드 작성 전 `web/node_modules/next/dist/docs/`의 관련 가이드를 먼저 읽을 것(D 태스크에 경로 명시).

---

## Phase A — shared 계약 (선행, 블로킹; typecheck 게이트 후 B/C/D)

> A 완료 후 **발행 계약**(B/C/D가 Consumes로 의존):
> - `weeklyPeriod(market: Market, now: Date): { startsAt: Date; endsAt: Date }`
> - `ensureActiveSeason(db: Db, cfg: SeasonConfig, market: Market): Promise<SeasonRow>` — `cfg`는 필수(기본값 없음; 필수 `market`이 뒤라 TS 규칙), `SeasonRow`에 `market: Market` 추가
> - `resetSeason(db: Db, cfg: SeasonConfig, market: Market): Promise<SeasonRow>`
> - `positionLimit(seedMoney: number): number` (구 `positionLimitKrw`)
> - `SEED_MONEY_USD = 10_000`, `SEED_MONEY_KRW = 10_000_000`, `SEED_MONEY: Record<Market, number>`
> - `FillInput` — `fxRate` 필드 **없음**, `reserved?: string`(구 `reservedKrw`)
> - `amountCents(price: number, qty: number): number` (내부 함수, 시그니처만 참고)
> - 시장 한정 시즌 id 규약: 주간 `<isoStart>:US` / `<isoStart>:KR`, 단축 `season_<iso>:<market>`
> - 스키마 컬럼: `accounts.cash`·`positions.costBasis`·`orders.reserved`·`portfolioSnapshots.totalValue` (전부 구 `*Krw` 제거), `orders.fxRate` DROP, `fxRates` 테이블 DROP, `seasons.market`(marketEnum NOT NULL)

### Task A1 — schema.ts: market 컬럼 · rename · 멱등 유니크 · fxRates DROP + drizzle 마이그레이션

**Files:**
- Modify: `shared/src/schema.ts:54` (seasons), `:63` (accounts), `:78` (positions), `:100` (orders), `:170` (portfolioSnapshots), `:213` (fxRates 삭제)
- Create: `shared/drizzle/0003_*.sql` (drizzle-kit 생성 — 다음 순번)
- Test: `shared/src/fillOrder.test.ts`·`shared/src/seasons.test.ts`가 마이그레이션 SQL을 로드하므로 A3/A4에서 갱신. A1 자체 게이트는 `npm run typecheck`.

**Interfaces:**
- Produces: `seasons.market`(marketEnum NOT NULL), `accounts.cash`, `positions.costBasis`, `orders.reserved`(fxRate 컬럼 삭제), `portfolioSnapshots.totalValue`, 멱등 유니크 `UNIQUE(user_id, season_id, idempotency_key)`, `fxRates` 테이블 제거.

**Steps:**
- [ ] `seasons` 테이블에 `market` 컬럼 추가. 현재 `shared/src/schema.ts:54-60`:
  ```ts
  export const seasons = pgTable("seasons", {
    id: text("id").primaryKey(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    seedMoney: numeric("seed_money", { precision: 18, scale: 2 }).notNull(),
    status: seasonStatusEnum("status").notNull().default("active"),
  });
  ```
  로 교체:
  ```ts
  /** 주간 시즌. 리그 ≡ 시장 1:1 — id = <isoStart>:US / :KR, seedMoney·seed는 리그별 네이티브. */
  export const seasons = pgTable("seasons", {
    id: text("id").primaryKey(),
    market: marketEnum("market").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    seedMoney: numeric("seed_money", { precision: 18, scale: 2 }).notNull(),
    status: seasonStatusEnum("status").notNull().default("active"),
  });
  ```
- [ ] `accounts.cashKrw` → `cash` (컬럼 코멘트로 네이티브 통화 명시). 현재 `:62-75`:
  ```ts
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
  ```
  로 교체:
  ```ts
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
  ```
- [ ] `positions.costBasisKrw` → `costBasis`. 현재 `:77-97`의 컬럼 정의 `:88`:
  ```ts
      costBasisKrw: numeric("cost_basis_krw", { precision: 18, scale: 2 }).notNull(),
  ```
  를:
  ```ts
      // 리그별 네이티브 총 취득원가; toCents/fromCents 사용. 매도 시 수량 비례 원가만 차감 → Σ realizedPnl ≡ cash.
      costBasis: numeric("cost_basis", { precision: 18, scale: 2 }).notNull(),
  ```
  로 교체(주석 `:77`·`:86-87`의 KRW 언급도 "네이티브 총 취득원가"로 정리).
- [ ] `orders`: `fxRate` 컬럼 DROP + `reservedKrw` → `reserved` + 멱등 유니크 스코프 확장. 현재 `:99-126`의 `:113`·`:116`·`:122-124`:
  ```ts
      fxRate: numeric("fx_rate", { precision: 12, scale: 4 }), // 접수/체결 시점 환율 고정(A5)
      // 매수 지정가 접수 시 cashKrw에서 차감·예약한 원본 금액. …
      reservedKrw: numeric("reserved_krw", { precision: 18, scale: 2 }),
  ```
  →
  ```ts
      // 매수 지정가 접수 시 cash에서 차감·예약한 네이티브 원본 금액. 취소/만료/체결 차액 환불의 단일 진실 원본.
      reserved: numeric("reserved", { precision: 18, scale: 2 }),
  ```
  (`fxRate` 줄 삭제). 그리고 유니크 인덱스 `:122-124`:
  ```ts
      // 접수 중복 차단은 유저 스코프 — 전역 유니크 금지(다른 유저의 우연한 키 충돌 방지).
      uniqueIndex("orders_user_idempotency_uq").on(t.userId, t.idempotencyKey),
  ```
  →
  ```ts
      // 접수 중복 차단은 (유저, 시즌) 스코프 — 리그 간 같은 키 충돌 차단(season_id가 market 인코딩, BLOCKER).
      uniqueIndex("orders_user_season_idempotency_uq").on(t.userId, t.seasonId, t.idempotencyKey),
  ```
- [ ] `portfolioSnapshots.totalValueKrw` → `totalValue`. 현재 `:169-179`의 `:176`:
  ```ts
      totalValueKrw: numeric("total_value_krw", { precision: 18, scale: 2 }).notNull(),
  ```
  →
  ```ts
      // 리그별 네이티브 총자산(예약 현금 포함). 리그는 seasonId가 인코딩 → MDD·수익률 리그별 산출.
      totalValue: numeric("total_value", { precision: 18, scale: 2 }).notNull(),
  ```
- [ ] `fxRates` 테이블 삭제. 현재 `:212-217`:
  ```ts
  /** 환율 단일 로우 per 통화쌍. 일 1회 갱신, 빈 응답 시 직전 값 유지(B8). */
  export const fxRates = pgTable("fx_rates", {
    pair: text("pair").primaryKey(), // "USDKRW"
    rate: numeric("rate", { precision: 12, scale: 4 }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  });
  ```
  블록 전체 삭제. `seasonResults.finalValue`(`:137`)는 **이름 유지**(의미만 네이티브) — 손대지 않는다.
- [ ] `npm run db:generate -w shared` 실행. 기대: `shared/drizzle/0003_*.sql` 생성 + `meta/_journal.json`에 `idx:3` 엔트리 추가.
  ```
  npm run db:generate -w shared
  # 기대 출력: [✓] Your SQL migration file ➜ drizzle/0003_….sql 🚀
  ```
- [ ] 생성된 `0003_*.sql` **육안 검증**. drizzle-kit이 rename을 신뢰 못 해 `ALTER TABLE … RENAME COLUMN` 대신 **DROP+ADD**로 냈을 수 있다 — **클린 컷오버라 데이터 wipe 허용**(E1 런북이 이력 폐기 명시). 확인 항목: (1) `seasons` 에 `market` 컬럼 ADD, (2) `accounts.cash`·`positions.cost_basis`·`orders.reserved`·`portfolio_snapshots.total_value` 존재, (3) `orders.fx_rate` DROP, (4) `fx_rates` 테이블 DROP, (5) `orders_user_season_idempotency_uq` 유니크 생성. RENAME이 아니면 SQL 상단에 `-- CLEAN CUTOVER: 컬럼 DROP+ADD = 기존 데이터 폐기(E1 런북). 출시 전 개발 DB라 허용.` 주석 1줄 추가.
- [ ] Gate: `npm run typecheck` (shared + worker). 기대: shared 통과. **worker/web은 A2~A4·B·C 전까지 실패가 정상** — A1 단독 게이트는 shared 컴파일만 확인(`npx tsc -p shared/tsconfig.json --noEmit` 통과).
- [ ] 커밋:
  ```
  git add shared/src/schema.ts shared/drizzle/0003_*.sql shared/drizzle/meta/
  git commit -m "feat(schema): 시장 한정 시즌·네이티브 통화 컬럼·멱등 스코프·fxRates 드롭

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task A2 — rules.ts: SEED_MONEY_USD 추가 · positionLimit rename · FX 상수 삭제

**Files:**
- Modify: `shared/src/rules.ts:4` (SEED 상수), `:10` (positionLimitKrw), `:30` (FX_PAIR_USDKRW 삭제)
- Test: 소비처 typecheck로 검증(rename 파급). 게이트 `npm run typecheck`.

**Interfaces:**
- Produces: `SEED_MONEY_USD = 10_000`, `SEED_MONEY: Record<Market, number>`, `positionLimit(seedMoney: number): number`.
- Consumes(삭제 대상 grep): `positionLimitKrw`(현재 미사용 확인)·`FX_PAIR_USDKRW`(seasons.ts·fx.ts·matching.ts·orders route·portfolio route·leaderboard route·bots.ts에서 import) — B/C가 각자 제거.

**Steps:**
- [ ] `Market` 타입 import 추가 + 시드 상수 확장. 현재 `shared/src/rules.ts:3-11`:
  ```ts
  /** 시즌 시작 시드 현금(KRW). "시드 1,000만"(§5.3 lazy upsert). */
  export const SEED_MONEY_KRW = 10_000_000;

  /** 종목당 매수 상한 = 시드의 40%(§4.2 몰빵 방지 → 최소 3종목 분산 강제). */
  export const POSITION_LIMIT_PCT = 0.4;

  /** 시드머니 기준 종목당 매수 상한 금액(KRW). 40% 상한 재검증(§6.4)에서 사용. */
  export function positionLimitKrw(seedMoneyKrw: number): number {
    return seedMoneyKrw * POSITION_LIMIT_PCT;
  }
  ```
  로 교체(파일 최상단에 `import type { Market } from "./types";` 추가):
  ```ts
  /** 시즌 시작 시드 현금 — 리그별 네이티브 통화. KR ₩10,000,000 / US $10,000. */
  export const SEED_MONEY_KRW = 10_000_000;
  export const SEED_MONEY_USD = 10_000;
  /** 리그 → 시드 맵. 시즌 생성·봇 예산이 market으로 조회. */
  export const SEED_MONEY: Record<Market, number> = { KR: SEED_MONEY_KRW, US: SEED_MONEY_USD };

  /** 종목당 매수 상한 = 시드의 40%(§4.2 몰빵 방지 → 최소 3종목 분산 강제). */
  export const POSITION_LIMIT_PCT = 0.4;

  /** 시드머니 기준 종목당 매수 상한(네이티브 통화, currency-agnostic). 40% 상한 재검증(§6.4). */
  export function positionLimit(seedMoney: number): number {
    return seedMoney * POSITION_LIMIT_PCT;
  }
  ```
- [ ] `FX_PAIR_USDKRW` 삭제. 현재 `:29-30`:
  ```ts
  /** 환율 단일 로우 키(fx_rates.pair). seasons 평가·fx 갱신 공용(§6.6). */
  export const FX_PAIR_USDKRW = "USDKRW";
  ```
  블록 삭제(그 위 `:20`의 "환율 로우 키" 주석 언급도 제거).
- [ ] Gate: `npm run typecheck`. 기대: **shared는 통과**하되 `positionLimitKrw`/`FX_PAIR_USDKRW`를 아직 import하는 파일이 있으면 그 파일에서 실패 — 그 실패 목록은 A3/A4/B/C가 소비할 대상. shared 단독은 `npx tsc -p shared/tsconfig.json --noEmit`로 확인(fillOrder.ts·seasons.ts는 A3/A4에서 갱신되므로 이 시점 실패 허용).
- [ ] 커밋:
  ```
  git add shared/src/rules.ts
  git commit -m "feat(rules): SEED_MONEY_USD·SEED_MONEY 맵·positionLimit(통화불문)·FX_PAIR 삭제

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task A3 — fillOrder.ts: fxRate 드롭 · amountCents(price,qty) · 네이티브 cash/reserved (TDD)

**Files:**
- Modify: `shared/src/fillOrder.ts:24` (import), `:28-44` (FillInput), `:66-68` (amountCents), `:79-231` (본문 cashKrw→cash·costBasisKrw→costBasis·reservedKrw→reserved·fxRate 제거)
- Test: `shared/src/fillOrder.test.ts` (전면 재파라미터화 — 두 리그 픽스처 + 리그별 불변식)

**Interfaces:**
- Consumes: `positionLimit`, `SEED_MONEY_KRW`, `SEED_MONEY_USD` (A2). 스키마 컬럼 `accounts.cash`·`positions.costBasis`·`orders.reserved` (A1).
- Produces: `FillInput`(no `fxRate`, `reserved?: string`), `amountCents(price, qty)`.

**Steps:**
- [ ] **실패 테스트 먼저** — `fillOrder.test.ts`를 두 리그·네이티브로 재작성. 현재 `:31-46`의 `newDb`가 단일 `s1` 시즌 + `fxRates` insert:
  ```ts
  async function newDb(cash = SEED): Promise<DB> {
    const client = new PGlite();
    const db = drizzle(client);
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
      await client.exec(readFileSync(join(migrationsDir, f), "utf8"));
    }
    await db.insert(users).values({ id: "u1", name: "테스터" });
    await db.insert(seasons).values({
      id: "s1",
      startsAt: new Date("2026-07-01T00:00:00Z"),
      endsAt: new Date("2026-07-31T00:00:00Z"),
      seedMoney: String(SEED),
    });
    await db.insert(accounts).values({ userId: "u1", seasonId: "s1", cashKrw: cash.toFixed(2) });
    return db;
  }
  ```
  를 두 리그 시즌 생성으로:
  ```ts
  import { SEED_MONEY_KRW, SEED_MONEY_USD } from "./rules";
  const SEED_KR = SEED_MONEY_KRW; // 1,000만
  const SEED_US = SEED_MONEY_USD; // 1만
  /** 리그별 시즌 id + 시드. KR=원, US=달러 네이티브. */
  const SEASON = { KR: "s_kr", US: "s_us" } as const;
  async function newDb(cashKr = SEED_KR, cashUs = SEED_US): Promise<DB> {
    const client = new PGlite();
    const db = drizzle(client);
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
      await client.exec(readFileSync(join(migrationsDir, f), "utf8"));
    }
    await db.insert(users).values({ id: "u1", name: "테스터" });
    await db.insert(seasons).values([
      { id: SEASON.KR, market: "KR", startsAt: new Date("2026-07-01T00:00:00Z"), endsAt: new Date("2026-07-31T00:00:00Z"), seedMoney: String(SEED_KR) },
      { id: SEASON.US, market: "US", startsAt: new Date("2026-07-01T00:00:00Z"), endsAt: new Date("2026-07-31T00:00:00Z"), seedMoney: String(SEED_US) },
    ]);
    await db.insert(accounts).values([
      { userId: "u1", seasonId: SEASON.KR, cash: cashKr.toFixed(2) },
      { userId: "u1", seasonId: SEASON.US, cash: cashUs.toFixed(2) },
    ]);
    return db;
  }
  ```
  `placeOrder`/`fill`/`cashCents`/`pos`도 시즌 인자를 받게 수정: `placeOrder(db,{ seasonId, market, ... })`에서 `fxRate` 필드 제거, `orders` insert에서 `fxRate` 컬럼 제거·`cashKrw`→`cash` 참조 갱신. `fill`은 `{ orderId, userId, seasonId, ...i }`에서 `i`에 `fxRate` 없음. 기존 US 테스트 ④·⑤·⑧은 **네이티브 USD**로 재작성(예: ④ 매수 `filledPrice:230, qty:4` → 원가 `230*4=920` USD, 매도 `filledPrice:250, qty:2` → 대금 `500`, 차감원가 `460`, realized `40`). 불변식 테스트 ⑧은 KR·US **각 리그별로** `cash + ΣcostBasis ≡ seed + ΣrealizedPnl` 검증(리그별 두 번).
- [ ] 실패 확인:
  ```
  npm test -w shared -- fillOrder.test.ts
  # 기대 FAIL: FillInput/amountCents 시그니처 불일치 + cash/reserved 컬럼 미존재로 컴파일·실행 에러
  ```
- [ ] **최소 구현** — `FillInput`에서 `fxRate` 드롭 + `reservedKrw`→`reserved`. 현재 `:35-44`:
  ```ts
    orderType: "market" | "limit";
    qty: number;
    /** 체결가 (워커 스냅샷 또는 매칭 도달가). 클라이언트 값 금지. */
    filledPrice: number;
    /** US는 접수/체결 시점 고정 환율, KR은 1. */
    fxRate: number;
    /** 지정가 매수 접수 시 예약한 원본 금액(orders.reservedKrw). 차액 환급의 기준값. */
    reservedKrw?: string;
  }
  ```
  →
  ```ts
    orderType: "market" | "limit";
    qty: number;
    /** 체결가 (워커 스냅샷 또는 매칭 도달가, 네이티브 통화). 클라이언트 값 금지. */
    filledPrice: number;
    /** 지정가 매수 접수 시 예약한 네이티브 원본 금액(orders.reserved). 차액 환급의 기준값. */
    reserved?: string;
  }
  ```
- [ ] `amountCents` 시그니처 축소. 현재 `:65-68`:
  ```ts
  /** 체결금액(KRW)을 센트 정수로. 체결가·환율은 float이라도 여기서 한 번만 반올림한다. */
  function amountCents(price: number, fxRate: number, qty: number): number {
    return Math.round(price * fxRate * qty * 100);
  }
  ```
  →
  ```ts
  /** 체결금액(네이티브 통화)을 센트 정수로. float 체결가라도 여기서 한 번만 반올림한다. */
  function amountCents(price: number, qty: number): number {
    return Math.round(price * qty * 100);
  }
  ```
- [ ] 본문 컬럼 참조 갱신 + fxRate 제거. `:24` import를 `import { accounts, orders, positions, seasons } from "./schema";` 유지, `:25`를 `import { POSITION_LIMIT_PCT } from "./rules";` 유지. 본문에서:
  - `:82-90` CAS `.set({ status:"filled", filledPrice:…, fxRate: String(input.fxRate), … })`에서 `fxRate:` 줄 삭제, `.returning({ reservedKrw: orders.reservedKrw })` → `.returning({ reserved: orders.reserved })`.
  - `:93` `const reservedKrw = claimed[0].reservedKrw;` → `const reserved = claimed[0].reserved;` (이하 참조 전부 `reserved`).
  - `:97-108` `reject`의 환불 `.set({ cashKrw: sql`${accounts.cashKrw} + ${reservedKrw}::numeric` })` → `.set({ cash: sql`${accounts.cash} + ${reserved}::numeric` })`, `.set({ status:"rejected", filledPrice:null, fxRate:null, filledAt:null })`에서 `fxRate:null` 삭제.
  - `:120-121` 매도 select `cost: positions.costBasisKrw` → `cost: positions.costBasis`.
  - `:129` `amountCents(input.filledPrice, input.fxRate, qty)` → `amountCents(input.filledPrice, qty)`.
  - `:136-148` 매도 update `costBasisKrw: sql`${positions.costBasisKrw} - …`` → `costBasis: sql`${positions.costBasis} - …``, 계좌 credit `cashKrw` → `cash`.
  - `:154` 매수 `amountCents(input.filledPrice, input.fxRate, qty)` → `amountCents(input.filledPrice, qty)`.
  - `:163` `positionLimit`은 `POSITION_LIMIT_PCT` 인라인 계산이라 그대로(`Math.round(toCents(season.seed) * POSITION_LIMIT_PCT)`).
  - `:166` posLock `cost: positions.costBasisKrw` → `costBasis`. `:173` openBuys `reserved: orders.reservedKrw` → `reserved: orders.reserved`.
  - `:195` `reservedKrw != null ? toCents(reservedKrw)` → `reserved != null ? toCents(reserved)`.
  - `:199-214` 지정가 환급/시장가 차감 `cashKrw` → `cash`(3곳).
  - `:221-228` positions insert/update `costBasisKrw: cost` → `costBasis: cost`(2곳).
  - 파일 상단 불변식 주석 `②`~`⑤`(`:8-16`)의 `× fxRate`·`cash_krw`·`costBasisKrw` 언급을 네이티브·`cash`·`costBasis`로 정리.
- [ ] PASS 확인:
  ```
  npm test -w shared -- fillOrder.test.ts
  # 기대 PASS: 리그별 불변식 2건 포함 전 테스트 통과
  ```
- [ ] 커밋:
  ```
  git add shared/src/fillOrder.ts shared/src/fillOrder.test.ts
  git commit -m "feat(fillOrder): fxRate 제거·네이티브 cash/reserved/costBasis·리그별 불변식 테스트

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task A4 — seasons.ts: 시장 인지 경계·수명주기 + US 금요일 경계 (TDD)

**Files:**
- Modify: `shared/src/seasons.ts:10-30` (import), `:41-47` (SeasonRow), `:62-86` (weeklyPeriod/currentPeriod), `:129-153` (loadUsdKrw·holdingsCents), `:159-182` (ensureActiveSeason), `:189-214` (resetSeason), `:220-323` (finalize·컬럼 rename), `:330-381` (snapshot·컬럼 rename)
- Test: `shared/src/seasons.test.ts` (두 리그 + US 금요일 경계 + fxRates 제거)

**Interfaces:**
- Consumes: `SEED_MONEY`(A2), `marketSession`/tz 계산(`marketCalendar.ts` — `America/New_York`). 스키마 `accounts.cash`·`positions.costBasis`·`portfolioSnapshots.totalValue`·`seasons.market`(A1).
- Produces: `weeklyPeriod(market, now)`, `ensureActiveSeason(db, cfg, market)`, `resetSeason(db, cfg, market)`, `SeasonRow`(+`market`). `finalizeDueSeasons(db)`·`snapshotPortfolios(db)`는 시그니처 유지(내부 시장 인지).

**Steps:**
- [ ] **실패 테스트 먼저** — `seasons.test.ts` 재파라미터화. 현재 `:36-59`의 `CFG`·`newDb`가 단일 시즌 + `fxRates` insert. `fxRates` import(`:15`)·insert(`:58`)·`loadUsdKrw` 관련 검증 **삭제**, `ensureActiveSeason(db, CFG)` 호출 전부 `ensureActiveSeason(db, CFG, "KR")`로. US 종목 평가는 이제 **USD 네이티브**(환산 없음) — ① 풀사이클을 KR·US 두 시즌으로 갈라 각 리그 finalValue 검증. 신규 테스트 추가:
  ```ts
  test("⑦ US 금요일 경계: endsAt이 미 동부 금 16:00(≈토 05:00 KST) 이후", () => {
    // 금요일 정규장 중(미 동부 14:00 ET = 목/금 KST) 시각을 넣어 그 주 endsAt을 검증.
    const during = new Date("2026-07-10T18:00:00Z"); // 금 14:00 ET (여름 DST −4h)
    const { endsAt } = weeklyPeriod("US", during);
    // 금 16:00 ET = 20:00Z 이후여야 금요일 장 체결이 정산에 포함(경계 회귀 방지).
    assert.ok(endsAt.getTime() >= new Date("2026-07-10T20:00:00Z").getTime());
    // KR 같은 주는 금 15:30 KST = 06:30Z (US보다 이르다).
    const kr = weeklyPeriod("KR", during);
    assert.ok(kr.endsAt.getTime() < endsAt.getTime());
  });
  ```
- [ ] 실패 확인:
  ```
  npm test -w shared -- seasons.test.ts
  # 기대 FAIL: weeklyPeriod 인자 개수·ensureActiveSeason 시그니처·cash/costBasis 컬럼 불일치
  ```
- [ ] **최소 구현** — import 정리. 현재 `:10-30`:
  ```ts
  import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
  import type { PgDatabase } from "drizzle-orm/pg-core";
  import {
    accounts, fxRates, instruments, orders, portfolioSnapshots, positions, seasonResults, seasons, users,
  } from "./schema";
  import {
    FX_PAIR_USDKRW, SEASON_END_HOUR_KST, SEASON_END_MINUTE_KST, SEASON_END_WEEKDAY, SEASON_START_WEEKDAY, SEED_MONEY_KRW,
  } from "./rules";
  ```
  →
  ```ts
  import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
  import type { PgDatabase } from "drizzle-orm/pg-core";
  import {
    accounts, instruments, orders, portfolioSnapshots, positions, seasonResults, seasons, users,
  } from "./schema";
  import {
    SEASON_END_HOUR_KST, SEASON_END_MINUTE_KST, SEASON_END_WEEKDAY, SEASON_START_WEEKDAY, SEED_MONEY,
  } from "./rules";
  import type { Market } from "./types";
  ```
- [ ] `SeasonConfig`/`SeasonRow`에 market 반영. 현재 `:34-47`: `SeasonConfig.seedMoney` 주석의 "(KRW)"·"SEED_MONEY_KRW" 언급을 "리그별 네이티브; 미지정 시 SEED_MONEY[market]"로. `SeasonRow`에 `market: Market;` 필드 추가. `seedMoneyOf`(`:52-54`)를 market 인지로:
  ```ts
  function seedMoneyOf(cfg: SeasonConfig, market: Market): number {
    return cfg.seedMoney ?? SEED_MONEY[market];
  }
  ```
- [ ] `weeklyPeriod`를 market 인지로. 현재 `:61-72`:
  ```ts
  function weeklyPeriod(now: Date): { startsAt: Date; endsAt: Date } {
    const kst = new Date(now.getTime() + KST_OFFSET_MS);
    const daysSinceStart = (kst.getUTCDay() - SEASON_START_WEEKDAY + 7) % 7;
    const startMondayUtc =
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - daysSinceStart) - KST_OFFSET_MS;
    const endOffsetMs =
      (SEASON_END_WEEKDAY - SEASON_START_WEEKDAY) * DAY_MS +
      (SEASON_END_HOUR_KST * 60 + SEASON_END_MINUTE_KST) * 60 * 1000;
    return { startsAt: new Date(startMondayUtc), endsAt: new Date(startMondayUtc + endOffsetMs) };
  }
  ```
  를 KR=기존 금 15:30 KST 경계 유지, US=그 주 금요일 미 동부 16:00 ET를 tz로 계산하는 형태로 교체. `marketCalendar.ts`의 `localParts` 패턴을 재사용하되 seasons 내부에 로컬 헬퍼로 두는 게 아니라 **금요일 시작 월요일에서 US 마감 절대시각을 Intl로 산출**:
  ```ts
  /** market → 그 주 시즌 경계. KR=월00:00→금15:30 KST, US=월(현지)→금16:00 ET(DST 자동, ≈토05:00 KST). */
  function weeklyPeriod(market: Market, now: Date): { startsAt: Date; endsAt: Date } {
    const kst = new Date(now.getTime() + KST_OFFSET_MS);
    const daysSinceStart = (kst.getUTCDay() - SEASON_START_WEEKDAY + 7) % 7;
    const startMondayUtc =
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - daysSinceStart) - KST_OFFSET_MS;
    if (market === "KR") {
      const endOffsetMs =
        (SEASON_END_WEEKDAY - SEASON_START_WEEKDAY) * DAY_MS +
        (SEASON_END_HOUR_KST * 60 + SEASON_END_MINUTE_KST) * 60 * 1000;
      return { startsAt: new Date(startMondayUtc), endsAt: new Date(startMondayUtc + endOffsetMs) };
    }
    // US: 시작 월요일이 속한 주의 금요일 16:00 America/New_York을 tz로 산출(DST 자동).
    const friUtcNoon = new Date(startMondayUtc + 4 * DAY_MS + 12 * 60 * 60 * 1000); // 금요일 정오 UTC(날짜 안정)
    const endsAt = zonedTimeToUtc("America/New_York", friUtcNoon, 16, 0);
    return { startsAt: new Date(startMondayUtc), endsAt };
  }

  /** 주어진 UTC 날짜의 현지(tz) HH:MM을 UTC Date로 환산. marketCalendar와 동일 Intl tz 규약. */
  function zonedTimeToUtc(tz: string, dayAnchor: Date, hour: number, minute: number): Date {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(dayAnchor);
    const p: Record<string, string> = {};
    for (const { type, value } of parts) p[type] = value;
    // dayAnchor를 tz 벽시계로 보고 그 날짜의 hour:minute을 만든 뒤, tz offset을 빼 UTC로.
    const wallUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, minute);
    const tzOffsetMs = wallUtc - dayAnchorLocalMs(tz, dayAnchor);
    return new Date(wallUtc - (wallUtc - (dayAnchor.getTime() - tzOffsetMs)) + (dayAnchor.getTime() - dayAnchor.getTime()));
  }
  ```
  > **구현 노트(worker에게):** 위 `zonedTimeToUtc`의 offset 산출은 손이 많이 가므로, 실제로는 `marketCalendar.ts`가 이미 가진 tz 오프셋 계산을 재사용하라. 가장 단순한 정확 구현: `dayAnchor`(금요일 정오 UTC)에 대해 `Intl.DateTimeFormat(en-US,{timeZone:tz,timeZoneName:'shortOffset'})`로 오프셋 문자열("GMT-4")을 얻어 분으로 파싱 → `Date.UTC(y,mo,d,16,0) - offsetMinutes*60000`. 테스트 ⑦(여름 −4h → 20:00Z, 겨울 −5h → 21:00Z 경계)로 DST 양쪽 검증. **KST 절대시각 하드코딩 금지**(rules/worker.md) — US 경계는 반드시 tz 계산 경유.
- [ ] `currentPeriod`를 market 인지로 + 시장 한정 id. 현재 `:75-86`:
  ```ts
  function currentPeriod(now: Date, cfg: SeasonConfig): { id: string; startsAt: Date; endsAt: Date } {
    if (cfg.durationMs && cfg.durationMs > 0) {
      const startMs = Math.floor(now.getTime() / cfg.durationMs) * cfg.durationMs;
      return { id: `season_${new Date(startMs).toISOString()}`, startsAt: new Date(startMs), endsAt: new Date(startMs + cfg.durationMs) };
    }
    const { startsAt, endsAt } = weeklyPeriod(now);
    return { id: `season_${startsAt.toISOString()}`, startsAt, endsAt };
  }
  ```
  →
  ```ts
  function currentPeriod(now: Date, cfg: SeasonConfig, market: Market): { id: string; startsAt: Date; endsAt: Date } {
    if (cfg.durationMs && cfg.durationMs > 0) {
      const startMs = Math.floor(now.getTime() / cfg.durationMs) * cfg.durationMs;
      return { id: `season_${new Date(startMs).toISOString()}:${market}`, startsAt: new Date(startMs), endsAt: new Date(startMs + cfg.durationMs) };
    }
    const { startsAt, endsAt } = weeklyPeriod(market, now);
    return { id: `season_${startsAt.toISOString()}:${market}`, startsAt, endsAt };
  }
  ```
- [ ] `loadUsdKrw` 삭제(`:138-142`), `holdingsCents`에서 `usdKrw` 항 제거. 현재 `:144-153`:
  ```ts
  function holdingsCents(rows: PositionRow[], prices: PriceMap, usdKrw: number): number {
    let sum = 0;
    for (const p of rows) {
      const price = prices.get(`${p.market}:${p.symbol}`);
      if (price == null) continue;
      sum += Number(p.qty) * price * (p.market === "US" ? usdKrw : 1);
    }
    return Math.round(sum * 100);
  }
  ```
  →
  ```ts
  /** 보유 평가액(네이티브 통화 센트). 리그가 seasonId로 분리되므로 포지션은 단일 통화 — 환산 없음. */
  function holdingsCents(rows: PositionRow[], prices: PriceMap): number {
    let sum = 0;
    for (const p of rows) {
      const price = prices.get(`${p.market}:${p.symbol}`);
      if (price == null) continue;
      sum += Number(p.qty) * price;
    }
    return Math.round(sum * 100);
  }
  ```
- [ ] `ensureActiveSeason`에 market 파라미터 + `WHERE market=$market`. 현재 `:159-182`:
  ```ts
  export async function ensureActiveSeason(db: Db, cfg: SeasonConfig = {}): Promise<SeasonRow> {
    const now = new Date();
    const [live] = await db
      .select().from(seasons)
      .where(and(eq(seasons.status, "active"), gt(seasons.endsAt, now)))
      .orderBy(desc(seasons.startsAt)).limit(1);
    if (live) return live as SeasonRow;
    const p = currentPeriod(now, cfg);
    await db.insert(seasons).values({ id: p.id, startsAt: p.startsAt, endsAt: p.endsAt, seedMoney: seedMoneyOf(cfg).toFixed(2), status: "active" })
      .onConflictDoNothing({ target: seasons.id });
    const [s] = await db.select().from(seasons).where(eq(seasons.id, p.id));
    return s as SeasonRow;
  }
  ```
  →
  ```ts
  // 주의: TS는 필수 파라미터를 optional 뒤에 못 둔다 — `cfg`의 기본값(`= {}`)을 제거해 필수화(호출부는 전부 cfg 전달).
  export async function ensureActiveSeason(db: Db, cfg: SeasonConfig, market: Market): Promise<SeasonRow> {
    const now = new Date();
    const [live] = await db
      .select().from(seasons)
      .where(and(eq(seasons.status, "active"), eq(seasons.market, market), gt(seasons.endsAt, now)))
      .orderBy(desc(seasons.startsAt)).limit(1);
    if (live) return live as SeasonRow;
    const p = currentPeriod(now, cfg, market);
    await db.insert(seasons).values({ id: p.id, market, startsAt: p.startsAt, endsAt: p.endsAt, seedMoney: seedMoneyOf(cfg, market).toFixed(2), status: "active" })
      .onConflictDoNothing({ target: seasons.id });
    const [s] = await db.select().from(seasons).where(eq(seasons.id, p.id));
    return s as SeasonRow;
  }
  ```
- [ ] `resetSeason`에 market 파라미터 + 로스터 이관 시 `cashKrw`→`cash`·직전 시즌도 같은 market으로 한정. 현재 `:189-214`:
  ```ts
  export async function resetSeason(db: Db, cfg: SeasonConfig = {}): Promise<SeasonRow> {
    const season = await ensureActiveSeason(db, cfg);
    const seedStr = seedMoneyOf(cfg).toFixed(2);
    const [prior] = await db.select({ id: seasons.id }).from(seasons)
      .where(ne(seasons.id, season.id)).orderBy(desc(seasons.startsAt)).limit(1);
    if (prior) {
      const roster = await db.selectDistinct({ userId: accounts.userId }).from(accounts).where(eq(accounts.seasonId, prior.id));
      if (roster.length) {
        await db.insert(accounts).values(roster.map((r) => ({ userId: r.userId, seasonId: season.id, cashKrw: seedStr })))
          .onConflictDoUpdate({ target: [accounts.userId, accounts.seasonId], set: { cashKrw: seedStr } });
      }
    }
    return season;
  }
  ```
  →
  ```ts
  // `cfg` 기본값 제거 — 필수 `market`이 뒤에 오므로(TS 규칙). 호출부(cron·bots)는 항상 cfg 전달.
  export async function resetSeason(db: Db, cfg: SeasonConfig, market: Market): Promise<SeasonRow> {
    const season = await ensureActiveSeason(db, cfg, market);
    const seedStr = seedMoneyOf(cfg, market).toFixed(2);
    // 직전 시즌은 같은 리그(market)만 — 교차 리그 로스터 오염 차단.
    const [prior] = await db.select({ id: seasons.id }).from(seasons)
      .where(and(ne(seasons.id, season.id), eq(seasons.market, market))).orderBy(desc(seasons.startsAt)).limit(1);
    if (prior) {
      const roster = await db.selectDistinct({ userId: accounts.userId }).from(accounts).where(eq(accounts.seasonId, prior.id));
      if (roster.length) {
        await db.insert(accounts).values(roster.map((r) => ({ userId: r.userId, seasonId: season.id, cash: seedStr })))
          .onConflictDoUpdate({ target: [accounts.userId, accounts.seasonId], set: { cash: seedStr } });
      }
    }
    return season;
  }
  ```
- [ ] `finalizeOne`·`finalizeDueSeasons` 컬럼 rename + `usdKrw`/`loadUsdKrw` 제거. `:233-323`에서: `seedMoney` select 유지, `②` 환불 `cashKrw`→`cash`·`reservedKrw`→`reserved`(`:248` returning·`:253` update), `③` `const usdKrw = await loadUsdKrw(tx);` 줄 삭제, `accounts` select `cashKrw`→`cash`(`:262`), snaps select `totalValueKrw`→`totalValue`(`:270`), `④` `holdingsCents(…, prices, usdKrw)` → `holdingsCents(…, prices)`(`:296`), `toCents(a.cash)`(`:296`), `mdd` `s.totalValueKrw`→`s.totalValue`(`:301`). `finalValue`(seasonResults)는 유지.
- [ ] `snapshotPortfolios` 컬럼 rename + usdKrw 제거. `:330-381`에서: `const usdKrw = await loadUsdKrw(db);` 삭제(`:339`), accounts select `cashKrw`→`cash`(`:344`), openBuys `reservedKrw`→`reserved`(`:352`·`:359-360`), `holdingsCents(…, prices, usdKrw)` → `holdingsCents(…, prices)`(`:368`), snapshot insert/update `totalValueKrw`→`totalValue`(`:372`·`:375`).
- [ ] PASS 확인:
  ```
  npm test -w shared -- seasons.test.ts
  # 기대 PASS: 두 리그 풀사이클 + US 금요일 경계 ⑦ + MDD/멱등/reset 전부 통과
  npm test -w shared
  # 기대 PASS: fillOrder + seasons + candles 전체 그린
  ```
- [ ] Gate: `npm run typecheck`. 기대: **shared 통과**. worker(bots/matching/cron/fx)·web은 B/C에서 갱신 전이라 실패 잔존 가능 — shared 단독은 `npx tsc -p shared/tsconfig.json --noEmit`로 확인.
- [ ] 커밋:
  ```
  git add shared/src/seasons.ts shared/src/seasons.test.ts
  git commit -m "feat(seasons): 시장 인지 경계·수명주기·US 금요일 경계·usdKrw 제거

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

> **Phase A 완료 게이트**: `npm test -w shared` 그린 + `npx tsc -p shared/tsconfig.json --noEmit` 통과. B/C/D 착수 전 위 **발행 계약** 시그니처가 최종본과 일치하는지 재확인.

---

## Phase B — worker (A 이후; C·D와 병렬, 파일 소유 서로소: `worker/src/**`)

### Task B1 — cron.ts: 리그별 리셋·확정·스냅샷 스케줄 + Neon 보존 시간창

**Files:**
- Modify: `worker/src/cron.ts:9-17` (import), `:59-67` (updatePrevClose), `:84-108` (스케줄 본문)
- Test: 스케줄 로직은 통합 테스트 없음 — `npm run typecheck` + `npm test -w worker`(기존 aggregator/matchRule 테스트 회귀 없음)로 게이트.

**Interfaces:**
- Consumes: `resetSeason(db, cfg, market)`·`ensureActiveSeason(db, cfg, market)`·`finalizeDueSeasons(db)`·`snapshotPortfolios(db)` (A4).

**Steps:**
- [ ] import에서 `updateFxRates` 제거(fx 크론 삭제) + `Market` 추가. 현재 `:8-17`:
  ```ts
  import {
    ensureActiveSeason, finalizeDueSeasons, resetSeason, snapshotPortfolios, type SeasonConfig,
  } from "@mockstock/shared";
  import { instruments, minuteCandles } from "@mockstock/shared/schema";
  import { getDb } from "./db";
  import { updateFxRates } from "./fx";
  ```
  →
  ```ts
  import {
    ensureActiveSeason, finalizeDueSeasons, resetSeason, snapshotPortfolios, type Market, type SeasonConfig,
  } from "@mockstock/shared";
  import { instruments, minuteCandles } from "@mockstock/shared/schema";
  import { getDb } from "./db";
  ```
- [ ] 부팅 스윕을 두 리그 ensure로. 현재 `:87-92`:
  ```ts
  void runNotified("부팅 스윕", async () => {
    const finalized = await finalizeDueSeasons(db);
    await ensureActiveSeason(db, cfg);
    return { finalized };
  });
  ```
  →
  ```ts
  void runNotified("부팅 스윕", async () => {
    const finalized = await finalizeDueSeasons(db);
    await ensureActiveSeason(db, cfg, "KR");
    await ensureActiveSeason(db, cfg, "US");
    return { finalized };
  });
  ```
- [ ] 리셋·확정·스냅샷 스케줄을 리그별 시간창으로 교체 + fx 크론 삭제. 현재 `:94-105`:
  ```ts
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
  // ⑥ 분봉 보존 — 매일 04:20 KST(…), N일 초과 prune.
  cron.schedule("20 4 * * *", () => void runNotified("분봉 prune", () => pruneMinuteCandles(db)), { timezone: TZ });
  ```
  →
  ```ts
  // ① KR 리셋 — 월 08:30 KST(KR 개장 전). US 리셋 — 월 22:00 KST(≈미 동부 월 09:00 여름 개장 전).
  cron.schedule("30 8 * * 1", () => void runNotified("KR 시즌 리셋", () => resetSeason(db, cfg, "KR")), { timezone: TZ });
  cron.schedule("0 22 * * 1", () => void runNotified("US 시즌 리셋", () => resetSeason(db, cfg, "US")), { timezone: TZ });
  // ② 확정 스윕 — 각 리그 마감창에서만(상시 5분 스윕 금지, Neon 보존 B13). endsAt<=now & active 를 스캔하는
  //    상태 기반 멱등 스윕이라 다운타임에도 다음 창에서 밀린 시즌을 잡는다. noOverlap 로 중복 발사 차단.
  //    KR: 금 15:35~16:05 매 5분(15:30 마감 직후). US: 토 05:05~06:05 매 5분(≈금 16:00 ET 마감 직후, DST 여유).
  cron.schedule("35-59/5 15 * * 5", () => void runNotified("KR 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  cron.schedule("0-5 16 * * 5", () => void runNotified("KR 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  cron.schedule("5-59/5 5 * * 6", () => void runNotified("US 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  cron.schedule("0-5 6 * * 6", () => void runNotified("US 확정 스윕", () => finalizeDueSeasons(db)), { timezone: TZ, noOverlap: true });
  // ③ 일별 스냅샷 — KR 15:40(당일 KR 종가), US 06:10 KST 토(≈미 동부 금 종가 반영, MDD용 §4.2).
  cron.schedule("40 15 * * 1-5", () => void runNotified("KR 스냅샷", () => snapshotPortfolios(db)), { timezone: TZ });
  cron.schedule("10 6 * * 2-6", () => void runNotified("US 스냅샷", () => snapshotPortfolios(db)), { timezone: TZ });
  // ④ prevClose 갱신 — 07:30.
  cron.schedule("30 7 * * 1-5", () => void runNotified("prevClose 갱신", () => updatePrevClose(db)), { timezone: TZ });
  // ⑤ 분봉 보존 — 매일 04:20 KST, N일 초과 prune.
  cron.schedule("20 4 * * *", () => void runNotified("분봉 prune", () => pruneMinuteCandles(db)), { timezone: TZ });
  ```
  > **노트:** `finalizeDueSeasons`/`snapshotPortfolios`는 `endsAt`/active 상태로 리그를 자연 분기하므로 스윕 자체는 두 리그 공용 — 스케줄 창만 리그별로 좁힌다(§워커 수명주기). `sweepMin`(`:85`) env는 창 내부 주기 표현에 안 쓰이면 제거 가능하나, 로그 문구(`:107`)에서 참조하면 유지. `sweepMin` 미사용 시 `:85` 줄과 `:107` 로그의 `sweepMin` 언급 삭제.
- [ ] 로그 문구(`:107`) 갱신 — 확정 스윕이 리그별 창임을 반영:
  ```ts
  console.log(`[cron] 등록 완료 (Asia/Seoul, 확정=리그별 마감창, 분봉 보존 ${MINUTE_CANDLE_RETENTION_DAYS}일)`);
  ```
- [ ] Gate:
  ```
  npm run typecheck        # 기대: worker cron 부분 통과(단 fx.ts 삭제 전이면 fx import 잔존 파일 실패 → B2에서 정리)
  npm test -w worker       # 기대: 기존 워커 테스트 회귀 없음
  ```
- [ ] 커밋:
  ```
  git add worker/src/cron.ts
  git commit -m "feat(worker): 리그별 리셋·확정·스냅샷 스케줄 + Neon 마감창 보존, fx 크론 제거

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task B2 — matching.ts + fx.ts 삭제: fx 전역·fetch·FX_PAIR 제거, US 매도 USD 네이티브

**Files:**
- Modify: `worker/src/matching.ts:6-10` (import), `:18-44` (OpenOrder/SyncOrderInput), `:51` (usdKrw 전역), `:75`·`:120` (fxRate 파싱), `:91-127` (resync fx fetch), `:130-162` (evaluate fxRate 산출)
- Delete: `worker/src/fx.ts` (전량 삭제 — fxRates 테이블 없음)
- Test: `npm run typecheck` + `npm test -w worker`.

**Interfaces:**
- Consumes: `fillOrder`(A3, `FillInput` no fxRate, `reserved?`). 스키마 `orders.reserved`(A1).

**Steps:**
- [ ] import 정리. 현재 `worker/src/matching.ts:6-10`:
  ```ts
  import { and, eq } from "drizzle-orm";
  import { FX_PAIR_USDKRW, type Market, type Side } from "@mockstock/shared";
  import { isMarketOpen } from "@mockstock/shared/calendar";
  import { fillOrder } from "@mockstock/shared/fillOrder";
  import { fxRates, orders, seasons } from "@mockstock/shared/schema";
  ```
  →
  ```ts
  import { and, eq } from "drizzle-orm";
  import { type Market, type Side } from "@mockstock/shared";
  import { isMarketOpen } from "@mockstock/shared/calendar";
  import { fillOrder } from "@mockstock/shared/fillOrder";
  import { orders, seasons } from "@mockstock/shared/schema";
  ```
- [ ] `OpenOrder`·`SyncOrderInput`에서 `fxRate` 필드 제거 + `reservedKrw`→`reserved`. 현재 `:18-44`의 `OpenOrder`(`:27-29`):
  ```ts
    /** 매수 지정가의 접수 시점 고정 환율(US). 매도·KR은 null(…). */
    fxRate: number | null;
    reservedKrw: string | null;
  }
  ```
  →
  ```ts
    reserved: string | null;
  }
  ```
  `SyncOrderInput`(`:42-43`):
  ```ts
    fxRate?: number | string | null;
    reservedKrw?: string | null;
  }
  ```
  →
  ```ts
    reserved?: string | null;
  }
  ```
- [ ] `usdKrw` 전역 삭제(`:51`) + 파일 상단 주석(`:5`)의 "체결 환율" 언급 제거.
- [ ] `syncOrder`의 cache.set에서 `fxRate`·`reservedKrw` 갱신. 현재 `:66-77`:
  ```ts
  cache.set(order.id, {
    …
    limitPrice: Number(order.limitPrice),
    fxRate: order.fxRate != null ? Number(order.fxRate) : null,
    reservedKrw: order.reservedKrw ?? null,
  });
  ```
  →
  ```ts
  cache.set(order.id, {
    …
    limitPrice: Number(order.limitPrice),
    reserved: order.reserved ?? null,
  });
  ```
- [ ] `resync`에서 fx fetch·select 제거 + `orders.fxRate` select 제거. 현재 `:91-127`: select 목록에서 `fxRate: orders.fxRate` 줄(`:100`) 삭제, `reservedKrw: orders.reservedKrw`(`:101`) → `reserved: orders.reserved`, cache.set(`:111-122`)에서 `fxRate` 줄 삭제·`reservedKrw: r.reservedKrw` → `reserved: r.reserved`, 그리고 `:125-126`:
  ```ts
    const [fx] = await db.select({ rate: fxRates.rate }).from(fxRates).where(eq(fxRates.pair, FX_PAIR_USDKRW));
    usdKrw = fx ? Number(fx.rate) : 0;
  ```
  두 줄 삭제.
- [ ] `evaluate`의 fxRate 산출·게이트 제거 + `fillOrder` 호출 정리. 현재 `:134-153`:
  ```ts
    const decision = matchDecision(o.side, o.limitPrice, o.market, book.get(o.market, o.symbol), now);
    if (!decision.fill) continue;

    // 체결 환율: KR=1, 매수=접수 고정, 매도=체결 시점 usdKrw. US 환율 없으면 체결 보류(§6.6).
    const fxRate = o.market === "KR" ? 1 : o.side === "buy" ? (o.fxRate ?? 0) : usdKrw;
    if (o.market === "US" && fxRate <= 0) continue;

    const result = await fillOrder(db, {
      orderId: o.id, userId: o.userId, seasonId: o.seasonId,
      market: o.market, symbol: o.symbol, side: o.side,
      orderType: "limit", qty: o.qty,
      filledPrice: decision.price,
      fxRate,
      reservedKrw: o.reservedKrw ?? undefined,
    });
  ```
  →
  ```ts
    const decision = matchDecision(o.side, o.limitPrice, o.market, book.get(o.market, o.symbol), now);
    if (!decision.fill) continue;

    const result = await fillOrder(db, {
      orderId: o.id, userId: o.userId, seasonId: o.seasonId,
      market: o.market, symbol: o.symbol, side: o.side,
      orderType: "limit", qty: o.qty,
      filledPrice: decision.price,
      reserved: o.reserved ?? undefined,
    });
  ```
- [ ] `worker/src/fx.ts` 파일 삭제:
  ```
  git rm worker/src/fx.ts
  ```
- [ ] Gate:
  ```
  npm run typecheck        # 기대: matching·cron 통과. bots.ts는 B3 전이면 fxRates import 실패 잔존.
  npm test -w worker       # 기대: 회귀 없음
  ```
- [ ] 커밋:
  ```
  git add worker/src/matching.ts
  git commit -m "feat(worker): 매칭 fx 전역·fetch·FX_PAIR 제거, US 매도 USD 네이티브 체결, fx.ts 삭제

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task B3 — bots.ts: fxRate·usdKrw·FX_PAIR 제거, 리그별 시즌·예산 (스펙 갭 보강)

> **스펙 갭:** 스펙은 `matching`만 명시하나 `worker/src/bots.ts`가 `fxRates`·`usdKrw`·`FX_PAIR_USDKRW`·`fxRate`·`ensureActiveSeason(db,cfg)`·`season.seedMoney` 예산을 광범위하게 소비한다. A 계약 변경으로 컴파일 깨짐 — 리그별 네이티브로 재배선 필수(Phase B, 파일 서로소).

**Files:**
- Modify: `worker/src/bots.ts:8-26` (import), `:119-129` (fxOf/buyQty), `:136-181` (decide usdKrw 항), `:184-231` (place·usdKrwOf), `:270-308` (seedAccounts·loop 리그별)
- Test: `worker/src/bots.test.ts` 존재 시 `buyQty`/`decide`/`botCountOf` 재파라미터화. `npm test -w worker`로 게이트.

**Interfaces:**
- Consumes: `ensureActiveSeason(db, cfg, market)`(A4), `SEED_MONEY`(A2 — 필요 시), `fillOrder`(A3). 스키마 `accounts.cash`(A1).

**Steps:**
- [ ] import에서 `fxRates`·`FX_PAIR_USDKRW` 제거. 현재 `:11-25`의 `FX_PAIR_USDKRW`(`:15`)·`fxRates`(`:25`) 삭제:
  ```ts
  import { UNIVERSE, keyOf, ensureActiveSeason, FX_PAIR_USDKRW, type Market, … } from "@mockstock/shared";
  …
  import { accounts, fxRates, orders, positions, users } from "@mockstock/shared/schema";
  ```
  →
  ```ts
  import { UNIVERSE, keyOf, ensureActiveSeason, type Market, … } from "@mockstock/shared";
  …
  import { accounts, orders, positions, users } from "@mockstock/shared/schema";
  ```
- [ ] `fxOf`/`buyQty`에서 usdKrw 제거 — 예산·가격이 이제 리그별 네이티브. 현재 `:119-129`:
  ```ts
  function fxOf(market: Market, usdKrw: number): number {
    return market === "US" ? usdKrw : 1;
  }
  export function buyQty(p: Priced, usdKrw: number, budgetKrw: number): number {
    const fx = fxOf(p.entry.market, usdKrw);
    if (fx <= 0) return 0;
    const priceKrw = p.tick.price * fx;
    return priceKrw > 0 ? Math.floor(budgetKrw / priceKrw) : 0;
  }
  ```
  →
  ```ts
  /** 주문 예산(네이티브 통화)으로 살 수 있는 정수 주수. 리그별 지갑이라 환산 없음. */
  export function buyQty(p: Priced, budget: number): number {
    const price = p.tick.price;
    return price > 0 ? Math.floor(budget / price) : 0;
  }
  ```
  (`fxOf` 삭제.)
- [ ] `decide` 시그니처에서 `usdKrw` 제거 + `buyQty` 호출 갱신. 현재 `:136-181`: `decide(bot, market, holdings, usdKrw, budgetKrw)` → `decide(bot, market, holdings, budget)`, 내부 `buyQty(pick, usdKrw, budgetKrw)` → `buyQty(pick, budget)`(3곳: `:149`·`:169`·`:179`). `budgetKrw`→`budget` 리네이밍.
  > **주의(리그 혼합):** `market: Priced[]`는 US·KR 종목이 섞여 있고 리그별 예산이 다르다. `decide`가 종목 리그를 알므로, `budget`을 단일 값이 아니라 `budgetOf: (m: Market) => number`로 넘기거나, 호출부 `loop`에서 리그별로 두 번 `decide` 호출한다. **간단안:** `loop`에서 `tradeable(book)`를 `market`으로 분할(`krMarket`/`usMarket`) → 리그별 시즌·예산으로 각각 `decide`. 아래 `loop` 단계 참조.
- [ ] `place`에서 fxRate 제거. 현재 `:184-212`:
  ```ts
  async function place(db: Db, bot: BotDef, seasonId: string, it: Intent, usdKrw: number): Promise<void> {
    const fx = fxOf(it.entry.market, usdKrw);
    const orderId = randomUUID();
    await db.insert(orders).values({ …, fxRate: String(fx), idempotencyKey: orderId });
    const res = await fillOrder(db, { …, filledPrice: it.tick.price, fxRate: fx });
    …
  }
  ```
  →
  ```ts
  async function place(db: Db, bot: BotDef, seasonId: string, it: Intent): Promise<void> {
    const orderId = randomUUID();
    await db.insert(orders).values({
      id: orderId, userId: bot.id, seasonId,
      market: it.entry.market, symbol: it.entry.symbol, side: it.side,
      type: "market", qty: String(it.qty), idempotencyKey: orderId,
    });
    const res = await fillOrder(db, {
      orderId, userId: bot.id, seasonId,
      market: it.entry.market, symbol: it.entry.symbol, side: it.side,
      orderType: "market", qty: it.qty, filledPrice: it.tick.price,
    });
    if (!res.ok) console.log(`[bots] ${bot.name} ${it.side} ${it.entry.symbol} 스킵: ${res.reason}`);
  }
  ```
- [ ] `usdKrwOf` 삭제(`:224-231`) + `fxCache`(`:255`) 제거.
- [ ] `seedAccounts`·`loop`를 리그별로. 현재 `:270-308`: `seedAccounts(season)`가 `cashKrw: season.seedMoney` → `cash: season.seedMoney`. `loop`(`:277-308`)를 두 리그 시즌으로:
  ```ts
  async function loop(): Promise<void> {
    if (running) return;
    const priced = tradeable(book);
    if (priced.length === 0) return;
    running = true;
    try {
      if (!seededUsers) { await seedUsersEach(); seededUsers = true; }
      for (const market of ["KR", "US"] as Market[]) {
        const legPriced = priced.filter((p) => p.entry.market === market);
        if (legPriced.length === 0) continue;
        const season = await ensureActiveSeason(db!, cfg, market);
        if (seededSeason[market] !== season.id) { await seedAccounts(season); seededSeason[market] = season.id; }
        const budget = Number(season.seedMoney) * orderPct;
        const holdings = await loadHoldings(db!, season.id, botIds);
        for (const bot of bots) {
          for (const it of decide(bot, legPriced, holdings, budget)) {
            await place(db!, bot, season.id, it);
          }
        }
      }
    } catch (e) {
      console.error("[bots] 루프 오류", e);
    } finally {
      running = false;
    }
  }
  ```
  `seededSeason`(`:257`)을 `let seededSeason: string | null = null;` → `const seededSeason: Record<Market, string | null> = { KR: null, US: null };`.
- [ ] `bots.test.ts` 존재 시 `buyQty`/`decide` 호출을 새 시그니처로(usdKrw 인자 제거, 네이티브 예산). 파일 없으면 스킵.
- [ ] Gate:
  ```
  npm run typecheck        # 기대: worker 전체 통과(bots·matching·cron·fx 삭제 반영)
  npm test -w worker       # 기대: 회귀 없음(bots 테스트 갱신분 포함)
  ```
- [ ] 커밋:
  ```
  git add worker/src/bots.ts worker/src/bots.test.ts
  git commit -m "feat(worker): 봇 리그별 시즌·네이티브 예산, fxRate·usdKrw·FX_PAIR 제거

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

> **Phase B 완료 게이트**: `npm run typecheck` 통과 + `npm test -w worker` 그린.

---

## Phase C — web API·라우트 (A 이후; B·D와 병렬, 파일 소유 서로소: `web/src/app/api/**`, `web/src/lib/{leaderboard,portfolio,orders}.ts`)

> **공통 노트:** web typecheck는 루트 `npm run typecheck`가 커버하지 않는다 — 반드시 `npx tsc -p web/tsconfig.json --noEmit`. web 테스트는 `npm test -w web`.
> **리그 세그먼트 계약(D와 공유):** 스코프 API(`portfolio`·`leaderboard`)는 리그를 쿼리스트링 `?league=us|kr`로 받는다(D의 `/[league]/...` 페이지가 fetch 시 부착). `orders`는 리그를 **주문 body의 `market`에서 도출**(별도 파라미터 없음).

### Task C1 — orders route: fx 로드 삭제 · fillOrder fxRate 인자 제거 · 주문 market으로 시즌 도출

**Files:**
- Modify: `web/src/app/api/orders/route.ts:6-9` (import), `:72-84` (시즌·시드 upsert), `:94-106` (fx 블록 삭제), `:144-156` (pushOrderSync), `:184-224` (insert·fillOrder)
- Modify: `web/src/lib/orders/limit.ts:11` (import), `:28-40` (PlaceLimitInput fxRate 제거), `:99-154` (reserved·fxRate 제거)
- Test: `web/src/lib/orders/limit.test.ts` (fxRate 인자 제거·reserved 컬럼·SEED 리그별)

**Interfaces:**
- Consumes: `SEED_MONEY`(A2), `ensureActiveSeason` 아님(route는 직접 select) — 리그 시즌은 `WHERE status='active' AND market=$market`. `fillOrder`(A3, no fxRate). `placeLimitOrder`(fxRate 제거).
- Produces: 주문 market 기반 시즌 도출 규약(C2/C3와 다름 — orders는 body.market).

**Steps:**
- [ ] **limit.ts 먼저** — `PlaceLimitInput.fxRate` 제거 + reserved 계산에서 fx 제거. 현재 `web/src/lib/orders/limit.ts:28-40`:
  ```ts
  export interface PlaceLimitInput {
    orderId: string; userId: string; seasonId: string;
    market: Market; symbol: string; side: Side;
    qty: number; limitPrice: number;
    /** US 매수 지정가의 접수 시점 고정 환율(§6.6). KR=1. 매도는 무시(null 저장). */
    fxRate: number;
    idempotencyKey: string;
  }
  ```
  →
  ```ts
  export interface PlaceLimitInput {
    orderId: string; userId: string; seasonId: string;
    market: Market; symbol: string; side: Side;
    qty: number; limitPrice: number;
    idempotencyKey: string;
  }
  ```
  본문(`:50-155`): `const { …, fxRate } = i;`(`:51`)에서 `fxRate` 제거. 매도 insert(`:81-95`)의 `fxRate: null` 줄 삭제, `reservedKrw: null` → `reserved: null`. 매수 예약(`:99-101`) `Math.round(limitPrice * fxRate * qty * 100)` → `Math.round(limitPrice * qty * 100)`. `season.seedMoney`·`positions.costBasisKrw`(`:104·:106`) select는 `costBasis`로. 조건부 차감(`:129·:134`) `accounts.cashKrw` → `accounts.cash`. 매수 insert(`:140-154`) `fxRate: String(fxRate)` 줄 삭제, `reservedKrw: reserved` → `reserved: reserved`. `cancelOrder`(`:165-183`)의 returning `reservedKrw: orders.reservedKrw` → `reserved: orders.reserved`, 환불 `cashKrw` → `cash`, 참조 `reservedKrw` → `reserved`. import(`:10-11`)는 `orders`·`accounts`·`positions`·`seasons` 유지, `POSITION_LIMIT_PCT`·`Market`·`Side` 유지.
- [ ] limit.test.ts 갱신: `place(db,{…, fxRate})` 시그니처에서 `fxRate` 제거, `orders` insert·검증에서 `fxRate` 열 제거, `cashKrw`→`cash`·`reservedKrw`→`reserved` 참조, seed 시즌에 `market` 추가. US 예약 테스트 ②는 이제 **네이티브 USD**(`230*2=460` reserved, fx 없음)로 재작성.
  ```
  npm test -w web -- limit.test.ts
  # 기대: reserved=460(USD 네이티브), fxRate 컬럼 없음, 전 케이스 PASS
  ```
- [ ] **orders route** — import·시즌·fillOrder 정리. 현재 `:6-9`:
  ```ts
  import { SEED_MONEY_KRW } from "@mockstock/shared";
  import { isMarketOpen } from "@mockstock/shared/calendar";
  import { fillOrder } from "@mockstock/shared/fillOrder";
  import { accounts, fxRates, orders, seasons } from "@mockstock/shared/schema";
  ```
  →
  ```ts
  import { SEED_MONEY } from "@mockstock/shared";
  import { isMarketOpen } from "@mockstock/shared/calendar";
  import { fillOrder } from "@mockstock/shared/fillOrder";
  import { accounts, orders, seasons } from "@mockstock/shared/schema";
  ```
- [ ] 시즌 도출을 주문 market으로 + 시드 upsert를 리그별. 현재 `:71-84`:
  ```ts
  // 3. 서버가 active 시즌 결정. …
  const [season] = await db.select({ id: seasons.id }).from(seasons)
    .where(eq(seasons.status, "active")).limit(1);
  if (!season) return json(409, { message: "진행 중인 시즌이 없습니다." });
  const seasonId = season.id;
  // 4. 시즌 계좌 lazy upsert …
  await db.insert(accounts).values({ userId, seasonId, cashKrw: SEED_MONEY_KRW.toFixed(2) }).onConflictDoNothing();
  ```
  →
  ```ts
  // 3. 서버가 주문 리그(market)의 active 시즌 결정. 없으면 접수 불가(시즌 생성은 리셋 크론 몫).
  const [season] = await db.select({ id: seasons.id }).from(seasons)
    .where(and(eq(seasons.status, "active"), eq(seasons.market, market))).limit(1);
  if (!season) return json(409, { message: "진행 중인 시즌이 없습니다." });
  const seasonId = season.id;
  // 4. 시즌 계좌 lazy upsert — 첫 진입 시 리그 네이티브 시드 지급(§4.4).
  await db.insert(accounts).values({ userId, seasonId, cash: SEED_MONEY[market].toFixed(2) }).onConflictDoNothing();
  ```
  (`and`는 이미 `:5`에서 import됨.)
- [ ] 멱등 조회를 season 스코프로. 현재 `:87-92`·`:130-135`·`:203-208`의 멱등 재조회 `WHERE userId AND idempotencyKey`에 `eq(orders.seasonId, seasonId)` 추가(유니크가 이제 `(user,season,key)`라 정합). 예: `:87-91`:
  ```ts
  const [existing] = await db.select({ id: orders.id, status: orders.status }).from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey))).limit(1);
  ```
  →
  ```ts
  const [existing] = await db.select({ id: orders.id, status: orders.status }).from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.seasonId, seasonId), eq(orders.idempotencyKey, idempotencyKey))).limit(1);
  ```
  (`:130-135`·`:203-208` 두 유니크 위반 재조회도 동일하게 `seasonId` 추가.)
- [ ] fx 블록 삭제. 현재 `:94-106`:
  ```ts
  // 6. 환율: US는 fx_rates 로우 필수 …
  let fxRate = 1;
  if (market === "US") { … fxRate = Number(fx.rate); }
  ```
  블록 전체 삭제.
- [ ] `placeLimitOrder` 호출에서 `fxRate` 제거. 현재 `:115-126`: `placeLimitOrder(db, { …, limitPrice, side, qty, fxRate, idempotencyKey })`에서 `fxRate,` 인자 삭제.
- [ ] `pushOrderSync` 페이로드에서 fxRate 제거. 현재 `:144-156`:
  ```ts
  void pushOrderSync("upsert", {
    id: orderId, userId, seasonId, market, symbol, side,
    qty: String(qty), limitPrice: String(limitPrice),
    fxRate: side === "buy" ? String(fxRate) : null,
    reservedKrw: null,
  });
  ```
  →
  ```ts
  void pushOrderSync("upsert", {
    id: orderId, userId, seasonId, market, symbol, side,
    qty: String(qty), limitPrice: String(limitPrice),
    reserved: null, // 워커가 DB에서 재조회(CAS RETURNING) — 캐시엔 불필요.
  });
  ```
- [ ] 시장가 insert·fillOrder에서 fxRate 제거. 현재 `:184-224`: insert(`:186-199`)의 `fxRate: String(fxRate)` 줄 삭제·`reservedKrw: null` → `reserved: null`. fillOrder 호출(`:213-224`)에서 `fxRate,` 인자 삭제.
- [ ] workerClient.ts `SyncOrderPayload`(`web/src/lib/market/workerClient.ts:48-60`)에서 `fxRate?`·`reservedKrw?` → `reserved?`만 남김:
  ```ts
    qty?: string; limitPrice?: string | null;
    reserved?: string | null;
  }
  ```
- [ ] Gate:
  ```
  npx tsc -p web/tsconfig.json --noEmit   # 기대: orders·limit·workerClient 통과(portfolio/leaderboard route는 C2/C3 전이면 실패 잔존)
  npm test -w web -- limit.test.ts        # 기대: PASS
  ```
- [ ] 커밋:
  ```
  git add web/src/app/api/orders/route.ts web/src/lib/orders/limit.ts web/src/lib/orders/limit.test.ts web/src/lib/market/workerClient.ts
  git commit -m "feat(web-api): 주문 리그 시즌 도출·시드 리그별·fx 로드 제거·멱등 season 스코프

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task C2 — portfolio route: league 세그먼트로 리그 시즌 조회 · fx 제거

**Files:**
- Modify: `web/src/app/api/portfolio/route.ts:5-7` (import), `:29-40` (시즌), `:43-95` (조회·fx 제거), `:97-109` (응답)
- Modify: `web/src/lib/portfolio.ts:14-32` (Row 타입), `:34-62` (응답 타입 — fxRate·costBasisKrw 정리), `:70-110` (buildPortfolio)
- Test: `web/src/lib/portfolio.test.ts` (fxRate·costBasisKrw·cashKrw 명칭 갱신)

**Interfaces:**
- Consumes: 리그 = 쿼리 `?league=us|kr` → `market`. 스키마 `accounts.cash`·`positions.costBasis`·`orders.reserved`(A1). `fillOrder` 무관.
- Produces: `PortfolioResponse`(no `fxRate`, `cash`/`reserved`/`realizedPnl` 네이티브·`costBasis`).

**Steps:**
- [ ] `portfolio.ts` 타입 네이티브화. 현재 `web/src/lib/portfolio.ts`: `PositionRow.costBasisKrw`(`:17`) → `costBasis`, `OpenOrderRow.reservedKrw`·`fxRate`(`:29-30`) → `reserved`(fxRate 삭제), `PortfolioPosition.costBasisKrw`(`:39`) → `costBasis`, `PortfolioOrder.reservedKrw`·`fxRate`(`:49-50`) → `reserved`(fxRate 삭제), `PortfolioResponse`(`:54-62`)에서 `fxRate: number;`(`:56`) 삭제·`cashKrw`→`cash`·`reservedKrw`→`reserved`·`realizedPnlKrw`→`realizedPnl`. `buildPortfolio` 시그니처(`:70-78`)에서 `fxRate` 인자 삭제, 본문(`:79-110`)의 필드 매핑을 새 이름으로. 응답 `season`에 `market` 추가(`{ id, market, startsAt, endsAt, seedMoney }`) — `SeasonMetaRow`에 `market: Market` 추가.
- [ ] `portfolio.test.ts` 갱신: `costBasisKrw`→`costBasis`, `reservedKrw`→`reserved`, `fxRate` 제거, `cashKrw`→`cash`, `buildPortfolio(season, cash, reserved, realized, positions, orders)`(fxRate 인자 없음), 시즌 픽스처에 `market:"KR"` 추가.
  ```
  npm test -w web -- portfolio.test.ts
  # 기대: fxRate 없는 셰이프·네이티브 명칭 PASS
  ```
- [ ] **route** — import·시즌·fx 제거. 현재 `:5-7`:
  ```ts
  import { and, desc, eq, gt, sum } from "drizzle-orm";
  import { FX_PAIR_USDKRW } from "@mockstock/shared";
  import { accounts, fxRates, orders, positions, seasons } from "@mockstock/shared/schema";
  ```
  →
  ```ts
  import { and, desc, eq, gt, sum } from "drizzle-orm";
  import { accounts, orders, positions, seasons } from "@mockstock/shared/schema";
  import type { Market } from "@mockstock/shared";
  ```
- [ ] league 쿼리 → market → 리그 시즌 조회. 현재 `:19-40`: 세션 게이트 뒤에 리그 파싱 추가, 시즌 WHERE에 market:
  ```ts
  const url = new URL(req.url);
  const league = url.searchParams.get("league");
  const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
  if (!market) return json(400, { message: "리그를 지정해 주세요." });
  const db = getDb();
  const [season] = await db.select({ id: seasons.id, market: seasons.market, startsAt: seasons.startsAt, endsAt: seasons.endsAt, seedMoney: seasons.seedMoney })
    .from(seasons).where(and(eq(seasons.status, "active"), eq(seasons.market, market)))
    .orderBy(desc(seasons.startsAt)).limit(1);
  if (!season) return json(404, { message: "진행 중인 시즌이 없습니다." });
  ```
- [ ] fx select 삭제 + 컬럼 rename. 현재 `:43-95`: `Promise.all` 배열에서 fx select(`:45`) 제거, accounts `cashKrw: accounts.cashKrw`(`:47`) → `cash: accounts.cash`, reserved `sum(orders.reservedKrw)`(`:53`) → `sum(orders.reserved)`, positions `costBasisKrw: positions.costBasisKrw`(`:74`) → `costBasis: positions.costBasis`, openOrders에서 `reservedKrw: orders.reservedKrw`·`fxRate: orders.fxRate`(`:88-89`) → `reserved: orders.reserved`(fxRate 삭제).
- [ ] 응답 조립. 현재 `:97-109`:
  ```ts
  const fxRate = fxRows[0] ? Number(fxRows[0].rate) : 0;
  return Response.json(buildPortfolio(season, fxRate, accountRows[0]?.cashKrw ?? null, reservedRows[0]?.v ?? null, realizedRows[0]?.v ?? null, positionRows, openOrderRows));
  ```
  →
  ```ts
  return Response.json(buildPortfolio(season, accountRows[0]?.cash ?? null, reservedRows[0]?.v ?? null, realizedRows[0]?.v ?? null, positionRows, openOrderRows));
  ```
- [ ] Gate:
  ```
  npx tsc -p web/tsconfig.json --noEmit   # 기대: portfolio route·lib 통과
  npm test -w web -- portfolio.test.ts    # 기대: PASS
  ```
- [ ] 커밋:
  ```
  git add web/src/app/api/portfolio/route.ts web/src/lib/portfolio.ts web/src/lib/portfolio.test.ts
  git commit -m "feat(web-api): 포트폴리오 리그 세그먼트 시즌·네이티브 통화·fx 제거

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task C3 — leaderboard route: league별 시즌 · 리그별 TTL 캐시 키

**Files:**
- Modify: `web/src/app/api/leaderboard/route.ts:4-6` (import), `:19` (캐시 구조), `:25-82` (load), `:84-97` (GET)
- Modify: `web/src/lib/leaderboard.ts:4` (import), `:26-72` (Row/응답 타입 — fxRate·cashKrw·costBasisKrw), `:79-167` (buildLeaderboard·rankParticipants)
- Test: `web/src/lib/leaderboard.test.ts` (두 리그 + fxRate 제거)

**Interfaces:**
- Consumes: 리그 = 쿼리 `?league=us|kr` → `market`. 스키마 `accounts.cash`·`positions.costBasis`·`orders.reserved`(A1).
- Produces: `LeaderboardResponse`(no `fxRate`, `cash`/`reserved`/`costBasis` 네이티브, `season.market`).

**Steps:**
- [ ] **leaderboard.ts 먼저** — fxRate·통화 명칭 정리. 현재 `web/src/lib/leaderboard.ts`: `SeasonMetaRow`에 `market: Market` 추가, `AccountRow.cashKrw`(`:38`) → `cash`, `ReservedRow.reservedKrw`(`:42`) → `reserved`, `PositionRow.costBasisKrw`(`:49`) → `costBasis`, `PositionOut.costBasisKrw`(`:56`) → `costBasis`, `Participant.cashKrw`·`reservedKrw`(`:64-65`) → `cash`·`reserved`, `LeaderboardResponse`(`:68-72`)에서 `fxRate: number;` 삭제·`season`에 `market` 추가. `buildLeaderboard`(`:79-117`) 시그니처에서 `fxRate` 인자 삭제·본문 필드 rename. `rankParticipants`(`:138-167`)에서 `fxRate` 인자 삭제 + holdings 계산의 `* (pos.market === "US" ? fxRate : 1)` → 환산 제거(리그별 단일 통화라 `Number(pos.qty) * price`), `Number(p.cashKrw)`·`Number(p.reservedKrw)` → `cash`·`reserved`. 반환 `totalValueKrw`·`returnKrw` 명칭은 표시용이라 `totalValue`·`returnAbs`로 정리(view도 D에서 갱신하면 좋으나 C 범위는 lib+route; view 문자열은 D3에서 처리 — 여기선 필드명 `totalValue`/`returnAbs`로 확정하고 D가 소비).
  > **경계 주의:** `leaderboard-view.tsx`(D 소유)가 `data.fxRate`·`rankParticipants(…, data.fxRate, …)`·`row.returnKrw`를 참조한다. C에서 lib 시그니처를 바꾸면 view가 깨지므로, **C와 D가 이 인터페이스를 공유**한다 — C는 `RankedParticipant.totalValue`/`returnAbs`, `rankParticipants(participants, seedMoney, priceOf)` 시그니처를 확정하고, D3에서 view를 그 시그니처로 맞춘다(아래 D3 Consumes에 명시).
- [ ] `leaderboard.test.ts` 갱신: `season` 픽스처에 `market:"KR"`, `buildLeaderboard(season, accounts, reserved, positions)`(fxRate 없음), `AccountRow.cash`·`ReservedRow.reserved`·`PositionRow.costBasis`, `rankParticipants(parts, seed, priceOf)`(fxRate 없음), US 보유 테스트는 네이티브 USD 시즌으로(별도 US 픽스처) 재작성 — US 평가는 환산 없이 `qty*price`. `r.fxRate` 검증 삭제.
  ```
  npm test -w web -- leaderboard.test.ts
  # 기대: 두 리그 픽스처·환산 없는 평가 PASS
  ```
- [ ] **route** — import·캐시·load. 현재 `:4-6`:
  ```ts
  import { and, desc, eq, gt, sum } from "drizzle-orm";
  import { FX_PAIR_USDKRW } from "@mockstock/shared";
  import { accounts, fxRates, orders, positions, seasons, users } from "@mockstock/shared/schema";
  ```
  →
  ```ts
  import { and, desc, eq, gt, sum } from "drizzle-orm";
  import type { Market } from "@mockstock/shared";
  import { accounts, orders, positions, seasons, users } from "@mockstock/shared/schema";
  ```
- [ ] 캐시를 리그별 키로. 현재 `:19`:
  ```ts
  let cache: { at: number; data: LeaderboardResponse | null } | undefined;
  ```
  →
  ```ts
  // 리그별 인메모리 TTL 캐시 — us·kr 각각(§7.7 Neon 각성 억제).
  const cache: Record<Market, { at: number; data: LeaderboardResponse | null } | undefined> = { US: undefined, KR: undefined };
  ```
- [ ] `load(market)` — 리그 시즌 + fx select 삭제 + 컬럼 rename. 현재 `:25-82`: 시그니처 `load(market: Market)`, 시즌 WHERE에 `eq(seasons.market, market)`·select에 `market: seasons.market`, fx select(`:43-48`) 블록 삭제, accounts `cashKrw: accounts.cashKrw`(`:57`) → `cash: accounts.cash`, reserved `sum(orders.reservedKrw)`(`:65`) → `sum(orders.reserved)`, positions `costBasisKrw`(`:76`) → `costBasis`, 반환 `buildLeaderboard(season, accountRows, reservedRows, positionRows)`(fxRate 제거).
- [ ] `GET`에서 league 파싱 + 리그별 캐시. 현재 `:84-97`:
  ```ts
  export async function GET(): Promise<Response> {
    if (!process.env.DATABASE_URL) { … return seasonNotReady(); }
    const now = Date.now();
    if (!cache || !isCacheFresh(now, cache.at)) { cache = { at: now, data: await load() }; }
    if (!cache.data) return seasonNotReady();
    return Response.json(cache.data);
  }
  ```
  →
  ```ts
  export async function GET(req: Request): Promise<Response> {
    if (!process.env.DATABASE_URL) { console.warn("[leaderboard] DATABASE_URL 미설정 — 시즌 준비 중 반환"); return seasonNotReady(); }
    const league = new URL(req.url).searchParams.get("league");
    const market: Market | null = league === "us" ? "US" : league === "kr" ? "KR" : null;
    if (!market) return Response.json({ message: "리그를 지정해 주세요." }, { status: 400 });
    const now = Date.now();
    const c = cache[market];
    if (!c || !isCacheFresh(now, c.at)) { cache[market] = { at: now, data: await load(market) }; }
    const fresh = cache[market]!;
    if (!fresh.data) return seasonNotReady();
    return Response.json(fresh.data);
  }
  ```
- [ ] Gate:
  ```
  npx tsc -p web/tsconfig.json --noEmit    # 기대: leaderboard route·lib 통과(leaderboard-view는 D3 전이면 실패 잔존)
  npm test -w web -- leaderboard.test.ts   # 기대: PASS
  ```
- [ ] 커밋:
  ```
  git add web/src/app/api/leaderboard/route.ts web/src/lib/leaderboard.ts web/src/lib/leaderboard.test.ts
  git commit -m "feat(web-api): 리더보드 리그별 시즌·TTL 캐시 키·네이티브 평가·fx 제거

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

> **Phase C 완료 게이트**: `npm test -w web`(limit·portfolio·leaderboard 테스트) 그린. web 전체 typecheck는 D 완료 후 최종 확인.

---

## Phase D — web UI · `/[league]` 라우트 (A 이후; B·C와 병렬, 파일 소유 서로소: `web/src/app/[league]/**`, `web/src/components/{layout,discover}/**`, `web/src/app/page.tsx`, `web/src/app/leaderboard/leaderboard-view.tsx`)

> **Next.js 16 필독(코드 작성 전):** `web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`(동적 세그먼트·`params` Promise), `.../02-route-segment-config/dynamicParams.md`, `web/node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`, `.../cookies.md`. `params`는 `Promise`로 await(스톡 페이지 `page.tsx` 패턴 참조).
> **리그 검증 규약(전 D 페이지 공유):** `league ∈ {us, kr}`. 그 외 값은 `notFound()`(스톡 페이지 `market !== "US" && "KR"` 패턴과 동일). fetch 시 `?league=<league>` 부착(C API 계약).

### Task D1 — `/[league]` 세그먼트로 portfolio·leaderboard·discover 이설

**Files:**
- Create: `web/src/app/[league]/layout.tsx`(league 검증·notFound), `web/src/app/[league]/portfolio/page.tsx`, `web/src/app/[league]/leaderboard/page.tsx`, `web/src/app/[league]/discover/page.tsx`
- Move: `web/src/app/portfolio/page.tsx` 로직 → `[league]/portfolio`, `web/src/app/leaderboard/{page,leaderboard-view}.tsx` → `[league]/leaderboard`, `web/src/components/discover/discover.tsx` 소비 → `[league]/discover`
- Delete: 이설 후 구 `web/src/app/portfolio/`·`web/src/app/leaderboard/page.tsx`(view는 D3에서 재사용 이동)
- Test: 렌더는 D 완료 후 `/run` 스모크(수동). 게이트 `npx tsc -p web/tsconfig.json --noEmit`.

**Interfaces:**
- Consumes: C API `?league=` 계약. `notFound`(next/navigation).
- Produces: `/[league]/{portfolio,leaderboard,discover}` 라우트 + `league` 컨텍스트(페이지 params).

**Steps:**
- [ ] `web/src/app/[league]/layout.tsx` 생성 — league 검증 게이트:
  ```tsx
  import { notFound } from "next/navigation";

  const LEAGUES = ["us", "kr"] as const;

  export default async function LeagueLayout({
    children, params,
  }: {
    children: React.ReactNode;
    params: Promise<{ league: string }>;
  }) {
    const { league } = await params;
    if (!(LEAGUES as readonly string[]).includes(league)) notFound();
    return children;
  }
  ```
- [ ] `web/src/app/[league]/discover/page.tsx` 생성 — 리그 고정 Discover:
  ```tsx
  import { notFound } from "next/navigation";
  import { Discover } from "@/components/discover/discover";

  export default async function LeagueDiscoverPage({ params }: { params: Promise<{ league: string }> }) {
    const { league } = await params;
    const market = league === "us" ? "US" : league === "kr" ? "KR" : null;
    if (!market) notFound();
    return (
      <main className="flex-1">
        <Discover market={market} />
      </main>
    );
  }
  ```
  (`Discover`의 `market` prop은 D 다음 단계에서 추가.)
- [ ] `web/src/app/[league]/portfolio/page.tsx` 생성 — 기존 `web/src/app/portfolio/page.tsx`(349줄) 로직을 그대로 옮기되, `fetchPortfolio`가 `/api/portfolio?league=${league}` 호출, `valuePosition`/총자산 계산에서 **fxRate 환산 제거**(리그 단일 통화 — US 리그면 전부 USD, KR 리그면 전부 KRW). 통화는 `league==='us' ? 'USD' : 'KRW'` 고정. `LoginPrompt`의 `callbackURL`은 `/${league}/portfolio`. `PortfolioResponse`(C2)에 `fxRate` 없음·`cash`/`reserved`/`realizedPnl`/`costBasis` 네이티브 반영. `page` 컴포넌트는 `params: Promise<{league}>`를 await해 하위로 전달.
  > **fxRate 제거 구체:** 기존 `valuePosition`(`:44-55`)의 `p.market === "US" ? (fxRate>0 ? nativeValue*fxRate : null) : nativeValue`를 리그 통화 단일 평가 `nativeValue`로. `hasUnconvertible`·"환산 불가" 분기 삭제(리그 단일 통화라 항상 환산 가능). `formatPrice(…, currency)`의 `currency`는 리그 통화 고정.
- [ ] `web/src/app/[league]/leaderboard/page.tsx` 생성 — 메타데이터 + `LeaderboardView`에 `league` 전달:
  ```tsx
  import type { Metadata } from "next";
  import { notFound } from "next/navigation";
  import { LeaderboardView } from "@/app/leaderboard/leaderboard-view";

  export const metadata: Metadata = { title: "리더보드 — 모의주식", description: "이번 주 리그 실시간 수익률 순위. 봇 벤치마크 포함." };

  export default async function LeagueLeaderboardPage({ params }: { params: Promise<{ league: string }> }) {
    const { league } = await params;
    const market = league === "us" ? "US" : league === "kr" ? "KR" : null;
    if (!market) notFound();
    return <main className="flex-1"><LeaderboardView league={league} market={market} /></main>;
  }
  ```
  (`leaderboard-view.tsx`는 D3에서 `league`/`market` prop 수용.)
- [ ] 구 라우트 삭제:
  ```
  git rm web/src/app/portfolio/page.tsx
  git rm web/src/app/leaderboard/page.tsx
  # leaderboard-view.tsx 는 D3에서 이동/갱신하므로 아직 남겨둔다.
  ```
- [ ] Gate: `npx tsc -p web/tsconfig.json --noEmit` (Discover/LeaderboardView prop은 다음 단계 전이면 실패 잔존 — 이 태스크 마지막에 D2/D3와 함께 그린).
- [ ] 커밋:
  ```
  git add web/src/app/[league]/
  git commit -m "feat(web-ui): /[league] 세그먼트 라우트 — portfolio·leaderboard·discover 리그 스코프

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task D2 — 헤더 리그 스위처 + Discover 리그 prop

**Files:**
- Modify: `web/src/components/layout/site-header.tsx:10-16` (NAV), `:22-56` (렌더 — 스위처 추가)
- Modify: `web/src/components/discover/discover.tsx:9-19` (Filter → market prop), `:32-54` (토글 제거)
- Test: `/run` 스모크(수동). 게이트 `npx tsc -p web/tsconfig.json --noEmit`.

**Interfaces:**
- Consumes: 없음(클라 상태·쿠키). Produces: 헤더 리그 스위처(us↔kr 이동, 선호 저장 기본 KR), `Discover({ market })`.

**Steps:**
- [ ] `discover.tsx`를 리그 고정으로 — `Filter` 토글 제거, `market` prop 수용. 현재 `:9-19`·`:32-54`:
  ```tsx
  type Filter = "ALL" | "KR" | "US";
  const LABEL: Record<Filter, string> = { ALL: "전체", KR: "국내", US: "해외" };
  export function Discover() {
    const [filter, setFilter] = useState<Filter>("ALL");
    const entries = useMemo(() => UNIVERSE.filter((e) => filter === "ALL" || e.market === (filter as Market)), [filter]);
    …
    <div className="mb-4 inline-flex …">{(["ALL","KR","US"] …).map(…)}</div>
  ```
  →
  ```tsx
  export function Discover({ market }: { market: Market }) {
    const entries = useMemo(() => UNIVERSE.filter((e) => e.market === market), [market]);
    …
    // 리그 토글 제거 — 리그 안에서는 그 시장만(스펙 §디스커버). 리그 전환은 헤더 스위처.
  ```
  (`useState`·`Filter`·`LABEL`·토글 `<div>` 블록 삭제. `cn` 미사용 시 import 정리.)
- [ ] `site-header.tsx` — NAV를 리그 스코프로 + 스위처. 현재 `:10-16`:
  ```tsx
  const NAV = [
    { href: "/", label: "홈" },
    { href: "/leaderboard", label: "리더보드" },
    { href: "/portfolio", label: "포트폴리오" },
    { href: "/replay", label: "리플레이" },
    { href: "/search", label: "검색" },
  ] as const;
  ```
  →
  ```tsx
  // 리그 스코프 링크는 현재 리그(쿠키/경로) prefix. 리플레이·검색은 리그 무관 전역.
  const LEAGUE_NAV = [
    { seg: "leaderboard", label: "리더보드" },
    { seg: "portfolio", label: "포트폴리오" },
    { seg: "discover", label: "발견" },
  ] as const;
  const GLOBAL_NAV = [
    { href: "/replay", label: "리플레이" },
    { href: "/search", label: "검색" },
  ] as const;
  const LEAGUES = [
    { id: "kr", label: "국내" },
    { id: "us", label: "해외" },
  ] as const;
  const LEAGUE_COOKIE = "league"; // 기본 KR
  ```
  렌더(`:22-56`): `usePathname`에서 현재 리그를 파싱(`/us/…`·`/kr/…` → 그 리그, 아니면 쿠키/기본 `kr`), `LEAGUE_NAV`는 `/${league}/${seg}`로 링크, 스위처는 두 리그 버튼(클릭 시 `document.cookie = "league=<id>; path=/"` 저장 + 현재 세그먼트 유지하며 `/${id}/${seg}`로 이동). 상승 빨강/하락 파랑 무관(네비). 스위처 active 스타일은 기존 `cn` 패턴 재사용.
  > **선호 저장:** 쿠키(`league`, path=/)로 저장해 다음 방문 시 홈에서 리그 결정. `localStorage`가 아니라 쿠키인 이유 — 홈(SSR 가능) 진입 시 서버가 읽어 리다이렉트 판단 가능(D3). 기본값 `kr`.
- [ ] Gate: `npx tsc -p web/tsconfig.json --noEmit` (홈 page.tsx는 D3 전이면 Discover prop 실패 — D3에서 그린).
- [ ] 커밋:
  ```
  git add web/src/components/layout/site-header.tsx web/src/components/discover/discover.tsx
  git commit -m "feat(web-ui): 헤더 리그 스위처(쿠키 저장 기본 KR)·Discover 리그 고정

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task D3 — 홈 두-지갑 요약 + leaderboard-view 리그화

**Files:**
- Modify: `web/src/app/page.tsx:1-9` (전면 교체 — 두-지갑 대시보드)
- Move+Modify: `web/src/app/leaderboard/leaderboard-view.tsx` → `web/src/app/[league]/leaderboard/leaderboard-view.tsx`, `league`/`market` prop 수용 + `rankParticipants` 새 시그니처(C3)
- Test: `/run` 스모크(수동). 게이트 `npx tsc -p web/tsconfig.json --noEmit` + `npm test -w web`.

**Interfaces:**
- Consumes: C3 `LeaderboardResponse`(no fxRate, `season.market`), `rankParticipants(participants, seedMoney, priceOf)`, `RankedParticipant.totalValue`/`returnAbs`. C2 `PortfolioResponse`.
- Produces: 홈 두-지갑 대시보드(US·KR 지갑·순위 요약), 리그 스코프 `LeaderboardView`.

**Steps:**
- [ ] `leaderboard-view.tsx` 이동 + prop 수용. `git mv web/src/app/leaderboard/leaderboard-view.tsx web/src/app/[league]/leaderboard/leaderboard-view.tsx`. 현재 `:42-83`:
  ```tsx
  export function LeaderboardView() {
    …
    queryFn: async ({ signal }) => { const res = await fetch(LEADERBOARD_ENDPOINT, { signal }); … }
    …
    return rankParticipants(data.participants, data.fxRate, Number(data.season.seedMoney), (m, s) => quotes[keyOf(m, s)]?.price);
  ```
  →
  ```tsx
  export function LeaderboardView({ league, market }: { league: string; market: Market }) {
    …
    queryKey: ["leaderboard", league],
    queryFn: async ({ signal }) => { const res = await fetch(`${LEADERBOARD_ENDPOINT}?league=${league}`, { signal }); … }
    …
    return rankParticipants(data.participants, Number(data.season.seedMoney), (m, s) => quotes[keyOf(m, s)]?.price);
  ```
  `formatSignedPrice(row.returnKrw, "KRW")`(`:161`) → `formatSignedPrice(row.returnAbs, league === "us" ? "USD" : "KRW")`, `row.returnKrw`(`:159` PriceText change) → `row.returnAbs`. 리그 통화를 표시 문자열에 반영. `LEADERBOARD_ENDPOINT`(`:24`)는 상수 유지.
- [ ] `web/src/app/page.tsx` 두-지갑 대시보드로 교체. 현재 전량:
  ```tsx
  import { Discover } from "@/components/discover/discover";
  export default function Home() {
    return <main className="flex-1"><Discover /></main>;
  }
  ```
  →
  ```tsx
  import Link from "next/link";
  import { cookies } from "next/headers";

  // 두 리그(US·KR) 지갑·순위 요약 진입 화면 — 유저가 지갑 2개임을 알게. 상세는 /[league]/portfolio.
  export default async function Home() {
    const league = (await cookies()).get("league")?.value === "us" ? "us" : "kr";
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <h1 className="mb-1 text-2xl font-bold tracking-tight">두 개의 리그, 두 개의 지갑</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          국내(₩10,000,000)와 해외($10,000)를 각각 네이티브 통화로 플레이하세요.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <LeagueCard league="kr" title="국내 리그" seed="₩10,000,000" />
          <LeagueCard league="us" title="해외 리그" seed="$10,000" />
        </div>
        <div className="mt-6">
          <Link href={`/${league}/discover`} className="text-brand underline">
            {league === "us" ? "해외" : "국내"} 종목 둘러보기 →
          </Link>
        </div>
      </main>
    );
  }

  function LeagueCard({ league, title, seed }: { league: string; title: string; seed: string }) {
    return (
      <Link href={`/${league}/portfolio`} className="rounded-2xl border bg-card p-5 transition hover:border-brand">
        <div className="text-lg font-semibold">{title}</div>
        <div className="mt-1 text-sm text-muted-foreground">시드 {seed}</div>
        <div className="mt-3 flex gap-3 text-sm">
          <span className="text-brand">포트폴리오</span>
          <Link href={`/${league}/leaderboard`} className="text-muted-foreground hover:text-foreground">리더보드</Link>
        </div>
      </Link>
    );
  }
  ```
  > **ponytail:** 홈은 지갑 잔액 실시간 fetch 없이 시드·링크 요약만(진입 게이트) — 실 잔액은 각 `/[league]/portfolio`가 이미 SSE로 렌더. 실시간 홈 요약이 필요하면 그때 두 리그 `/api/portfolio?league=` 병렬 fetch 추가.
- [ ] Gate:
  ```
  npx tsc -p web/tsconfig.json --noEmit    # 기대: web 전체 통과(D 완료)
  npm test -w web                          # 기대: 전체 그린
  ```
- [ ] 커밋:
  ```
  git add web/src/app/page.tsx web/src/app/[league]/leaderboard/leaderboard-view.tsx
  git rm web/src/app/leaderboard/leaderboard-view.tsx  # git mv 로 이미 스테이징됐으면 생략
  git commit -m "feat(web-ui): 홈 두-지갑 요약 대시보드·리더보드 뷰 리그 스코프화

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task D4 — 종목상세 주문패널: 리그를 종목 market에서 도출

**Files:**
- Modify: `web/src/app/stock/[market]/[symbol]/order-panel.tsx`(리그 = `entry.market` 확인만 — 대개 무변경)
- Test: `/run` 스모크(수동). 게이트 `npx tsc -p web/tsconfig.json --noEmit`.

**Interfaces:**
- Consumes: `entry.market`(스톡 페이지가 이미 전달). C1 orders route가 body.market으로 리그 시즌 도출.
- Produces: 없음(기존 계약 유지 확인).

**Steps:**
- [ ] 확인 — `order-panel.tsx`는 이미 `entry.market`/`entry.symbol`/`entry.currency`로 주문 body를 조립(`:57-64`)하고 `formatPrice(…, entry.currency)`(`:191`·`:254`)로 리그 통화를 표시한다. **리그는 종목 market에서 이미 도출됨** — 브라우징 스위처(헤더)와 무관하게 그 시장 지갑으로 매매(C1이 body.market으로 시즌 도출). **불필요한 rewrite 금지**(format.ts 재사용, 스펙 명시). 변경 필요 없음을 확인하고, 종목 페이지 진입 시 리그 스위처가 자동 그 리그로 바뀌길 원하면 `stock-detail.tsx`에서 쿠키 `league`를 종목 market으로 set하는 1줄만 추가(선택 — ponytail: 교차 리그 모순은 이미 없으니 생략 가능).
- [ ] Gate: `npx tsc -p web/tsconfig.json --noEmit` 통과 확인(변경 없으면 이미 그린).
- [ ] (변경 시에만) 커밋:
  ```
  git add web/src/app/stock/[market]/[symbol]/
  git commit -m "chore(web-ui): 주문 패널 리그=종목 market 도출 확인(무변경 검증)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

> **Phase D 완료 게이트**: `npx tsc -p web/tsconfig.json --noEmit` 통과 + `npm test -w web` 그린 + `/run` 스모크로 `/kr/portfolio`·`/us/leaderboard`·홈 두-지갑·헤더 스위처 렌더 확인.

---

## Phase E — 마이그레이션 컷오버 + 문서

### Task E1 — 컷오버 런북 (운영 절차, 명령 위주)

**Files:**
- Create: `docs/runbooks/2026-07-09-league-separation-cutover.md`
- Test: 없음(문서). 육안 검증.

**Interfaces:** Consumes: A1 마이그레이션 `0003_*.sql`. Produces: 협조(비-롤링) 컷오버 절차.

**Steps:**
- [ ] 런북 작성 — 협조(비-롤링) 컷오버 순서 명시:
  ```
  1. 워커 중지 (Railway: 서비스 stop) — 매칭·크론·봇 정지.
  2. DB 마이그레이션: DATABASE_URL=<prod> npm run db:migrate -w shared
     - 라이브 안전장치: 프로덕션 대상은 명시적 env 플래그(예: ALLOW_PROD_MIGRATE=1) 없이는 거부.
     - 0003 은 orders.fx_rate DROP + fx_rates 테이블 DROP + cash/cost_basis/reserved/total_value ADD.
       이력(season_results·portfolio_snapshots)·accounts·positions·orders 구 KRW 통합 포맷은 폐기(클린 컷오버).
  3. web(Vercel) + worker(Railway) 신 코드 **동시** 배포 — fx_rates 드롭이 만드는 크래시 창 회피
     (구 web/worker 가 fx_rates 를 읽으면 500). 두 배포가 끝날 때까지 워커는 중지 상태 유지.
  4. 워커 시작 — 부팅 스윕이 KR·US active 시즌을 새로 생성(ensureActiveSeason × 2).
  ```
- [ ] 라이브 DB 안전장치 명시 — `db:migrate` 래퍼가 프로덕션 URL이면 env 플래그 요구(없으면 이력 폐기 방지). 이력(seasonResults/snapshots) 폐기·시장 한정 시즌 신규 생성 명시.
- [ ] 커밋:
  ```
  git add docs/runbooks/2026-07-09-league-separation-cutover.md
  git commit -m "docs(runbook): US·KR 리그 분리 협조 컷오버 절차(워커중지→마이그레이션→동시배포→시작)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task E2 — 문서 갱신 (metrics · PRD · ADR-0004 · db.md · worker.md)

**Files:**
- Modify: `docs/metrics.md`, `docs/specs/2026-07-04-모의주식게임-v1-PRD.md`(주석), `.claude/rules/db.md`, `.claude/rules/worker.md`
- Create: `docs/adr/0004-us-kr-league-separation.md`
- Test: 없음(문서).

**Interfaces:** Produces: 갱신된 규칙·지표·ADR.

**Steps:**
- [ ] `docs/adr/0004-us-kr-league-separation.md` 작성 — 결정: 리그 ≡ 시장 1:1, 네이티브 통화 지갑 2개(US $10,000 / KR ₩10,000,000), 리그별 시즌 경계(KR 금 15:30 KST / US 금 16:00 ET), `fxRate` 게임 로직 제거, 멱등 `UNIQUE(user_id, season_id, key)`. 대안(단일 시즌·환산 유지) 기각 근거(BLOCKER: 단일 로우 시즌 가정·리그 간 키 충돌·US 금요일 경계 누락). ADR-0003(KR 데이터) 링크.
- [ ] `.claude/rules/db.md` 갱신 — 회계 불변식 항(`avgCost`·`realizedPnl` 환차 언급)을 **리그별 네이티브·환산 없음**으로, 컬럼명 `cash_krw`→`cash`·`costBasisKrw`→`costBasis`·`reservedKrw`→`reserved`·`totalValueKrw`→`totalValue`, 멱등키 `UNIQUE(user_id, key)`→`UNIQUE(user_id, season_id, key)`, "환율(B8)" 항 삭제(fxRates 제거).
- [ ] `.claude/rules/worker.md` 갱신 — "시즌 확정 = 상태 기반 멱등 스윕"을 **리그별 마감창 스윕**(KR 금 15:35~16:05 / US 토 05:05~06:05, 상시 5분 스윕 폐지)으로, autosuspend 보존 시간창 명시. fx 크론 삭제 반영.
- [ ] `docs/metrics.md` — KPI를 리그별(US·KR 각각)로 분리. `docs/specs/…PRD.md`에 리그 분리 반영 주석(§4.1·§5.3·§6 근처).
- [ ] 커밋:
  ```
  git add docs/adr/0004-us-kr-league-separation.md docs/metrics.md docs/specs/2026-07-04-모의주식게임-v1-PRD.md .claude/rules/db.md .claude/rules/worker.md
  git commit -m "docs: ADR-0004 리그 분리·metrics 리그별 KPI·db/worker 규칙 갱신

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## 최종 검증 (전 Phase 후)
- [ ] `npm run typecheck` (shared + worker) 통과.
- [ ] `npx tsc -p web/tsconfig.json --noEmit` 통과(루트 typecheck가 web 미커버).
- [ ] `npm test -w shared` (fillOrder·seasons — 리그별 불변식 + US 금요일 경계) 그린.
- [ ] `npm test -w worker` 그린.
- [ ] `npm test -w web` (limit·portfolio·leaderboard) 그린.
- [ ] `/run` 스모크: 홈 두-지갑 → 헤더 스위처 us↔kr → `/kr/portfolio`·`/us/leaderboard`·`/us/discover` 렌더, 종목상세 주문 패널 리그 통화 표기.
- [ ] 적대적 리뷰 패널(정합성·회계/단위·Neon보존 B13·경계 정확성·멱등 스코프) + Codex 교차검증 — 확정 지적만 반영.
