# ADR 0004 — US·KR 리그 분리 (리그 ≡ 시장, 네이티브 통화 지갑 2개, fxRate 제거)

- 상태: 채택 (2026-07-09)
- 맥락: 기존 설계는 US·KR를 **하나의 시즌·하나의 KRW 지갑**으로 묶고 US 체결 시 `fxRate`로 KRW 환산 정산했다. 5렌즈 적대적 설계 리뷰에서 세 가지 BLOCKER가 드러났다:
  1. "the active season" 조회가 전반에 걸쳐 **단일 로우를 가정**해 두 시즌 공존 시 US 주문이 KR 시즌에 섞이거나 반대가 됨.
  2. 멱등키가 `UNIQUE(user_id, key)`라 **리그 간 키 충돌**(같은 키를 US·KR에 쓰면 한쪽이 원본으로 재생)이 가능.
  3. US 정규장은 금 16:00 ET(≈토 05:00 KST)에 마감하는데 시즌 경계가 금 15:30 KST라 **US 금요일 장 움직임이 정산에서 통째 누락**.
- 관련: ADR-0003 (KR 리플레이 일봉 데이터 소스), `docs/superpowers/specs/2026-07-09-us-kr-league-separation-design.md`

## 결정

**리그 ≡ 시장(1:1)** — US·KR 리그를 분리해 유저가 두 리그를 각각 **네이티브 통화 지갑**으로 동시 플레이한다.

- **시드**: US = USD $10,000 / KR = KRW ₩10,000,000. `seasons.seedMoney`(리그 row에 내장)가 진실.
- **네이티브 지갑**: `accounts.cash`·`positions.costBasis`·`orders.reserved`·`portfolioSnapshots.totalValue`는 전부 리그별 네이티브 통화. 통화는 `season.market`이 함의하므로 별도 컬럼 불필요.
- **리그별 시즌 경계**: KR = 월 00:00 → 금 15:30 KST. US = 월 → 금 16:00 America/New_York(DST 자동, `Intl.DateTimeFormat shortOffset`으로 파싱 — 절대시각 하드코딩 금지).
- **시즌 id**: `season_<startsAt.toISOString()>:<market>` (예: `season_2026-07-06T15:00:00.000Z:KR`). `market`이 id에 인코딩돼 단일 트랜잭션 `onConflictDoNothing`으로 멱등 생성.
- **멱등키 스코프**: `UNIQUE(user_id, season_id, idempotency_key)`. `season_id`가 market을 인코딩하므로 리그 간 키 충돌 차단(BLOCKER 해결).
- **fxRate 제거**: 게임 로직에서 `fxRate`·`fx_rates` 테이블·주문의 `fxRate` 컬럼을 완전 삭제. 회계 불변식 `Σ realizedPnl ≡ 현금 증감`이 리그별·단일 통화로 단순하게 성립.
- **크론 리그별 분리**: KR 확정 = 금 15:35~16:05 KST 마감창 스윕 / US 확정 = 토 05:05~06:05 KST 마감창 스윕. 리셋 = KR 월 08:30 / US 월 22:00 KST. 상시 5분 스윕 폐지(Neon autosuspend B13).
- **스냅샷**: KR = 월~금 15:40 KST / US = 화~토 06:10 KST.

## 대안과 기각

- **(기각) 단일 시즌 유지(KRW 환산)**: 구현 복잡도는 낮지만 위 세 BLOCKER를 해결하지 못한다. 특히 "단일 로우 가정"은 API·크론 전반의 조회 오염을 일으키므로 패치가 아닌 구조 수정이 필요하다.
- **(기각) 통화 환산 유지(fxRate)**: 환차손익이 `Σ realizedPnl ≡ 현금 증감` 불변식을 교란하고, 환율 갱신 크론·`fx_rates` 테이블·fillOrder 내 환산 로직이라는 추가 복잡도를 요구한다. 게임 목적상 환차손익은 게임성 기여보다 혼란이 크다.
- **(기각) "양쪽 동일 금 15:30 KST 경계"**: US 금요일 장 움직임이 누락된다는 BLOCKER를 해결하지 못한다.

## 영향

- `shared/src/schema.ts`: `accounts.cash`·`positions.costBasis`·`orders.reserved`·`portfolioSnapshots.totalValue`로 rename, `orders.fxRate` DROP, 멱등 unique `UNIQUE(user_id, season_id, idempotency_key)`, `fx_rates` 테이블 DROP.
- `shared/src/seasons.ts`: `weeklyPeriod`·`ensureActiveSeason`·`resetSeason` 전부 `market` 파라미터 인지.
- `worker/src/cron.ts`: 리그별 마감창 스윕·스냅샷·리셋 크론 분리, fx 크론 제거.
- `.claude/rules/db.md`·`.claude/rules/worker.md`: 이 결정에 맞게 갱신.
