# 멀티 타임프레임 v2 — 전체 분봉(1·5·10·15·30·60) + 일·주·월봉 + 축 표시

- 상태: **v2 확정** (2026-07-11) — v1 → 적대 패널 10건·Codex 8건 반영. 기각 1건(B13 web 적용 주장 — 규칙은 `paths: worker/**` 스코프, web은 기존에도 상시 Neon 읽기).
- 선행: `2026-07-07-multi-timeframe-charts-design.md`(P1·P2·P3-① 완료 상태에서 확장)
- 결정: US 과거 캔들 = **Alpaca Basic**(승윤 확정). KR = KIS REST. 60분봉 버킷 = **정시(top-of-hour) 관례**(TradingView 기본·Alpaca 네이티브 정합 — US 첫 봉은 09:30~10:00 스텁, 세션앵커 대비 코드 0줄, 확정 결정).
- 관련: ADR-0003, `.claude/rules/db.md`·`worker.md`, PRD §5.1

## 목표

종목 상세 차트 타임프레임 토글 **1·5·10·15·30·60분 / 일 / 주 / 월** + x축 시간·날짜, y축 가격 라벨(토스증권 스타일). 리플레이에 **월봉** 추가. 빈 차트 구간은 외부 소스로 백필.

## 데이터 소스 매트릭스

| 타임프레임 | KR | US |
| --- | --- | --- |
| 1분 (최근) | 자체 `minute_candles`(장중 축적, 30일) | 동일 |
| 1분 (과거) | KIS 일별분봉 `FHKST03010230` — 1년, 120건/콜 | Alpaca `1Min` — 수년, 10k건/페이지 |
| 5~60분 | 1분 롤업(자체+백필) — **깊은 과거는 콜 예산 내 부분 제공** | Alpaca 네이티브 `{N}Min`(1콜) |
| 일 | KIS 기간별시세 `FHKST03010100` D — 100건/콜 | Alpaca `1Day` |
| 주·월 | 일봉 롤업(shared 순수함수) | 동일 |

- 라이선스(정직): KIS 개인키 시세 앱 표출은 약관 그레이존 — 기존 실시간 WS→SSE 중계와 동일 범주(ADR-0003 런타임 중계 유지와 일관). repo 커밋 금지 유지. Alpaca 무료 표출 권리 명문 미확인(UNCONFIRMED) — 포트폴리오 용도 감수, 상용화 시 재검토.

## 아키텍처

**키·외부호출은 전부 worker**(B6/B14). **web은 DB만 읽는다.** worker 백필 라우트는 **DB 무접촉**(외부 API+인메모리 캐시만 — B13 무관 확인이 아니라 아예 안 만짐).

```
브라우저 ─ /api/candles?tf=… ─▶ web(DB: daily_candles + minute_candles 롤업 + 당일 봉 합성)
                                  │ (요청 범위 중 DB가 못 채우는 과거 구간만)
                                  └ server-to-server ─▶ worker /candles/backfill (x-worker-secret)
                                                         ├ KIS REST (KR) · Alpaca REST (US)
                                                         └ 인메모리 TTL 캐시 + 콜 예산
```

