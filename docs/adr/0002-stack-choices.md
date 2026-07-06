# ADR 0002 — 기술 스택 선정 (리서치 근거)

- 상태: 채택 (2026-07-04)
- 맥락: Next.js 16 + React 19 + Tailwind v4 + drizzle 기반. 리서치 6종으로 확정.

| 영역 | 선택 | 기각·근거 |
| --- | --- | --- |
| 인증 | **Better Auth v1.6** | Auth.js v5 대신 — `anonymous` 플러그인이 게스트 모드와 정확히 일치 + drizzleAdapter + google/github |
| DB | **Neon Free + drizzle 0.45** | web은 `neon-serverless`(WebSocket Pool, 트랜잭션), worker는 장중 한정 커넥션(autosuspend 보존). 무료 월 **100 CU-hours**(2025-10, CU 가중·0.25~2 CU 오토스케일) 보존이 제약 |
| 워커 DB 드라이버 | **node-postgres(`pg`) Pool** | 상주 워커라 인터랙티브 트랜잭션(CAS+RETURNING 단일 트랜잭션) 완전 지원. 장 마감 시 pool 해제로 autosuspend 보존. web은 서버리스에 맞는 neon-serverless 유지 |
| 차트 | **lightweight-charts v5.2** | React 래퍼 없이 useRef/useEffect 직접 마운트. 실시간 틱 + 배속 재생 모두 적합 |
| 워커 호스팅 | **Railway Hobby $5** (조건부) | KIS 해외 IP 차단 리스크 → T01 스파이크. 실패 시 Oracle Cloud Free(서울) |
| KR 시세 | **KIS 모의투자(VTS) 앱키** | 즉시·무료·1년(최대 2개). 실시간 WS 지원. 세션당 41건·REST 2건/초·토큰 24h |
| 리플레이 데이터 | **KR=공공데이터포털 금융위 / US=Stooq** | 공공데이터는 이용허락 '제한 없음' → 리포 커밋 합법. yfinance·Alpha Vantage(약관 금지)·Finnhub 캔들(유료) 기각 |

전체 근거·출처 URL은 `docs/specs/2026-07-04-모의주식게임-v1-PRD.md` §8 참고.
