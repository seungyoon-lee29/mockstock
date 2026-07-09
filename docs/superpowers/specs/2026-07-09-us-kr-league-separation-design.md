# US·KR 리그 분리 (리그 ≡ 시장, 네이티브 통화 지갑 2개 · fxRate 제거)

- 상태: 설계 확정 (2026-07-09)
- 범위: 정산 코어 재설계 — 시즌·계좌·주문·스냅샷의 시장 한정(market-qualified)화, `fxRate` 게임 로직 완전 제거, `/[league]` 라우트. **KR 일봉 수집·리플레이는 독립(범위 밖)**.
- 관련: ADR-0003(KR 데이터 소스), 신규 ADR-0004(리그 분리) 제안, `.claude/rules/db.md`·`.claude/rules/worker.md`·`.claude/rules/ui.md`, PRD §4.1·§5.3·§6

## 배경·정직한 스코프

현재 게임은 US·KR를 **하나의 시즌·하나의 KRW 지갑**으로 묶고, US 종목은 `fxRate`로 매 체결 시 KRW 환산해 정산한다. 이 구조를 **5렌즈 적대적 설계 리뷰**에 걸었더니, 표면 UX가 아니라 **정산 코어**가 흔들리는 것이 드러났다:

- "the active season"을 **단일 로우로 가정**하는 조회가 API·크론 전반에 퍼져 있어(BLOCKER), 시즌이 둘이 되는 순간 US 주문이 KR 시즌에 섞이거나 그 반대가 된다.
- 멱등키가 `UNIQUE(user_id, key)`라 **리그 간 키 충돌**(같은 키를 US·KR에서 쓰면 한쪽이 원본으로 재생)이 가능하다(BLOCKER).
- US 정규장은 금요일 미 동부 16:00(≈토 05:00 KST)에 닫는데, 현재 시즌 경계는 **금 15:30 KST 확정**이라 US 금요일 장 움직임이 통째로 정산에서 누락된다.

따라서 이번 작업은 **리그 ≡ 시장(1:1)** 로 못박고, 유저는 **두 리그를 동시에 네이티브 통화 지갑으로** 플레이한다(US=USD $10,000 / KR=KRW ₩10,000,000). 지갑·시즌·랭킹·정산은 리그별 독립이고, `fxRate`는 게임 로직에서 **완전히 사라진다**(US는 USD로 네이티브 정산). 환차손익이라는 교차 통화 항이 없어져 `Σ realizedPnl ≡ 현금 증감` 불변식이 **리그별 단일 통화**로 단순해진다.

**독립(범위 밖)**: KR 리플레이용 과거 일봉 수집은 ADR-0003이 이미 소스를 확정했다(공공데이터포털 15094808). 리플레이는 리그 분리와 데이터 경로가 겹치지 않으므로 이 스펙과 **분리된 후속**으로 진행한다.

## 코어 모델

- **시장 한정 시즌 id**: `<isoweek>:US` / `<isoweek>:KR`. 매주 **active 시즌이 2개** 존재한다. `seasons`에 `market` 컬럼(NOT NULL)을 추가하고, `seedMoney`는 리그별 네이티브 값(US 10,000 · KR 10,000,000)을 시즌 로우에 담는다.
- **리그별 시즌 경계**(수정된 결정 — 초기 "양쪽 동일 주간 창" 안은 **기각**):
  - KR 주: 월 00:00 → 금 15:30 KST.
  - US 주: **US 금요일 장 마감 이후**에 끝나야 한다 = 금 16:00 ET ≈ 토 05:00 KST. DST를 타므로 절대시각 하드코딩 금지, `shared/src/marketCalendar.ts`의 tz 계산(`America/New_York`)을 경유한다.
  - `weeklyPeriod(now)`를 `weeklyPeriod(market, now)`로 바꿔 시장별 경계를 반환한다.
  - 각 리그의 확정·스냅샷은 **그 리그 시장이 닫힌 뒤**에 돈다.

