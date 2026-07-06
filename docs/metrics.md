# 성공 지표 (SQL로 계산)

이벤트 수집 인프라 없이 기존 테이블만으로 계산 가능한 3개 지표(A16). T10에서 프로드 실측치 기록.
PRD §2.2와 SQL은 완전히 동일하다. 봇(`is_bot`)·익명 게스트(`is_anonymous`)는 활성화·리텐션 지표(①②)에서 제외한다.
표본 N<20이므로 전 지표는 **%와 분자·분모 절대 카운트를 병기**한다(재참여율 ②는 정식 표본 확보 전까지 env 단축 시즌 시뮬레이션 값).

## 1. 첫 주문 도달률 (활성화) — 목표 ≥ 60%

주문을 1건이라도 체결한 사용자 비율. 가입→첫 매수 퍼널의 핵심.
목표 60% 근거: 게스트 열람은 무료지만 첫 주문은 로그인+매매 결정 2단계 관문 — 초대 표본에서 과반 전환을 활성화 하한으로.
※ N<20 → 위 %와 함께 분자(첫 주문자 수)·분모(비봇·비익명 유저 수)를 병기.

```sql
SELECT round(100.0 * count(DISTINCT o.user_id) / nullif(count(DISTINCT u.id), 0), 1) AS pct
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 'filled'
WHERE u.is_bot = false AND u.is_anonymous = false;
```

## 2. 시즌 재참여율 (리텐션) — 목표 ≥ 40%

직전 시즌 주문자 중 이번 시즌에도 주문한 비율. prev/cur 모두 **orders 기준**(실주문자)으로 확정한다 — accounts는 lazy upsert(§4.4)로 첫 진입만 해도 생성돼 실매매 없는 계좌가 분모를 오염시키므로 배제.
목표 40% 근거: 주간 리셋으로 복리 매몰비용이 없는 구조라 40% 복귀는 도전적 — 리셋·라이벌 루프가 재방문을 만드는지의 시금석.
※ N<20 → 위 %와 함께 분자(양 시즌 주문자 수)·분모(직전 시즌 주문자 수)를 병기. 정식 표본 전까지 env 단축 시즌 시뮬레이션 값.

```sql
WITH prev AS (SELECT DISTINCT o.user_id FROM orders o JOIN users u ON u.id = o.user_id
              WHERE o.season_id = :prev_season AND u.is_bot = false AND u.is_anonymous = false),
     cur  AS (SELECT DISTINCT o.user_id FROM orders o JOIN users u ON u.id = o.user_id
              WHERE o.season_id = :cur_season AND u.is_bot = false AND u.is_anonymous = false)
SELECT round(100.0 * count(*) FILTER (WHERE p.user_id IN (SELECT user_id FROM cur))
             / nullif(count(*), 0), 1) AS pct
FROM prev p;
```

## 3. 리플레이 완주율 — 목표 ≥ 70%

시작한 리플레이 세션 중 끝까지 본 비율(게스트 포함 세션은 insert 생략되므로 로그인 세션 기준).
목표 70% 근거: x30 배속 2~3분이라 이탈 비용이 낮음 — 시작자 다수가 끝까지 보는지를 콘텐츠 품질 하한으로.
※ N<20 → 위 %와 함께 분자(완주 세션 수)·분모(시작 세션 수)를 병기.

```sql
SELECT round(100.0 * count(finished_at) / nullif(count(*), 0), 1) AS pct
FROM replay_sessions;
```
