# 배포 런북 — 모의 주식게임

web(Next.js 16) → **Vercel**, worker(Node 상주, tsx) → **Railway**, DB → **Neon Postgres**(이미 프로비저닝).

이 문서는 **계정을 만든 뒤 그대로 따라 실행**하는 절차서다. 코드·설정은 이미 커밋돼 있고, 여기서 할 일은 **대시보드 설정 + env 값 입력 + 배포 트리거**뿐이다. 실제 시크릿 값은 리포에 절대 커밋하지 말고 각 플랫폼 대시보드에만 넣는다.

---

## 0. 시작 전 — 반드시 읽을 것

### 0-1. ✅ worker fail-closed 부팅 게이트 — **코드로 강제됨**

`.claude/rules/worker.md`의 "프로덕션에서 `WORKER_SECRET`·`CORS_ORIGIN` 부재 시 부팅 실패" 요구가 **이제 코드에 반영됐다.** 시크릿·CORS를 안 넣으면 worker가 **프로덕션에서 아예 뜨지 않는다**(무인증 개방 상태로 기동하는 경로가 없다).

- `worker/src/config.ts` `assertProductionConfig()`: `NODE_ENV=production`에서 `WORKER_SECRET`(실값)·`CORS_ORIGIN`(실오리진, `*` 불가) 중 하나라도 없으면 한국어 에러 로그 + `process.exit(1)`. `worker/src/index.ts` 부팅 최상단에서 호출한다. Railway는 `NODE_ENV=production`을 주입하므로 이 게이트가 발동한다.
- `worker/src/sse.ts` `/internal/orders/sync`(상태 변경): 인증이 **무조건**이다 — `WORKER_SECRET` 미설정이면 `if (!config.workerSecret || ...)`로 항상 `401`(fail-closed). 인증 없는 상태 변경 경로가 없다.
- `/snapshot`(읽기): 시크릿 설정 시 검증(조건부). 프로덕션은 위 부팅 게이트가 시크릿을 보장하므로 사실상 상시 인증, 로컬 mock은 무인증 읽기 허용(무해).
- 로컬(`NODE_ENV`≠production, mock 피드)은 게이트 미발동 — 키 없이 그대로 기동한다.

**배포 시 지켜야 할 것:** `WORKER_SECRET`·`CORS_ORIGIN`을 Railway env에 채운다. 안 채우면 **부팅이 실패**하므로(무인증 개방이 아니라 기동 거부) 아래 [1-3 env 표]에서 두 변수를 **필수**로 표시했다.

### 0-2. 이미 코드에 반영돼 안심해도 되는 것

- **크론 타임존**: `worker/src/cron.ts`의 5개 `cron.schedule` 전부 `{ timezone: "Asia/Seoul" }` 명시됨. Railway가 UTC로 돌아도 시즌 크론이 9시간 어긋나지 않는다. 별도 조치 불필요.
- **Neon 보존(B13)**: worker는 `pg` Pool `max:4`, `idleTimeoutMillis:10s`로 유휴 소켓을 자동 해제(`worker/src/db.ts`) → Neon autosuspend 유지. `DATABASE_URL`만 넣으면 됨.
- **자격증명 경계(B6/B14)**: `KIS_*`·`FINNHUB_*`는 worker에만 소비된다(web 코드에 없음). **web env에 절대 넣지 말 것.**

---

## 1. Railway — worker 배포

worker는 빌드 스텝이 없다. `tsx`로 TS 소스를 직실행한다. 모노레포 워크스페이스라 **설치는 반드시 리포 루트에서** 돌아야 `@mockstock/shared` 심볼릭·호이스트가 성립한다.

### 1-1. 서비스 생성 & 대시보드 설정

1. Railway → New Project → **Deploy from GitHub repo** → 이 리포 선택.
2. 서비스 Settings:
   - **Root Directory**: `/` (리포 루트 그대로 둔다). ⚠️ `worker/`로 바꾸면 워크스페이스 심볼릭이 깨져 부팅 실패.
   - **Config-as-code**: 리포 루트의 `railway.json`이 자동 적용된다. 여기에 이미 들어있는 값:
     - `buildCommand`: no-op(`echo …`) — 루트 `npm run build`(=web 빌드!)가 워커 서비스에서 잘못 도는 걸 막는다.
     - `startCommand`: `npm start -w @mockstock/worker`
     - `healthcheckPath`: `/health`
   - 대시보드에서 Start Command·Healthcheck를 **따로 입력할 필요 없음** — railway.json이 소스다.