## 스키마 변경 (`shared/src/schema.ts` + 신규 drizzle 마이그레이션)

현재 스키마(`shared/src/schema.ts`)를 기준으로 한 변경 목록. 금액은 전부 `numeric`(float 금지, db.md).

| 테이블 | 현재 (파일:라인) | 변경 |
| --- | --- | --- |
| `seasons` (L54–60) | `seedMoney` numeric, id = `season_<iso>` | **+ `market` (marketEnum, NOT NULL)**, id 시장 한정(`<isoweek>:US`/`:KR`), `seedMoney`는 리그별 네이티브 |
| `accounts` (L68) | `cashKrw` numeric(18,2) | **`cash`로 rename**(네이티브, 통화는 시즌의 market이 함의). `CHECK (cash >= 0)` 유지(현 `cash_krw_non_negative`, L73) |
| `positions` (L88) | `costBasisKrw` numeric(18,2) | **`costBasis`로 rename**(네이티브 총 취득원가) |
| `orders` (L113·L116·L124) | `fxRate`(L113)·`reservedKrw`(L116)·`UNIQUE(user_id, key)`(L124) | **`fxRate` 컬럼 DROP**, `reservedKrw` → **`reserved`**(네이티브), 멱등 유니크 **`UNIQUE(user_id, key)` → `UNIQUE(user_id, season_id, key)`**(리그 간 키 충돌 차단, BLOCKER) |
| `portfolioSnapshots` (L176) | `totalValueKrw` numeric(18,2) | **`totalValue`로 rename**(네이티브). 리그는 seasonId가 인코딩 → MDD·수익률 리그별 산출 |
| `seasonResults` (L137) | `finalValue` numeric(18,2) | **이름 유지, 의미만 네이티브 통화**(리그는 조인한 season.market에서). 불필요한 rename 회피 — 명시만 한다 |
| `fxRates` (L213–217) | 통화쌍 단일 로우 테이블 | **테이블 DROP** |

- **numeric 정밀도**: `numeric(18,2)`는 USD 센트와 KRW 정수원(整数원)을 **양쪽 다 안전하게** 담는다(현행 그대로 유지). `cash`·`costBasis`에 컬럼 코멘트 추가: "리그별 네이티브 통화; toCents/fromCents 사용".
- `ponytail:` v1은 리그별 CHECK(예: KRW는 정수만) 추가하지 않는다 — `numeric(18,2)`가 둘 다 담고 회계는 fillOrder가 센트 정수로 강제하므로 불필요. 통화별 반올림 정책이 갈라지면 그때 CHECK 분리.

## 상수 & fillOrder

### `shared/src/rules.ts`
- **추가**: `SEED_MONEY_USD = 10_000` (기존 `SEED_MONEY_KRW = 10_000_000` L4 유지). `ponytail:` 리그→시드 맵(`SEED_MONEY: Record<Market, number>`) 한 개로 두 상수를 묶어도 됨 — 소비처가 늘면 맵으로.
- **rename**: `positionLimitKrw(seedMoneyKrw)` (L10) → `positionLimit(seedMoney)` — 통화 불문(currency-agnostic). `POSITION_LIMIT_PCT`(L7)는 그대로.
- **삭제**: `FX_PAIR_USDKRW` (L30).

### `shared/src/fillOrder.ts`
- `FillInput`에서 **`fxRate` 드롭**(L41).
- `amountCents(price, fxRate, qty)` (L66) → **`amountCents(price, qty)`** — 환산 없는 네이티브 금액(`Math.round(price * qty * 100)`).
- 매수는 네이티브 `cash` 차감, 매도는 네이티브 대금 credit. 40% 종목 상한(L157–191)은 그대로지만 기준은 **그 리그 시즌 `seedMoney × 0.4`**(이미 `seasons.seedMoney` 조회 경로 L159–163 사용 → market이 seasonId에 인코딩되어 자동으로 올바른 리그 시드).
- 불변식 `Σ realizedPnl ≡ 현금 증감`은 이제 **리그별·단일 통화**로 성립(교차 통화 항 제거로 더 단순).
- **모든 호출부 갱신**:
  - `web/src/app/api/orders/route.ts`: fx 로드 블록(L94–106) **삭제**, `fillOrder(...)` 호출에서 `fxRate` 인자(L224) 제거. 리그 시즌은 주문의 market으로 도출(아래 §"active 시즌" 참조).
  - `worker/src/matching.ts`: `usdKrw` 전역(L51)·fx fetch(L125–126)·`FX_PAIR_USDKRW` import(L7) 제거. `evaluate`의 fxRate 산출(L138–139) 삭제 → US 매도도 USD로 네이티브 체결. `OpenOrder.fxRate`·`SyncOrderInput.fxRate` 필드 제거.

