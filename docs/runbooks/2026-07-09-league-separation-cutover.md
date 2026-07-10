# US·KR 리그 분리 협조 컷오버 런북

**날짜:** 2026-07-09  
**마이그레이션:** `0003_market_native_currency.sql`  
**방식:** 협조(비-롤링) 컷오버 — 두 배포가 완료될 때까지 서비스 중단 허용  
**담당:** 운영자 직접 실행 (복붙 가능한 명령 위주)

---

## 개요

0003 마이그레이션은 **이력을 폐기하는 클린 컷오버**다.

변경 내용:
- `fx_rates` 테이블 DROP
- `orders.fx_rate`, `orders.reserved_krw` 컬럼 DROP
- `accounts.cash_krw` → `accounts.cash` (네이티브 통화, numeric)
- `positions.cost_basis_krw` → `positions.cost_basis`
- `portfolio_snapshots.total_value_krw` → `total_value`
- `seasons.market` 컬럼 추가 (NOT NULL)
- 멱등키 유니크 인덱스 → `UNIQUE(user_id, season_id, idempotency_key)` 확장

기존 `season_results`, `portfolio_snapshots`, `accounts`, `positions`, `orders`의 구 KRW 통합 포맷 데이터는 **전부 폐기**된다. 출시 전 개발 DB라 허용.

---

## 사전 조건 확인

```bash
# 1. DATABASE_URL 설정 확인 (프로덕션 Neon URL)
echo $DATABASE_URL | cut -c1-30   # 앞 30자만 출력 (시크릿 노출 방지)

# 2. Railway CLI 설치 확인
railway --version

# 3. Vercel CLI 설치 확인
vercel --version
```

---

## 단계 1 — 워커 중지 (Railway)

매칭·크론·봇을 완전 정지한다. DB 마이그레이션 전에 워커가 구 스키마(`fx_rates` 등)에 쓰는 것을 방지.

```bash
# Railway 대시보드에서 워커 서비스 stop, 또는:
railway service down --service worker
```

**확인:** Railway 대시보드에서 worker 서비스 상태가 `Sleeping` 또는 `Stopped` 인지 확인.

---

## 단계 2 — DB 마이그레이션

### 안전장치

`npm run db:migrate -w shared` 는 래퍼 스크립트(`shared/scripts/migrate.ts`)를 거친다.

- `DATABASE_URL` 이 `localhost` / `127.0.0.1` 이 아니면 프로덕션으로 판정
- **`ALLOW_PROD_MIGRATE=1` 없이는 종료 코드 1로 중단** — 실수 방지

### 실행

```bash
# 반드시 두 env 모두 지정:
DATABASE_URL="<Neon 프로덕션 URL>" \
ALLOW_PROD_MIGRATE=1 \
npm run db:migrate -w shared
```

**예상 출력:**
```
[migrate] ALLOW_PROD_MIGRATE=1 확인 — 프로덕션 마이그레이션 실행.
Reading config file '…/drizzle.config.ts'
…applying migrations…
✓ done
```

### 0003 이 적용하는 변경 요약

| 작업 | 대상 |
|------|------|
| DROP TABLE | `fx_rates` |
| DROP COLUMN | `orders.fx_rate`, `orders.reserved_krw` |
| ADD COLUMN | `orders.reserved numeric(18,2)` |
| DROP COLUMN | `accounts.cash_krw` |
| ADD COLUMN | `accounts.cash numeric(18,2) NOT NULL` |
| DROP COLUMN | `positions.cost_basis_krw` |
| ADD COLUMN | `positions.cost_basis numeric(18,2) NOT NULL` |
| DROP COLUMN | `portfolio_snapshots.total_value_krw` |
| ADD COLUMN | `portfolio_snapshots.total_value numeric(18,2) NOT NULL` |
| ADD COLUMN | `seasons.market market NOT NULL` |
| DROP INDEX | `orders_user_idempotency_uq` |
| CREATE UNIQUE INDEX | `orders_user_season_idempotency_uq (user_id, season_id, idempotency_key)` |

> **주의:** `seasons.market NOT NULL`은 기존 rows가 있으면 마이그레이션 실패. 개발 DB라 테이블을 미리 비우거나 기존 시즌을 삭제하고 실행할 것.
>
> ```sql
> -- 필요 시 기존 데이터 정리 (데이터 폐기 컷오버이므로 허용)
> TRUNCATE seasons, accounts, positions, orders,
>          portfolio_snapshots, season_results CASCADE;
> ```

---

## 단계 3 — 신 코드 동시 배포

**web(Vercel)과 worker(Railway) 를 동시에 배포한다.**

구 web/worker 는 `fx_rates` 를 읽으므로 마이그레이션 완료 후 구 코드를 유지하면 즉시 500 에러.  
두 배포가 모두 완료될 때까지 워커는 중지 상태를 유지한다.

### 3a. Vercel web 배포

```bash
# main 브랜치 push 또는:
vercel --prod
```

Vercel 대시보드에서 배포 완료(Ready) 확인.

### 3b. Railway worker 신 코드 반영

```bash
# Railway는 main 브랜치 push 로 자동 배포 (GitHub 연결 시).
# 자동 배포 비활성화 상태라면:
railway up --service worker
```

Railway 대시보드에서 worker 빌드·배포 완료 확인.  
**단, 아직 서비스를 시작하지 않는다 — 단계 4에서 시작.**

---

## 단계 4 — 워커 시작

두 배포가 모두 완료된 후 워커를 시작한다.

```bash
railway service up --service worker
# 또는 Railway 대시보드에서 수동 Start
```

**부팅 스윕 확인 (Discord 통지 또는 로그):**

```
✅ 부팅 스윕 완료 — {"finalized":0}
```

부팅 시 `ensureActiveSeason(db, cfg, "KR")` + `ensureActiveSeason(db, cfg, "US")` 가 각각 실행되어  
**KR·US active 시즌이 새로 생성**된다 (`worker/src/cron.ts` 부팅 스윕).

---

## 롤백

0003은 `DROP TABLE` / `DROP COLUMN` 을 포함하므로 **자동 롤백 없음**.

롤백이 필요하면:
1. 워커 중지
2. 이전 DB 스냅샷 복원 (Neon 브랜치 또는 백업)
3. 구 코드 재배포

---

## 완료 체크리스트

- [ ] 워커 중지 확인
- [ ] 마이그레이션 성공 (`✓ done` 출력)
- [ ] Vercel web 배포 완료
- [ ] Railway worker 신 코드 반영 완료
- [ ] 워커 시작 + 부팅 스윕 `✅` 통지 확인
- [ ] KR/US 두 시즌 DB 생성 확인 (`SELECT id, market, status FROM seasons`)
- [ ] 서비스 정상 응답 확인 (`/api/health` 또는 메인 페이지)