3. **PORT**: 입력하지 않는다. Railway가 자동 주입하고 `config.ts`가 `process.env.PORT`를 바인딩한다.

> **왜 `tsx`가 dependencies인가:** worker는 프로덕션에서도 `tsx`로 실행되므로 `tsx`는 런타임 의존이다. `worker/package.json`에서 `dependencies`로 옮겨뒀다 → Railway가 `--omit=dev`로 설치해도 프루닝되지 않는다.

### 1-2. 배포 & 헬스체크 확인

첫 배포 후 Railway가 발급한 도메인(예: `https://mockstock-worker-production.up.railway.app`)을 복사한다. 이 도메인이 아래 web env(`NEXT_PUBLIC_STREAM_URL`, `WORKER_SNAPSHOT_URL`)의 베이스가 된다.

```bash
curl https://<worker-domain>/health
# 기대: {"ok":true,"feeds":{"KR":"mock","US":"mock"},"symbols":...,"age":{...}}
```

### 1-3. worker env 변수 (Railway → Variables)

| 변수 | 종류 | 필수 | 값·용도 |
| --- | --- | --- | --- |
| `WORKER_SECRET` | secret | **필수** | web↔worker 공유 시크릿. web env와 **동일 값**. **미설정 시 프로덕션 부팅 실패**(0-1 게이트). 생성: `openssl rand -base64 32` |
| `CORS_ORIGIN` | config | **필수** | 브라우저가 `/stream`에 직결하므로 web Vercel 오리진으로 **고정**(예: `https://<web-domain>`). `*` 또는 미설정 시 **프로덕션 부팅 실패**(0-1 게이트). |
| `DATABASE_URL` | secret | **필수** | Neon 연결 문자열(이미 프로비저닝된 값). 크론·매칭·봇이 사용. |
| `FEED_KR` | config | 선택 | `kis`\|`mock`. 실 키 발급 전엔 **`mock` 유지**(또는 비움=기본 mock). |
| `FEED_US` | config | 선택 | `finnhub`\|`mock`. 실 키 발급 전엔 `mock`. |
| `FINNHUB_API_KEY` | secret | 선택 | US 실시세. **worker 전용(web 금지)**. 없으면 mock 폴백. |
| `KIS_APP_KEY` | secret | 선택 | KR 실시세 앱키. **worker 전용**. 없으면 mock 폴백. |
| `KIS_APP_SECRET` | secret | 선택 | KIS 앱시크릿. **worker 전용**, 로그 노출 금지. |
| `EXIM_API_KEY` | secret | 선택 | 한국수출입은행 고시환율 1순위. 없으면 frankfurter 무키 폴백. |
| `DISCORD_WEBHOOK_URL` | secret | 선택 | 크론 완료·실패 통지. URL 자체가 자격증명. 없으면 콘솔 로그. |
| `SEASON_DURATION_MS` | config | 선택 | 시즌 고정 길이(ms). 미설정=주간(월 00:00→금 15:30 KST). |
| `SEASON_SEED_KRW` | config | 선택 | 시드머니. 미설정=1,000만. |
| `FINALIZE_SWEEP_MINUTES` | config | 선택 | 확정 스윕 주기(분). 미설정=5. |
| `BOT_COUNT` | config | 선택 | 벤치마크 봇 수. 미설정=3. `DATABASE_URL` 없으면 자동 비활성. |
| `BOT_INTERVAL_SEC` | config | 선택 | 봇 매매 주기(초). 미설정=45. |
| `BOT_ORDER_PCT` | config | 선택 | 봇 1회 주문 비율. 미설정=0.1. |

> `CORS_ORIGIN`의 **최종값**은 web 도메인 확정 후에 넣지만, 부팅 게이트(0-1)가 `*`/빈값을 거부하므로 **첫 배포부터 실오리진 하나는 넣어야 뜬다**. 예상 Vercel 도메인(`https://<project>.vercel.app`)을 잠정값으로 넣고 [4. 배포 순서]에서 최종 오리진으로 교체한다.