## "active 시즌" 조회 — 전면 수정 (BLOCKER, 전 리뷰어 지적)

현재 "the active season" 조회는 전부 **단일 로우**를 가정한다(`WHERE status='active' … LIMIT 1`). 시즌이 둘이 되면 잘못된 리그로 붙는다. 지점별 수정:

| 위치 | 현재 (파일:라인) | 수정 |
| --- | --- | --- |
| `shared/src/seasons.ts` `ensureActiveSeason` | L159–182, `WHERE status='active'` 단건 | **`market` 파라미터 추가**, `WHERE status='active' AND market=$market`. `currentPeriod`/`weeklyPeriod`도 market 인지 |
| `web/src/app/api/orders/route.ts` | L72–78 `LIMIT 1` | 주문 입력의 `market`(이미 파싱됨 L67)으로 해당 리그 시즌 조회. 시드 upsert(L81–84)도 그 시즌 `seedMoney`로 |
| `web/src/app/api/portfolio/route.ts` | L29–40 `LIMIT 1` | market을 신규 `/[league]` 세그먼트에서 받아 리그 시즌 조회 |
| `web/src/app/api/leaderboard/route.ts` | L29–40 `LIMIT 1` | 위와 동일 — league별 시즌. 인메모리 TTL 캐시(L19)는 **리그별 키**로 분리 |
| worker cron (`worker/src/cron.ts`) | L88–92 부팅 스윕 등 | 두 market을 루프(아래 §워커 수명주기) |

## 워커 수명주기 (`worker/src/cron.ts`, `shared/src/seasons.ts`)

`resetSeason`(seasons.ts L189)·`finalizeDueSeasons`(L220)·`snapshotPortfolios`(L330)·`ensureActiveSeason`(L159)를 전부 시장 인지로 만든다(파라미터 또는 두 market 루프).

- **리셋**: KR 시즌은 월 08:30 KST(KR 개장 전, 현 cron L95)에 리셋. US 시즌은 **US 월요일 개장 전**에 리셋(별도 스케줄). `resetSeason(db, cfg, market)`.
- **확정**: 상태 기반 멱등 스윕(현 `finalizeDueSeasons` + cron L97)을 market별로. 각 리그는 **그 시장의 주간 마감 이후**에만 확정 — US는 ≈토 05:00 KST 이후라야 US 금요일 장 움직임이 반영된다. `endsAt`이 리그별 경계를 담으므로 `WHERE status='active' AND endsAt<=now` 스윕이 자연히 리그별로 갈린다(추가 분기 불필요).
- **스냅샷**: KR은 15:40 KST(현 cron L99). US는 그 시장 마감 이후(≈다음날 05:00 KST). MDD는 리그별 스냅샷 시퀀스로 산출.
- **Neon autosuspend (B13, worker.md)**: 5분 스윕 + US 야간 시간대가 **DB를 24/7 깨우면 안 된다**. 확정·스냅샷은 각 시장 마감 직후 **좁은 시간창**에서만 돌게 스케줄한다(상시 스윕 금지). 모든 `cron.schedule`은 `{ timezone: 'Asia/Seoul' }` 필수(Railway=UTC, worker.md).
- `ponytail:` 확정 스윕을 리그별 정각창 크론 2개로 나눈다(현행 매 5분 상시 스윕 → US 마감창 + KR 마감창). 스윕이 여전히 상태 기반 멱등이라 다운타임에도 다음 창에서 밀린 시즌을 잡는다.

