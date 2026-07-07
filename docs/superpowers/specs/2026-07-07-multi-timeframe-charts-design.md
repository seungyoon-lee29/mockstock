# 멀티 타임프레임 차트 (실시간 분봉 · 리플레이 주봉 · 분봉 축적 파이프라인)

- 상태: 승인 (2026-07-07)
- 범위: P1(실시간 분봉) + P2(리플레이 주봉) + P3-①(분봉 수집·저장 파이프라인)
- 관련: ADR-0003(KR 데이터 소스), `.claude/rules/db.md`, `.claude/rules/worker.md`, PRD §5.3

## 배경·정직한 스코프 경계

리플레이는 과거 일봉 정적 JSON을 배속 재생한다(`replay-player.tsx`). 실시간 종목 상세는 SSE 틱을
라인 차트로 누적한다(`stock-detail.tsx`). 둘 다 분봉/주봉 토글이 없다.

**핵심 제약**: 분봉 과거 데이터는 우리 합법 소스(금융위 일봉·Stooq 일봉)로 구할 수 없다(ADR-0003).
유일한 길은 **라이브 틱을 지금부터 분봉으로 집계·축적**하는 것. 따라서 P3는:
- **P3-① 수집·저장 파이프라인** — 오늘부터 빌드·검증 가능. **이번 범위.**
- **P3-② 분봉 리플레이 시나리오 UX** — 데이터가 실제로 쌓인 뒤라야 의미/검증 가능. **후속.**

없는 데이터로 UX를 만드는 것은 검증 불가이므로 P3-②는 명시적으로 후속으로 뺀다.

## 아키텍처 — 컴포넌트 & 파일 소유권(병렬 구현 충돌 방지)

의존 루트 A가 인터페이스 계약을 확정한 뒤 B·C·D가 **서로소 파일 집합**을 병렬로 구현한다.

### A. 공용 계약 (먼저, 단독)
- `shared/src/candles.ts`(신규) — 순수 집계 단일 소스(워커 영속화 + 클라 표시 공용):
  - 타입 `DailyCandle = { date: string; o,h,l,c,v: number }`(웹 `replay.ts`의 `Candle`을 여기로 승격),
    `IntradayCandle = { time: number /* epoch sec, 분 버킷 시작 */; o,h,l,c,v: number }`.
  - `aggregateDailyToWeekly(daily: DailyCandle[]): DailyCandle[]` — ISO주 그룹, o=첫날·h=max·l=min·c=마지막·v=Σ.
  - `class MinuteAggregator` — `add(tick: Tick): IntradayCandle | null`(분 롤오버 시 완성 캔들 반환) · `flush(): IntradayCandle | null`.
  - 자체검증 테스트(`candles.test.ts`): 주봉 집계 경계·분 버킷 롤오버 정확성.
- `shared/src/schema.ts` — `minute_candles` 테이블:
  `(market marketEnum, symbol text, ts timestamptz /* 분 시작 */, o,h,l,c numeric(18,2), v numeric(20,0), PK(market,symbol,ts))`. 금액 numeric(float 금지, db.md).
- `shared/src/index.ts` 배럴 export + drizzle 마이그레이션 생성.
- **발행 계약**(B·C·D가 의존): `DailyCandle`·`IntradayCandle`·`aggregateDailyToWeekly`·`MinuteAggregator`·`minute_candles`.

### B. 워커 수집 파이프라인 — `worker/`
- `worker/src/aggregator.ts`(신규): `MinuteAggregator`(shared) 사용. 시장시간 게이트(`@mockstock/shared/calendar` isMarketOpen) 통과 틱만. 완성 분봉을 DB 배치 flush(`onConflictDoNothing`), **장중에만 write**(Neon autosuspend 보존, B13). mock 틱 제외(B4).
- `worker/src/index.ts`: 틱 콜백에 aggregator 탭 배선(`book.set(tick)`와 나란히).
- `worker/src/cron.ts`: 보존 크론 추가 — `minute_candles` N일(기본 30, env) 초과 prune, Asia/Seoul, Discord 통지.

### C. 실시간 분봉 — `web/`(종목 상세)
- `web/src/lib/market/useCandles.ts`(신규): SSE 틱을 `MinuteAggregator`로 클라 버킷팅 → `IntradayCandle[]`.
- `web/src/app/api/candles/route.ts`(신규): `minute_candles` 조회(market·symbol·from·to). 실시간 백필/후속 사용.
- `web/src/app/stock/[market]/[symbol]/stock-detail.tsx`: **라인 / 1분 토글**. 1분은 백필(`/api/candles`) + 라이브 버킷 병합, `PriceChart type="candlestick"`.

### D. 리플레이 주봉 — `web/`(리플레이)
- `web/src/lib/replay.ts`: `Candle`을 `DailyCandle`(shared) 재export로 정합. 주봉은 shared `aggregateDailyToWeekly`.
- `web/src/app/replay/[symbol]/replay-player.tsx`: **일 / 주 토글**. 커서까지(`candles.slice(0,end)`) 집계 — **미래 누설 금지 유지**.

**공통**: 상승 빨강/하락 파랑, UI 한국어, `PriceChart`(candlestick 지원) 재사용(신규 차트 컴포넌트 금지, ui.md).
`PriceChart`의 `Time`은 date 문자열(일/주)·UTCTimestamp 초(분) 모두 허용.

## 오케스트레이션

1. **구현**: A 단독 → typecheck 게이트 → B·C·D 병렬(서로소 파일).
2. **이중 적대리뷰(병렬)**: 서브에이전트 리뷰 패널(정합성·회계/단위·Neon보존 B13·미래누설·시장시간 게이트) **+ Codex**(`codex:rescue`·`codex:adversarial-review`).
3. **종합→수정**: 두 리뷰 교차검증, 확정 지적만 수정 반영. `npm run typecheck` 통과 게이트.

## 검증

- shared 순수함수 자체검증 테스트(주봉 경계·분 버킷).
- `npm run typecheck`(shared+worker) 통과.
- 미래 누설 금지: 리플레이 주봉도 커서 이후 캔들 미포함(테스트).