### 백필 정책 (패널 BLOCKER #1 해소)
- **serve-through + 캐시 누적**: worker는 외부에서 받아 응답으로 흘리고 TTL 캐시에 누적. DB 영속 없음(38심볼×1년 분봉 ≈ 350만행 회피).
- **요청당 외부 콜 예산**: KIS `KIS_BACKFILL_CALL_BUDGET`(기본 10콜 ≈ 1200분봉 ≈ 1~2s), Alpaca는 tf 네이티브 1~2콜. 예산 소진 시 **부분 응답**(가진 만큼, 오래된 쪽 절단) — web은 받은 만큼 병합(짧은 히스토리 강등, 재방문 시 캐시 누적으로 점진 연장.
- **타임아웃 분리**: web→worker 백필은 `BACKFILL_TIMEOUT_MS`(기본 8000) — snapshot의 2.5s와 별개 env.
- **정직한 한계(명시)**: KR 60분봉 딥 히스토리(수개월)는 이 구조로 불가 — KR 분봉 백필은 최근 수영업일 보강용. 깊은 KR 분봉은 자체 축적이 자라며 해결(컷라인 ②와 일관).

### KIS REST (패널 #3·Codex d 해소)
- `tokenP` **REST 토큰 매니저 신규**(WS approval_key와 완전 분리): 24h 캐시 + 재발급 1분 스로틀(EGW00133) + 401 시 1회 갱신 재시도. WS 세션과 상호작용 없음(별도 자격 경로) — 배치 B가 소유, "기존 재사용" 전제 없음.
- **도메인 분리 env**: `KIS_REST_BASE`(기본 실전 `https://openapi.koreainvestment.com:9443`) — 현 WS는 VTS 도메인이므로 시세성 TR의 VTS 미지원 가능성 대응. 키는 `KIS_APP_KEY/SECRET` 재사용, TR 미지원·인증 실패 시 **KR 백필 비활성(빈 배열 + 1회 Discord 경고)**.
- 레이트: `KIS_REST_RPS`(기본 5) 토큰버킷 — 신규 고객 한도 공지(2026-03-20, 원문 미확인) 보수 대응.

### `daily_candles` (Codex b·패널 #5 해소)
- `daily_candles(market, symbol, date date, o,h,l,c numeric(18,2), v numeric(20,0), PK(market,symbol,date))`.
- **`date` = 거래소 로컬 거래일**(KR=KST, US=ET). 당일 봉 합성 시 "오늘" 판정도 시장 tz로(US 세션은 KST 이틀에 걸침 — KST date 사용 금지).
- worker 크론 upsert: KR 15:40 기존 슬롯 편승, US 마감 후 슬롯(기존 스냅샷 크론 시간대 준용). `noOverlap`.
- **부팅 백필 체크(심볼별)**: boot 시 심볼별 `max(date)` 조회 → 부족분 백필(기본 `DAILY_BACKFILL_DAYS=730`). 전량 백필 ≈ KIS 190콜 + Alpaca 48콜, 1분 내(부팅 스윕 관용구, cron.ts 기존 패턴). 키 부재 + 테이블 빈 상태면 **Discord 1회 통지**(조용한 영구 공백 방지).

### 당일 봉 합성 — 알려진 한계(패널 #7·#8, 명시 채택)
- 워커 재시작 후 축적 재개 시점부터의 o/h/l — 재시작 이전 고저 유실, 다음날 크론 upsert로 자기수정. 재론 금지.
- 합성 봉 `v = 0` 고정(분봉 v는 틱 카운트라 벤더 주수와 단위 불일치 — 볼륨 팬 미구현이라 무해, 장래 함정 차단).
- 당일 분봉 자체가 없으면 당일 봉 생략(정직한 공백).

## /api/candles 응답 계약 (배치 A 산출물 — C·D는 이것만 본다)

- `GET /api/candles?market&symbol&tf` (`tf`: `1m|5m|10m|15m|30m|60m|day|week|month`, 기본 `1m` 하위호환).
- 분봉 tf → `IntradayCandle[]`(time=epoch 초, 오름차순). 일·주·월 → `DailyCandle[]`(date=`YYYY-MM-DD` 거래소 로컬, 오름차순). 클라이언트는 요청 tf로 분기(별도 판별자 불요). lightweight-charts `Time`은 date 문자열 허용 — epoch 변환 금지.
- **per-tf 캡·룩백**(shared 상수 `CANDLE_LIMITS`): 분봉 tf 캔들 캡 240 — **1분 로우 조회 한도 = 240×분수**(예: 60m→14,400 로우. 현행 `MAX_CANDLES=240` 로우 캡을 롤업 전에 적용하면 60m가 4개가 되는 함정 — 금지). day 룩백 기본 730일(캡 750), week/month는 day에서 파생(캡 없음—이미 ≤750).
- 에러: 시장·심볼·tf 검증 400(DB 미설정보다 우선), DB 미설정 빈 배열(기존). day·week·month 응답 `Cache-Control: s-maxage=300`(하루 1회 갱신 데이터).

## 구현 배치 (A 단독 → 게이트 → B·C·D 병렬, 파일 서로소)

### A. shared 계약 (먼저, 단독)
- `shared/src/candles.ts`: `aggregateIntraday(candles, minutes)`(epoch floor 버킷, 정시 관례), `aggregateDailyToMonthly(daily)`(YYYY-MM 그룹), `type ChartTimeframe` + `TF_MINUTES` 매핑 + `CANDLE_LIMITS` 상수.
- `shared/src/schema.ts`: `daily_candles`(위 정의) + 마이그레이션.
- 테스트: 롤업 경계(버킷 첫/끝), 월 경계(연말), KR 09:00 정렬, US 09:30 스텁 봉 존재(정시 관례 검증), 빈 입력.

### B. worker 수급 (배치 2)
- `worker/src/candles/kisRest.ts`: tokenP 매니저 + `FHKST03010100`(D)·`FHKST03010230`(1분) 클라이언트, `KIS_REST_RPS` 토큰버킷, 수정주가 `FID_ORG_ADJ_PRC=0`.
- `worker/src/candles/alpaca.ts`: `/v2/stocks/{symbol}/bars`(feed=iex, end 15분 전 클램프, `1Min|5Min|…|1Day` 매핑).
- `worker/src/candles/backfillRoute.ts`: `GET /candles/backfill?market&symbol&tf&from&to` — secret 검증, 유니버스 밖 400, TTL 캐시(분봉 `tf초×60`, 일봉 1h — shared/env 상수), 콜 예산, **DB 무접촉**. 키 부재 시 빈 배열 200.
- `worker/src/cron.ts`: daily_candles 동기화(기존 슬롯 편승, noOverlap) + 부팅 심볼별 백필 체크 + Discord 통지.
- `worker/src/index.ts` 배선, `.env.example`: `ALPACA_API_KEY_ID`·`ALPACA_API_SECRET_KEY`·`KIS_REST_BASE`·`KIS_REST_RPS`·`KIS_BACKFILL_CALL_BUDGET`·`DAILY_BACKFILL_DAYS`. (`BACKFILL_TIMEOUT_MS`는 web→worker 타임아웃이라 web/.env.example 소속.)

### C. web API·훅 (배치 2)
- `web/src/app/api/candles/route.ts`: `tf` 파라미터, 계약(위) 구현. 분봉: minute_candles(로우 한도 = 캔들캡×분수)→`aggregateIntraday`, 부족 과거 구간만 worker 백필(전용 타임아웃, 실패 무시=강등). day: daily_candles + 당일 봉 합성(시장 tz). week/month: day 롤업.
- `web/src/lib/market/workerClient.ts`: 백필 호출 함수 추가(스냅샷 관용구 + `BACKFILL_TIMEOUT_MS`).
- `web/src/lib/market/useCandles.ts`: 버킷 분수 파라미터화, 라이브 틱을 현재 tf 버킷에 집계, 백필 병합. 일·주·월은 1회 fetch + 당일 봉만 라이브 갱신.

### D. web UI (배치 2)
- `stock-detail.tsx`: 토글 `라인 · 분▾(1·5·10·15·30·60) · 일 · 주 · 월` — 기존 `dropdown-menu.tsx` 재사용(확인됨), 5칸 상단 행(모바일 오버플로 없음 확인).
- `PriceChart.tsx`: **`timeframe` prop 신설** — 분봉 tf에서 `timeScale.timeVisible: true`(+`secondsVisible: false`), 일 이상 false; `localization.locale: "ko-KR"` + 가격 포매터(KRW 정수·USD 2자리, format.ts 재사용); tf 카테고리(분↔일) 전환 시 시리즈 재생성(Time 타입 혼합 금지 — 생성 effect deps에 tf 카테고리 포함).
- `replay-player.tsx`: `월` 토글(`aggregateDailyToMonthly`, 커서 슬라이스 — 미래 누설 금지).

## 검증 게이트

1. shared 테스트(경계·정렬·스텁 봉·미래 누설) + `npm run typecheck` + `npm run test` 그린.
2. 브라우저 실화면: 005930·AAPL에서 분봉 tf 전환, 일·주·월(백필 포함), x축 시간(분봉)/날짜(일+) 라벨, y축 통화 포맷, 리플레이 월봉. 스크린샷.
3. 키 없는 로컬 mock: 전 tf 500 없음, 빈 상태 UI("데이터 준비 중" 문구) 표시.
4. 구현 후 이중 적대리뷰(패널+Codex) → 확정 지적만 반영.

## 컷라인 (지연 시 절삭 순서)

① KR 과거 분봉 백필(FHKST03010230) → ② US 분봉 Alpaca 백필 → ③ 리플레이 월봉.
**절삭 불가**: 토글 UI + 자체 축적 롤업 + 일·주·월(daily_candles) + 축 라벨(핵심 요구).

## 리스크 잔여

- FHKST03010230/FHKST03010100의 실전 도메인 정상 동작은 구현 중 실호출로 확인(실패 시 KR 백필 비활성 fail-soft 경로가 안전망).
- Alpaca iex 피드 저유동 종목 분봉 공백 — 합성 금지, 정직한 갭.