## UI (web)

- **리그 = 라우트 세그먼트** `/[league]/...`(league ∈ `us`|`kr`) — 리스트/스코프 뷰용: `/[league]/portfolio`, `/[league]/leaderboard`, `/[league]/discover`. **클라 전용 토글 상태가 아니라 URL**이라 SSR·딥링크·북마크가 일관된다. 현재 `web/src/app/{portfolio,leaderboard}/`와 홈 `page.tsx`의 `<Discover/>`가 이 세그먼트 아래로 이동한다.
- **전역 리그 스위처**를 사이트 헤더(`web/src/components/layout/site-header.tsx` — 현 `NAV` L10–16)에 추가해 세그먼트 간 이동 + 선호 저장(cookie/localStorage, 기본 KR).
- **종목 상세는 `/stock/[market]/[symbol]` 유지**. 리그는 **종목의 market에서 도출**되고, 주문 패널(`order-panel.tsx`)은 브라우징 스위처와 무관하게 **그 시장의 지갑**으로 매매한다(교차 리그 모순 해소).
- **검색은 시장 전역 유지**(`/search`). 결과 선택 시 그 종목 시장의 상세로 이동(리그 = 그 market).
- **디스커버**: 기존 전체/국내/해외 토글(`discover.tsx` L9–10 `Filter`, L39–54 버튼)은 리그별 `/[league]/discover`로 **대체**된다 — 리그 안에서는 "전체"가 없다(그 리그 시장만).
- `web/src/lib/market/format.ts`는 **이미 `currency` 파라미터(USD/KRW)를 받는다**(`formatPrice(value, currency)` L4). 재사용 — 스코프 뷰가 리그 통화를 넘기게만 보장. 상승 빨강/하락 파랑(`changeClass` L31–33), 한국어(ui.md).
- **홈/온보딩**: 두 리그의 지갑·순위를 한눈에 보여주는 진입 화면 — 유저가 지갑이 2개임을 알게. (현 홈 `page.tsx`는 `<Discover/>` 단독 → 리그 요약 대시보드로.)
- **관심종목(watchlist)**: 스키마에 `watchlist_items` 테이블(schema.ts L158–167)만 있고 **UI·API 미구현**. 리그 분리 범위에서 **명시적 제외**.

## 마이그레이션 / 컷오버 런북 (정직: 출시 전 개발 단계, Neon 개발 DB, 실잔고 없음)

- **풀 클린 컷오버**: 컬럼 rename은 drizzle-kit이 신뢰 불가라 진짜 RENAME이 아니라 **DROP+ADD**로 생성될 수 있다 — **의도적으로 데이터를 밀 것**이므로 허용. `accounts`/`positions`/`orders` **및 이력**(`seasonResults`·`portfolioSnapshots`)을 폐기한다 — 구 통합-KRW 포맷은 신 네이티브 포맷과 호환 불가. 시장 한정 시즌은 워커 부팅 시 새로 생성된다.
- 시즌 로우를 **보존한다면**: `seasons.market`를 backfill한 뒤 NOT NULL 적용.
- **협조(비-롤링) 컷오버** — `fxRates` 드롭이 만드는 크래시 창을 피하려면(Vercel web·Railway worker가 **독립 배포**): ① 워커 중지 → ② DB 마이그레이션 실행 → ③ web+worker 신 코드 **동시** 배포 → ④ 워커 시작. 이 순서를 명시적으로 지킨다.
- **라이브 DB 안전장치**: 마이그레이션 래퍼는 명시적 env 플래그 없이는 프로덕션 대상 실행을 **거부**한다.
- 생성된 마이그레이션 SQL은 apply 전 **육안 검증**(`shared/drizzle/` 기존 `0000`~`0002` 다음 번호).

## 테스트