---

## 2. Vercel — web 배포

Next.js 16 네이티브 배포. `output: standalone`·어댑터 불필요. `shared/`는 `transpilePackages`로 빌드 시 TS 원본을 소비하므로 web/ 밖 소스가 빌드에 포함돼야 한다.

### 2-1. 프로젝트 생성 & 대시보드 설정

1. Vercel → Add New → Project → 이 리포 import.
2. **Root Directory**: `web` 로 지정.
3. Vercel이 npm workspaces를 감지하면 **"Include source files outside of the Root Directory"**가 자동 활성화된다(설치는 리포 루트에서 실행). 빌드 로그에 `@mockstock/shared` 트랜스파일이 보이면 정상. 안 보이면 이 옵션을 수동 확인.
4. Framework Preset: **Next.js**(자동 감지). Build/Install/Output Command는 **기본값 그대로**(`next build` / 루트 `npm install` / 기본) — vercel.json 불필요.

### 2-2. web env 변수 (Vercel → Settings → Environment Variables, Production)

| 변수 | 종류 | 필수 | 값·용도 |
| --- | --- | --- | --- |
| `DATABASE_URL` | secret | **필수** | Neon 연결 문자열(worker와 동일). |
| `BETTER_AUTH_SECRET` | secret | **필수** | 세션 서명키. `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | config | **필수** | web 배포 오리진(`https://<web-domain>`). **코드 fallback 없음** → 미설정 시 OAuth 콜백 URL이 깨진다. |
| `WORKER_SECRET` | secret | **필수** | worker와 **동일 값**(x-worker-secret 헤더로 전송). |
| `WORKER_SNAPSHOT_URL` | config | **필수** | `https://<worker-domain>/snapshot`. 시장가 체결가 조회. 미설정 시 주문 fail-closed(접수 거부). |
| `NEXT_PUBLIC_STREAM_URL` | config | **필수** | `https://<worker-domain>/stream`. 브라우저가 직결하는 SSE URL. ⚠️ **`NEXT_PUBLIC_`=빌드타임 인라인** → Vercel 빌드 전 반드시 존재해야 클라 번들에 박힌다. 미설정 시 `/api/stream` mock 폴백. |
| `GOOGLE_CLIENT_ID` | config | 선택* | Google OAuth. |
| `GOOGLE_CLIENT_SECRET` | secret | 선택* | Google OAuth 시크릿. |
| `GITHUB_CLIENT_ID` | config | 선택* | GitHub OAuth. |
| `GITHUB_CLIENT_SECRET` | secret | 선택* | GitHub OAuth 시크릿. |

\* 소셜 로그인 제공자별로 켤 것만. 게스트(anonymous) 로그인은 키 없이 동작.

> ⚠️ **`KIS_*`·`FINNHUB_*`를 여기 넣지 말 것**(B6/B14 자격증명 경계). worker 전용이다.

### 2-3. Better Auth — OAuth 콜백 URI 등록 (승윤이 각 콘솔에서)

`BETTER_AUTH_URL`을 web 오리진으로 고정한 뒤, 각 제공자 콘솔에 **콜백 URL**을 등록한다:

- **Google** (console.cloud.google.com/apis/credentials): 승인된 리디렉션 URI = `{BETTER_AUTH_URL}/api/auth/callback/google`
- **GitHub** (github.com/settings/developers): Authorization callback URL = `{BETTER_AUTH_URL}/api/auth/callback/github`

`NEXT_PUBLIC_STREAM_URL`을 바꾸거나 도메인이 바뀌면 **web을 재빌드**해야 반영된다(빌드타임 인라인).

---

## 3. 두 서비스 배선 (요약)

```
브라우저 ──(SSE 직결: NEXT_PUBLIC_STREAM_URL)──▶ worker /stream
   │                                               ▲
   │ (로그인/주문 API)                              │ worker가 CORS_ORIGIN 으로 web 오리진 허용
   ▼                                               │
 web (Vercel) ──(WORKER_SNAPSHOT_URL + x-worker-secret)──▶ worker /snapshot, /internal/orders/sync
```

