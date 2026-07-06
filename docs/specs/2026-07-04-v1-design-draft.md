# 모의 주식게임 v1 설계 초안 (적대적 리뷰 대상)

> 상태: DRAFT r3 — 2026-07-04. 기획 리뷰 4렌즈(16건 중 15건 반영, 부록 A) + 엔지니어링 리뷰 4렌즈(16건 전원 반영, 부록 B) + 도구 리서치 6종(부록 C) 완료. PRD 승격 준비 완료.
> 배경 문서: `docs/brainstorm/2026-07-03-기획-브레인스토밍.md`, `docs/brainstorm/2026-07-03-아키텍처-브레인스토밍.md`

## 확정된 결정 로그

| # | 결정 | 선택 |
| --- | --- | --- |
| 1 | 최우선 목표 | 취업용 포트폴리오 (풀스택 개발자 직군) |
| 2 | 핵심 컨셉 | 시즌 리그 + 리플레이 하이브리드. 토스 벤치마크 제거 |
| 3 | 시세 소스 | KIS(한국) + Finnhub(미국) 풀 실시간 연결 |
| 4 | 주문 유형 | v1에 지정가까지 포함 (워커 = 체결 엔진) |
| 5 | 현금 모델 | KRW 단일 지갑 + US 주문 시 자동환전 (체결 시점 환율 기록) |
| 6 | 시즌 | 주간 리셋 (월 개장 전 리셋 / 금 마감 후 확정) |
| 7 | 사용자 목표 | 데모 중심 + 친구 몇 명 (<20 동접, 확장 코드 금지, 봇 플레이어) |
| 8 | 리플레이 | 리그와 분리된 개인 훈련 모드, 성적은 프로필 기록만 |
| 9 | 인증 | Google + GitHub OAuth (Auth.js v5) + 게스트 둘러보기 |
| 10 | 브랜드 무드 | 웨불 네이비 (딥네이비 + 시안 #22D3EE), 상승빨강/하락파랑 기본 + 설정 토글 |
| 11 | 아키텍처 | web(Vercel) + worker(Railway ~$5/월) + Neon Postgres |

## ① 컨셉 — "매주 리셋되는 주식 배틀로얄 + 과거장 훈련소"

- **주간 시즌 리그**: 월요일 KR 개장 전 전원 가상 1,000만 원 리셋 → 실시간 시세로 매매 → 금요일 마감 때 수익률 랭킹 확정, 시즌 뱃지 영구 보존.
- **봇 플레이어 3~5개** (랜덤 / 모멘텀 / 인덱스 홀딩 전략) — 리더보드 공백 방지 + 체결 엔진 상시 자가 테스트.
- **리플레이 훈련소**: 과거 실제 차트(v1 시나리오 1개 — 2020 코로나 폭락)를 x1/x10/x30 배속 재생하며 매매. 리그와 분리, 성적은 프로필 기록만.
- **주말/장외 홈 스위칭**: 장 마감·주말엔 홈이 리플레이 중심으로 전환 → 24시간 죽지 않는 데모.
- 이름 후보: 스톡아레나 / 개미리그 / 불장 / 리셋리그 (미확정)

## ② 아키텍처

```
Finnhub WS(US) ─┐                       ┌─ SSE 직결 ──→ 브라우저
KIS WS(KR) ─────┤→ worker (Railway ~$5) │
                │   · 인메모리 시세북 · 1초 배치 팬아웃
                │   · 지정가 매칭 루프 · feed 추상화(real/mock/replay)
                │   └ GET /snapshot ←── 체결가 조회 ── web
브라우저 ── 주문/리그 REST ──→ web (Next.js 16, Vercel 무료) ──→ Neon Postgres (drizzle)
```

- 크론 4개: 월요일 시즌 리셋 / 금요일 랭킹 확정 / 일별 스냅샷·prevClose 갱신 / 환율 갱신
- `shared/` 타입 공유 (별도 패키지 없이 심플하게 시작)
- 기존 코드: `priceSource.ts`만 폐기(로직은 워커로 이식), `types/format/universe/mock/usePrices/컴포넌트` 전부 재사용. `app/api/stream`은 로컬 폴백으로 강등.

## ③ 주문·체결·현금

- **시장가**: web API가 워커 `/snapshot` 가격으로 즉시 체결. 클라이언트 가격 절대 신뢰 안 함. DB 트랜잭션(orders insert + positions upsert + 현금 차감) + 클라이언트 멱등키(unique).
- **지정가**: 접수 → `orders.status='open'` → 워커 매칭 루프가 가격 도달 시 체결. 장외 시간 접수 허용 → 개장 시 매칭. 모의라서 유동성 무한 가정(항상 전량 체결) 정책 명시.
- **현금**: KRW 단일 지갑. US 주문 시 자동환전 — 체결 시점 환율 `fxRate` 를 주문 레코드에 기록. 환율은 일 1회 갱신(실시간 아님). 금액은 전부 `numeric`, float 금지.

## ④ DB 스키마 초안 (10테이블)

```
users                id, name, email, image, isBot, createdAt (+ Auth.js adapter 테이블)
seasons              id, startsAt, endsAt, seedMoney, status
accounts             (userId, seasonId) PK, cashKrw numeric
positions            (userId, seasonId, market, symbol) PK, qty, avgCost, realizedPnl
orders               id, userId, seasonId, market, symbol, side, type(market/limit),
                     qty, limitPrice, filledPrice, fxRate, status, idempotencyKey UNIQUE, filledAt
season_results       (seasonId, userId) PK, rank, returnPct, finalValue
instruments          (market, symbol) PK, name, currency, prevClose, lastPrice, lastPriceAt
watchlist_items      (userId, market, symbol) PK
portfolio_snapshots  (userId, seasonId, date) PK, totalValueKrw
replay_sessions      id, userId, scenarioId, returnPct, mdd, finishedAt
```

## ⑤ 화면 & UI (v1)

- 홈(아레나): 내 순위 카드 + 실시간 리더보드 + 보유종목 + 시즌 카운트다운. 주말엔 리플레이 전환.
- 탐색: 유니버스 36종목(KR 18 + US 18) 등락 그리드 + 검색.
- 종목상세: 실시간가 + lightweight-charts 차트 + 호가(KIS) + 주문 패널(시장가/지정가).
- 주문함: 미체결/체결 내역, 미체결 취소.
- 리플레이: 시나리오 선택 → 배속 플레이 → 결과 리포트("실제 역사 vs 나").
- 프로필: 시즌 전적 아카이브, 리플레이 기록, 설정(상승/하락 색 토글).
- 무드: 웨불 네이비. 게스트 둘러보기 허용, 주문·리그 참여만 로그인 게이트.

## ⑥ 엣지케이스 정책

- 장 마감: 시장가 차단 + 시장상태 배지, 지정가는 접수 허용.
- 스트림 끊김: EventSource 자동 재연결 + "연결 끊김" 배지 + 마지막가 유지.
- 워커 재시작: 마지막가를 instruments에 주기 영속화.
- KIS 토큰: 24h 수명 캐시, 재발급 1분 스로틀, WS approval_key, PINGPONG 응답, 실시간 등록 41건 한도(체결가만 구독).
- 저유동성 종목: 마지막 체결가 + "체결 대기" 표시.

## ⑦ 일정 & 백로그

v1 ≈ 6주: ①DB+인증+시장가(mock) ②워커+Finnhub+SSE ③시즌 크론+리더보드+봇 ④지정가 매칭+KIS ⑤리플레이 ⑥폴리시·배포·문서.

v2 백로그: 프라이빗 친구 리그, 티어, MDD 서든데스, 호가창, 매매일지, 공유 카드, 시나리오 팩 추가.

선행 준비물(오너): KIS 계좌+앱키, Finnhub 키, Railway 계정.

---

## 부록 A — 기획 적대적 리뷰 반영 사항 (r2, 확정)

아래는 본문에 우선하는 확정 보완이다. 본문과 충돌 시 부록 A가 이긴다.

### 게임 규칙 보완
- **A1. 몰빵 방지**: 주문 서버 검증에 종목당 매수 상한(시드의 40%) 추가 — 최소 3종목 분산 강제. 금요일 랭킹 확정 시 동률 타이브레이커로 시즌 MDD(portfolio_snapshots 기반) 사용.
- **A2. 봇 = 공개 벤치마크**: 봇은 BOT 배지 + 전략명 공개(예: "인덱스봇"), 공식 순위·시즌 뱃지에서 제외(`WHERE isBot = false`), 리더보드에는 기준선으로 노출. 봇 매매 주기는 "3분 관전 중 순위 변동 ≥1회" 기준으로 튜닝(데모 요구사항).
- **A3. 시즌 중간 합류**: 첫 진입/주문 시점에 현 시즌 계좌 lazy upsert(시드 1,000만). 월요일 크론은 기존 계좌 리셋만 담당. 리더보드 즉시 등재 + "D+N 합류" 표기.
- **A4. 주말 챌린지**: 리플레이 시나리오에서 시드 고정 랜덤 2주 구간을 잘라 '이번 주말의 챌린지'로 제공(콘텐츠 비용 0). 리플레이 리더보드는 v2(결정 #8 유지 — 리플레이 성적은 개인 기록만).

### 주문·정합성 보완
- **A5. 지정가 현금 예약**: 접수 트랜잭션에서 예상 금액을 즉시 차감·예약(US는 접수 시점 fxRate 고정 기록), 취소 시 환불. 매수 패널에 '주문 가능 현금'(예약 차감 후) 표시, 부족 시 버튼 비활성.
- **A6. 현금 소진 상태 정의**: 현금·포지션 소진 시 홈 카드에 "다음 시즌 D-N + 리플레이 훈련소" 상태 노출.
- **A7. 장외 지정가 피드백**: 접수 시 "월 09:00 개장 후 체결 예정" 문구 + 주문함 open 강조(푸시 알림은 v2).

### 아키텍처·화면 보완
- **A8. 리더보드 데이터 경로 확정**: web API가 전 참가자 {포지션, 현금} 스냅샷을 단일 엔드포인트로 제공, 클라이언트가 구독 중인 SSE 가격(유니버스 36종목 전 구독)으로 전원 평가액을 로컬 재계산. 확장 코드 금지(<20 동접).
- **A9. 리플레이 = 클라이언트 로컬 재생**: 일봉 정적 JSON + 클라이언트 타이머 배속 + 로컬 체결 계산. 서버는 종료 시 replay_sessions insert 1회만. **워커 feed 추상화는 real/mock 2종으로 축소(replay 제거)**. 시나리오 데이터는 week 1에 확보해 리포지토리 커밋.
- **A10. 호가 UI 삭제**: §⑤ 종목상세의 "호가(KIS)"는 v1에서 제거(41건 한도 정책과 모순). v2 백로그로.
- **A11. 게스트 정책 확정**: 탐색·종목상세 전면 공개. 리플레이 플레이 완전 허용(결과 저장만 로그인 CTA, 게스트는 insert 생략). 게스트 홈 = 리더보드 전체 + '참가하기' CTA(내 순위 카드 자리). 주문 패널만 로그인 게이트.
- **A12. 온보딩 최소 3종**: OAuth 콜백 후 보던 페이지 복귀(callbackUrl), 첫 로그인 1회성 웰컴 모달("1,000만 원 지급·금요일 랭킹 확정" 2줄 + 탐색 CTA), 첫 체결 토스트→홈 유도.

### 일정·운영 보완
- **A13. 로드맵 재배열**: week 1에 프로덕션 스켈레톤 배포(web+worker SSE 헬로월드 직결 + OAuth 콜백) 후 상시 배포 유지. KIS 체결가 어댑터는 week 2에 Finnhub과 병행(앱키 발급은 week 0 게이트). 리플레이를 KIS 앞으로. week 4는 지정가 매칭 전용. week 6 = 문서·데모 리허설·버퍼 전용. §⑥ 엣지 정책은 해당 기능 주차에 흡수.
- **A14. 컷라인 규칙**: 일정 지연 시 절삭 순서 = 지정가 → KIS(KR은 mock 유지) → 봇 전략 다양화. **리플레이·리더보드는 절삭 불가.**
- **A15. 크론 검증 가능성**: 시즌 경계를 env 파라미터화(단축 시즌으로 풀사이클 반복 테스트). 시즌 확정 시각 = 금 15:30 KST 스냅샷, US 포지션은 그 시점 마지막가(목요 종가) 평가로 명시.
- **A16. 문서 상시화**: 주차 종료마다 결정 1~2개를 10줄 ADR로 기록(docs/adr/), week 2에 아키텍처 README 확정, docs/metrics.md에 SQL로 계산 가능한 지표 3개(첫 주문 도달률, 시즌 재참여율, 리플레이 완주율) 쿼리째 명시.

### 기각 기록
- 주말 리플레이 리더보드: 결정 #8(리플레이=개인 기록만)과 충돌 + 클라이언트 로컬 체결(A9)이라 성적 신뢰 불가 → v2에서 서버 검증과 함께 재검토.

---

## 부록 B — 엔지니어링 적대적 리뷰 반영 사항 (r3, 확정)

부록 A와 동급의 확정 보완. 본문·부록 A와 충돌 시 부록 B가 이긴다.

### 시세 파이프라인
- **B1. /snapshot 계약**: 응답 스키마 `{symbol, price, at, source}`. web 주문 API는 해당 시장 장중에 `now - at > 30초`면 체결 거부("시세 연결 복구 중" 안내). 워커는 부팅 시 instruments의 lastPrice/lastPriceAt으로 시세북 워밍 후 서빙 시작. web→worker 호출에 `WORKER_SECRET` 헤더(양쪽 env).
- **B2. SSE 프로토콜**: 연결(재연결 포함) 직후 워커가 `event: snapshot`으로 시세북 전체 1건 전송 → 이후 `event: ticks` 델타 배치. Last-Event-ID 리플레이 버퍼 불필요. 스트림은 비인증 공개 + `Access-Control-Allow-Origin` = web 오리진 고정 + 동시 연결 수 상한.
- **B3. 리더보드 payload**: `{userId, positions[], cashKrw, reservedKrw, fxRate}`. 평가액 = cashKrw + reservedKrw + Σ(qty × SSE가격 × 환율). reservedKrw는 open 주문 SUM 서브쿼리. 클라이언트 폴링 refetchInterval 15~30초.
- **B4. feed 시장별 조립**: env 2개 `FEED_KR=kis|mock`, `FEED_US=finnhub|mock`. 각 소스는 동일 Tick 시그니처(기존 types.ts 재사용) + `source` 필드. mock 틱은 instruments 영속화에서 제외, mock 시작가는 prevClose에서 시드.
- **B5. 시장 캘린더 모듈**: IANA tz(America/New_York, Asia/Seoul) 기반 세션 판정 + 휴장일 정적 JSON(연 1회 갱신). KST 절대시각 하드코딩 금지(US는 DST로 22:30/23:30 변동). 시장가 차단·지정가 매칭 루프·lastPrice 갱신 3곳 모두 이 판정기 경유. 정규장 외(프리/애프터마켓) 틱은 폐기.

### 체결·정산 정합성
- **B9. 체결 로직 단일화**: 워커가 `DATABASE_URL` 공유해 Neon에 직접 쓴다. 체결 트랜잭션은 `shared/`의 단일 함수 `fillOrder()`(상태 전이 + positions upsert + 현금 정산)로 만들고 web(시장가)·워커(지정가)가 공용. §② 다이어그램에 워커→Neon 화살표 추가.
- **B10. 정확히-한-번 체결**: fillOrder 첫 문장 = `UPDATE orders SET status='filled', ... WHERE id=$1 AND status='open'` (CAS). 영향 행 0이면 전체 스킵. 현금 차감도 `SET cashKrw = cashKrw - $x WHERE cashKrw >= $x` 조건부 원자 UPDATE. 매칭 루프는 인메모리 캐시를 진실로 삼지 않고 DB `status='open'` 주기 재조회.
- **B11. 시즌 경계 정합성**: 금 15:30 확정 크론은 ① open 주문 전량 `expired` + 예약 현금 환불 → ② finalValue 계산 순서. 매칭 루프 스캔에 `seasons.status='active'` 조인 조건. 확정~월요일 리셋 사이 신규 주문은 season.status 체크로 차단(A6 상태 카드 재사용). portfolio_snapshots.totalValueKrw는 예약 현금 포함으로 정의.
- **B12. 매도 정합성**: 지정가 매도 접수 검증 = 보유 qty − 해당 종목 open 매도 qty 합 ≥ 주문 qty. avgCost = KRW 환산 원가(체결가 × fxRate)로 저장. realizedPnl = (매도 체결가 × 매도 fxRate − avgCost) × qty — 환차손익 포함(Σ realizedPnl ≡ 현금 증감). 스키마에 `CHECK (qty >= 0)`, `CHECK (cashKrw >= 0)`.

### 외부 연동·운영
- **B6. KIS 키 운용**: 앱키 2개 체제 — 모의투자(VTS) 키 = 로컬/개발, 별도 키 = Railway 프로드 (모의 키는 최대 2개 발급 가능). `KIS_APP_KEY/SECRET`은 **워커 env에만 존재**(web 금지). 토큰 401 시 1회 재발급 후 재시도, WS 끊김 시 지수 백오프, 토큰 캐시(재발급 1분 스로틀 준수), PINGPONG 응답.
- **B7. 크론 전부 워커로**: Vercel Cron 미사용(Hobby 2개 한도 + 최대 1h 지터 + 실패 무감지). 워커 node-cron 4개: 월요일 리셋 / 금 15:30 확정 / prevClose 07:30 KST(instruments.prevCloseDate로 멱등) / 환율. 완료·실패 모두 Discord webhook 통지. 리셋은 멱등 + 시즌 row lazy 생성 폴백(크론이 죽어도 첫 요청이 복구).
- **B8. 환율 소스 확정**: 1순위 한국수출입은행 고시환율 API(무료 키) + 폴백 frankfurter. DB 단일 로우(rate, fetchedAt) 영속화. 빈 응답(주말·공휴일·11시 이전)이면 직전 값 유지, 48h 초과 시 UI 스테일 배지. fxRate 로우 부재 시에만 US 주문 차단.
- **B13. Neon 무료 티어 보존**: 워커의 DB 접근은 장중 한정 — 마지막가 영속화는 장중 60초 배치, open 주문은 인메모리 캐시(기동 시 1회 로드 + web이 접수/취소 시 워커에 push + 주기 재동기화, B10의 CAS가 안전망). 유휴 시 커넥션 해제로 autosuspend 보존 (24/7 연결 시 월 컴퓨트 한도 ~191h 소진 → 전면 정지 리스크).
- **B14. week 1 체크리스트 확장 + 모니터링**: CORS·`NEXT_PUBLIC_STREAM_URL` 배선, env 소유 매트릭스(web: AUTH_*/DATABASE_URL ↔ worker: KIS_*/FINNHUB_*/DATABASE_URL/WORKER_SECRET), 워커 `/health`(업스트림 WS 상태 + 시장별 마지막 틱 시각) + web `/api/health`(DB 연결 + 현재 시즌 존재), UptimeRobot 무료 2개 + Discord webhook. 전부 $0.

---

## 부록 C — 도구 리서치 확정 (근거는 리서치 로그 참고)

| 영역 | 확정 | 핵심 근거 |
| --- | --- | --- |
| 인증 | **Better Auth v1.6** (Auth.js v5 대신) | drizzleAdapter + google/github + **anonymous 플러그인이 게스트 모드와 정확히 일치** + nextCookies |
| DB | Neon Free + drizzle 0.45 | web은 `neon-serverless`(WebSocket Pool, 트랜잭션), 워커는 장중 한정 커넥션(B13) |
| 차트 | lightweight-charts v5.2 | React 래퍼 없이 useRef/useEffect 직접 마운트. 실시간 틱 + 배속 재생 모두 적합 |
| 워커 호스팅 | Railway Hobby $5 — **조건부** | ⚠️ **KIS가 해외 IP 차단 사례 확인**(리서처가 미국발 거부 직접 관측). Railway는 한국 리전 없음 → **week 0 스파이크: Railway(싱가포르)에서 KIS WS 접속 검증 필수. 실패 시 플랜 B = Oracle Cloud Free(서울) 또는 네이버클라우드** |
| KIS | 모의투자(VTS) 앱키 | 즉시 발급·무료·1년 유효(최대 2개). 모의도 실시간 WS 지원(체결가 H0STCNT0). 세션당 41건·앱키당 1세션. REST 모의 2건/초. 토큰 24h·재발급 1분 1회(EGW00133). approval_key 별도 |
| 리플레이 데이터 | KR = 공공데이터포털 금융위 주식시세정보 API, US = Stooq 일봉 CSV | KR은 이용허락 '제한 없음'이라 **리포 커밋 합법**. US는 사실 데이터 소량 + 출처 표기. 자체 스키마 `{date,o,h,l,c,v}` 정규화 JSON 커밋. yfinance·Alpha Vantage(약관 금지)·Finnhub 캔들(유료 전환) 기각 |