- `shared/src/seasons.test.ts`·`web/src/lib/leaderboard.test.ts`·`shared/src/fillOrder.test.ts`를 **두 리그 공존**으로 재파라미터화(예: `seasonUs`/`seasonKr` 픽스처). 현재 픽스처는 단일 `season_x`/`s1` + `SEED_MONEY_KRW`만 쓴다(leaderboard.test.ts L25–30, fillOrder.test.ts L38–44).
- fillOrder 테스트는 `fxRate` 인자·환차 검증을 제거(현 `FillInput.fxRate` 경로).
- **리그별 불변식 테스트 추가**: `Σ realizedPnl ≡ cash`(네이티브 통화, 리그별).

## 검증

- `npm run typecheck` 통과(shared + worker + web).
- 리그별 불변식 테스트: `Σ realizedPnl ≡ cash` — US(USD)·KR(KRW) 각각.
- **US 금요일 경계 테스트**: US 시즌 `endsAt`이 US 금요일 정규장(16:00 ET) **이후**임을 확인 — 금요일 US 장 체결이 정산에 포함되는지(경계 회귀 방지).
- **멱등키 리그 간 테스트**: 같은 `idempotencyKey`를 US·KR에서 접수했을 때 **둘 다 독립 체결**(한쪽이 다른 쪽을 원본으로 재생하지 않음) — `UNIQUE(user_id, season_id, key)` 검증.

## 오케스트레이션

의존 루트 **A가 공용 계약을 확정**한 뒤 B·C·D가 **서로소 파일 집합**을 병렬 구현한다(charts 스펙과 동일 패턴).

1. **A — shared 계약 (먼저, 단독)**: `schema.ts`(market 컬럼·rename·유니크·fxRates 드롭) + `rules.ts`(SEED_MONEY_USD·positionLimit·FX 상수 제거) + `fillOrder.ts`(fxRate 제거·amountCents 시그니처) + `seasons.ts`(market 인지 경계·수명주기) + drizzle 마이그레이션 생성·검증. **발행 계약**: `weeklyPeriod(market)`·`ensureActiveSeason(db,cfg,market)`·`positionLimit(seedMoney)`·`FillInput`(fxRate 없음)·시장 한정 시즌 id 규약.
2. **typecheck 게이트** — A 확정 후 `npm run typecheck` 통과해야 B·C·D 착수.
3. **병렬(서로소 파일)**:
   - **B — 워커 수명주기** (`worker/`): `cron.ts`·`matching.ts`(fx 제거). 리그별 리셋·확정·스냅샷 스케줄, Neon 보존 시간창.
   - **C — web API·라우트** (`web/src/app/api/`): `orders`·`portfolio`·`leaderboard` route를 리그 시즌 도출로. fx 로드 제거.
   - **D — web UI·`/[league]` 라우트** (`web/src/app/[league]/`·`components/`): 세그먼트 라우트, 헤더 리그 스위처, 디스커버 대체, 홈 두-지갑 요약.
4. **적대적 리뷰**: 서브에이전트 리뷰 패널(정합성·회계/단위·Neon보존 B13·경계 정확성·멱등 스코프) + Codex 교차검증. 확정 지적만 반영.
5. **마이그레이션 컷오버**: 위 런북 순서(워커 중지→마이그레이션→web+worker 동시 배포→워커 시작).

## 갱신 대상 문서 (이 스펙에서 편집하지 않음 — 후속)

- `docs/metrics.md` — KPI를 리그별로.
- PRD(`docs/specs/2026-07-04-모의주식게임-v1-PRD.md`) — 리그 분리 반영 주석.
- **신규 ADR 제안 `docs/adr/0004-us-kr-league-separation.md`** — 리그≡시장 + 네이티브 통화 + 리그별 경계 결정 기록.
- `.claude/rules/db.md` — `reserved` rename·`cash` 네이티브·멱등 유니크 스코프(`user_id, season_id, key`).
- `.claude/rules/worker.md` — 리그별 시즌 수명주기 + autosuspend 시간창.
