---
paths:
  - "shared/src/schema.ts"
  - "shared/src/fillOrder.ts"
  - "web/src/**/orders/**"
  - "web/src/**/*order*"
  - "**/drizzle/**"
---

# DB·정산 규칙 (적대적 리뷰에서 확정된 불변식)

- **금액은 전부 `numeric`. float 금지.** 스키마에 `CHECK (cash_krw >= 0)`, `CHECK (qty >= 0)`를 최후 방어선으로 건다(B12).
- **체결은 `shared/fillOrder()` 단일 함수로만.** web(시장가)·worker(지정가)가 같은 함수를 호출한다(B9). 체결 로직을 두 벌 만들지 말 것.
- **정확히-한-번(B10)**: fillOrder 첫 문장은 CAS — `UPDATE orders SET status='filled' … WHERE id=$1 AND status='open'`. 영향 행 0이면 이후 전부 스킵. 현금 차감도 `SET cash_krw = cash_krw - $x WHERE cash_krw >= $x` 조건부 원자 UPDATE.
- **회계 불변식(B12)**: `avgCost` = KRW 환산 원가(체결가 × fxRate), `realizedPnl` += (매도가 × 매도fxRate − avgCost) × qty(환차손익 포함). **Σ realizedPnl ≡ 현금 증감**이 항상 성립해야 한다.
- **환율(B8)**: 주문에 접수/체결 시점 `fxRate`를 고정 기록. 실시간 환율 금지(일 1회 갱신, 빈 응답 시 직전 값).
- 클라이언트가 보낸 가격은 절대 신뢰하지 않는다 — 체결가는 워커 스냅샷/매칭 도달가만.

## 2차 리뷰 반영 (6렌즈 32건 — 2026-07-05)

- **상태 전이는 전부 CAS + RETURNING**: fill·cancel·expire 모두 `UPDATE orders SET status=… WHERE id=$1 AND status='open' RETURNING reserved_krw`. 환불·정산은 **RETURNING으로 돌아온 행에서만** 계산한다(별도 재조회 금지 — 경합 창 제거). 예약→체결→환불 전 과정이 **단일 트랜잭션·멱등**.
- **신뢰 경계**: 서버가 정하는 값은 클라이언트에서 받지 않는다 — 체결가(워커 스냅샷/매칭 도달가), `userId`(세션에서만), `seasonId`(서버가 active 시즌 결정). **클라이언트 입력은 `market`·`symbol`·`side`·`qty`·`limitPrice`·`idempotencyKey` 6개뿐.**
- **멱등키**: `idempotencyKey`는 `UNIQUE(user_id, key)`. 중복 접수는 에러가 아니라 **원본 결과를 그대로 반환**(멱등 재생) — 재시도·더블클릭이 이중 체결로 이어지지 않는다.
- **40% 상한 재검증**: 종목당 매수 40% 상한(A1)은 접수 시 1차 검사 + **체결 트랜잭션 내부에서 `SELECT … FOR UPDATE`로 재검증**. 접수와 체결 사이 포지션 변화로 상한이 뚫리는 것을 막는다.
- **positions는 총 취득원가 `costBasisKrw`**: 주당 평단(avgCost)을 **저장하지 않는다** — 주당 값은 라운딩이 누적돼 `Σ realizedPnl ≡ 현금 증감` 불변식을 깬다. 저장은 총 취득원가, §6.5의 `avgCost`는 `costBasisKrw / qty`로 파생.
