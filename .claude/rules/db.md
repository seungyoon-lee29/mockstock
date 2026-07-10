---
paths:
  - "shared/src/schema.ts"
  - "shared/src/fillOrder.ts"
  - "web/src/**/orders/**"
  - "web/src/**/*order*"
  - "**/drizzle/**"
---

# DB·정산 규칙 (적대적 리뷰에서 확정된 불변식)

- **금액은 전부 `numeric`. float 금지.** 스키마에 `CHECK (cash >= 0)`, `CHECK (qty >= 0)`를 최후 방어선으로 건다(B12).
- **체결은 `shared/fillOrder()` 단일 함수로만.** web(시장가)·worker(지정가)가 같은 함수를 호출한다(B9). 체결 로직을 두 벌 만들지 말 것.
- **정확히-한-번(B10)**: fillOrder 첫 문장은 CAS — `UPDATE orders SET status='filled' … WHERE id=$1 AND status='open'`. 영향 행 0이면 이후 전부 스킵. 현금 차감도 `SET cash = cash - $x WHERE cash >= $x` 조건부 원자 UPDATE.
- **리그별 회계 불변식(B12)**: `cash + Σ costBasis ≡ seed + Σ realizedPnl`(네이티브 통화, US·KR 각각). 교차 통화 항 없음 — fxRate 불필요. `costBasis`는 총 취득원가(네이티브), `realizedPnl`은 네이티브 손익. 주당 평단은 `costBasis / qty`로 파생.
- 클라이언트가 보낸 가격은 절대 신뢰하지 않는다 — 체결가는 워커 스냅샷/매칭 도달가만.

## 2차 리뷰 반영 (6렌즈 32건 — 2026-07-05)

- **상태 전이는 전부 CAS + RETURNING**: fill·cancel·expire 모두 `UPDATE orders SET status=… WHERE id=$1 AND status='open' RETURNING reserved`. 환불·정산은 **RETURNING으로 돌아온 행에서만** 계산한다(별도 재조회 금지 — 경합 창 제거). 예약→체결→환불 전 과정이 **단일 트랜잭션·멱등**.
- **신뢰 경계**: 서버가 정하는 값은 클라이언트에서 받지 않는다 — 체결가(워커 스냅샷/매칭 도달가), `userId`(세션에서만), `seasonId`(서버가 주문 market으로 도출한 active 시즌). **클라이언트 입력은 `market`·`symbol`·`side`·`qty`·`limitPrice`·`idempotencyKey` 6개뿐.**
- **멱등키 스코프**: `UNIQUE(user_id, season_id, idempotency_key)`. `season_id`가 market을 인코딩하므로 리그 간 키 충돌 차단(ADR-0004). 중복 접수는 에러가 아니라 **원본 결과를 그대로 반환**(멱등 재생) — 재시도·더블클릭이 이중 체결로 이어지지 않는다.
- **40% 상한 재검증**: 종목당 매수 40% 상한(A1)은 접수 시 1차 검사 + **체결 트랜잭션 내부에서 `SELECT … FOR UPDATE`로 재검증**. 접수와 체결 사이 포지션 변화로 상한이 뚫리는 것을 막는다.
- **positions는 총 취득원가 `costBasis`**: 주당 평단을 **저장하지 않는다** — 주당 값은 라운딩이 누적돼 `Σ realizedPnl ≡ 현금 증감` 불변식을 깬다. 저장은 총 취득원가(네이티브), 평단은 `costBasis / qty`로 파생.

## 리그 분리 반영 (ADR-0004 — 2026-07-09)

- **리그 ≡ 시장(1:1)**: active 시즌이 KR·US 각 1개씩 항상 존재. "the active season" 단일 로우 가정 금지 — 모든 조회는 `market` 조건 필수.
- **컬럼명(현행 스키마 기준)**: `accounts.cash`(네이티브, 예약분 차감 후 순액), `positions.costBasis`(네이티브 총 취득원가), `orders.reserved`(네이티브 예약액), `portfolioSnapshots.totalValue`(네이티브 총자산). 통화는 `season.market`이 함의.
- **환율 항 폐기**: `fx_rates` 테이블·주문의 `fxRate` 컬럼·환율 크론은 제거됐다. US 체결은 USD로 네이티브 정산. 구 명칭(`cashKrw`·`costBasisKrw`·`reservedKrw`·`totalValueKrw`) 사용 금지.
