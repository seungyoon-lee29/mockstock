---
paths:
  - "worker/**"
---

# 워커 규칙

- **자격증명 경계(B6/B14)**: `KIS_*` / `FINNHUB_*` 키는 워커 env에만 존재한다. web에 두지 말 것.
- **피드는 시장별 조립(B4)**: `FEED_KR`/`FEED_US` env로 mock↔실시세를 독립 스왑. 모든 피드는 동일 `Tick` 시그니처 + `source` 필드. mock 틱은 instruments 영속화에서 제외.
- **업스트림 WS는 시장당 단일 커넥션**. Finnhub 심볼 ~50 / KIS 세션당 41건 한도. 유저별 소켓 열지 말 것.
- **KIS 세션(B6)**: 토큰 24h 캐시 · 재발급 1분 스로틀(EGW00133) · approval_key 별도 · PINGPONG 응답 · 끊김 시 지수 백오프.
- **시장 판정은 `@mockstock/shared/calendar` 경유(B5)**. KST 절대시각 하드코딩 금지(US DST). 정규장 외 틱 폐기.
- **Neon 보존(B13)**: DB 접근은 장중 한정. 확정·스냅샷은 각 시장 마감 직후 좁은 시간창에서만(상시 5분 스윕 금지). 유휴 시 커넥션 해제로 autosuspend 유지.
- **크론은 워커 node-cron(B7)**. Vercel Cron 미사용. 완료·실패 모두 Discord 통지.

## 2차 리뷰 반영 (6렌즈 32건 — 2026-07-05)

- **크론 타임존 명시**: 모든 `cron.schedule(...)`에 `{ timezone: 'Asia/Seoul' }` 필수. 기본값은 서버 로컬시간이고 **Railway는 UTC**라, 누락 시 시즌 크론이 9시간 어긋난다.
- **DB는 `pg` Pool, 장 마감 시 해제**: 워커 DB 접근은 `node-postgres(pg)` 풀로. 장 마감·유휴 구간엔 풀을 닫아 **Neon autosuspend를 보존**(B13 재확인).
- **매칭 루프도 신선도 게이트**: 지정가 매칭 루프는 SSE와 동일하게 **30초 신선도 게이트**를 통과한 틱만 사용 — 스테일 심볼은 스킵(스테일가 체결 금지).
- **fail-closed 부팅**: 프로덕션에서 `WORKER_SECRET`·`CORS_ORIGIN` 부재 시 **부팅 실패**(경고 후 기동 금지). 시크릿·CORS 미설정 상태로 뜨지 않는다.
- **상태 변경 인입은 전부 인증**: 상태를 바꾸는 내부 엔드포인트(`POST /internal/orders/sync` 등)는 예외 없이 **`WORKER_SECRET` 필수**. 인증 없는 상태 변경 경로를 열지 않는다.
- **시즌 확정 = 리그별 마감창 스윕(ADR-0004)**: 상시 5분 스윕 폐지. 리그별 좁은 시간창에서만 스윕:
  - KR 확정: 금 15:35~16:05 KST(금 15:30 KST 마감 직후, `noOverlap`).
  - US 확정: 토 05:05~06:05 KST(≈금 16:00 ET 마감 직후, DST 여유, `noOverlap`).
  - 워커 재시작·다운타임엔 부팅 스윕이 밀린 시즌을 처리(멱등).
- **리셋 크론**: KR = 월 08:30 KST(KR 개장 전) / US = 월 22:00 KST(≈미 동부 월 09:00 여름 개장 전).
- **스냅샷 크론**: KR = 월~금 15:40 KST / US = 화~토 06:10 KST. Neon autosuspend 보존을 위해 이 창 외 DB 접근 금지.
- **fx 크론 없음**: `fxRate`·`fx_rates` 테이블 제거(ADR-0004). 환율 갱신 크론 등록하지 말 것.