배선 불변식:
- `WORKER_SECRET`: web·worker **동일 값**. (web이 헤더로 송신 → worker가 검증)
- `CORS_ORIGIN`(worker) = web Vercel 오리진. 브라우저가 `/stream`에 직결하므로 필수.
- `NEXT_PUBLIC_STREAM_URL`(web) = `https://<worker-domain>/stream`, `WORKER_SNAPSHOT_URL` = `.../snapshot`.
- `BETTER_AUTH_URL`(web) = web 오리진. OAuth 콜백 베이스.
- 모든 URL은 env로만. 코드에 하드코딩 없음.

---

## 4. 배포 순서 & 검증 체크리스트

도메인이 서로를 참조하는 순환(web↔worker)이 있으니 아래 순서로 끊는다.

1. **worker 먼저 배포**(Railway). `WORKER_SECRET`·`DATABASE_URL` 등 [1-3] 채운다. `CORS_ORIGIN`은 예상 web 오리진을 **잠정 실값**으로 입력(부팅 게이트가 `*`/빈값을 거부 — 0-1). → worker 도메인 획득.
   - [ ] `curl https://<worker-domain>/health` → `{"ok":true,...}` (부팅 실패면 로그에서 누락 env 확인)
2. **web 배포**(Vercel). [2-2] env 채움:
   - `NEXT_PUBLIC_STREAM_URL` = `https://<worker-domain>/stream`
   - `WORKER_SNAPSHOT_URL` = `https://<worker-domain>/snapshot`
   - `BETTER_AUTH_URL` = web 오리진, `WORKER_SECRET` = worker와 동일
   - → web 도메인 획득. (이 env는 빌드 전 존재해야 하므로 첫 배포 전 입력)
3. **worker로 돌아가 `CORS_ORIGIN` = web 오리진 입력 → Railway 재배포.**
4. **OAuth 콜백 URI 등록**([2-3])하고 Google/GitHub 시크릿 입력 후 web 재배포(소셜 로그인 쓸 경우).

### 검증

- [ ] **worker health**: `curl https://<worker-domain>/health` → 200 + `ok:true`.
- [ ] **snapshot 인증**: `curl https://<worker-domain>/snapshot?symbols=US:AAPL`
      → `WORKER_SECRET` 설정 시 헤더 없으면 `401`, `-H "x-worker-secret: <값>"` 있으면 JSON. (401이 나와야 인증이 살아있는 것)
- [ ] **CORS**: 브라우저에서 web 접속 → DevTools Network에서 `/stream`(worker 도메인) EventStream 연결 200, CORS 에러 없음.
- [ ] **SSE 실데이터**: 차트/시세가 mock 값으로라도 갱신되면 `NEXT_PUBLIC_STREAM_URL` 배선 정상. 갱신 없으면 web이 `/api/stream` mock 폴백 중 → env 확인 후 web 재빌드.
- [ ] **로그인 라운드트립**: 게스트 로그인 → 새로고침 세션 유지(`BETTER_AUTH_SECRET`·`DATABASE_URL` OK). 소셜은 콜백 URI 일치 확인.
- [ ] **주문 라운드트립**: 시장가 주문 1건 → 체결 or 명확한 거부 사유. "스냅샷 없음"류 거부면 `WORKER_SNAPSHOT_URL`/`WORKER_SECRET` 배선 확인.
- [ ] **크론 로그**: Railway 로그에서 크론 등록/발사가 KST 기준인지 확인(Discord 웹훅 설정 시 통지 수신).

---

## 부록 — 이 런북에서 다루지 않은 것

- **fail-closed 부팅 게이트 + 무조건 인증**: **코드로 강제됨**(0-1). 프로덕션에서 `WORKER_SECRET`·`CORS_ORIGIN` 미설정 시 부팅 실패, `/internal/orders/sync`는 시크릿 없으면 무조건 401.
- **실시세 연동**(`FEED_*`=kis/finnhub + 키): 키 발급 후 worker env만 교체. web 무관.
- **fx.ts 서드파티 엔드포인트**(koreaexim.go.kr, frankfurter.app): 벤더 고정 URL이라 env화 안 함. 하드코딩 금지 원칙상 상수화 여지는 있으나 배포 차단 아님.
- **`.env.example`**: web/worker 양쪽 모두 소비 변수 100% 문서화됨. 로컬 개발용 템플릿이며 실값은 `.env`(gitignore)에만.
