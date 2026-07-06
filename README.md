# 모의주식 (Mock Stock)

**매주 리셋되는 주식 배틀로얄 + 과거장 훈련소.** 실시간 시세(미국 Finnhub · 한국 KIS)로 미국·한국 주식을 **가상 현금**으로 매매하는 모의투자 게임. 풀스택 포트폴리오 작품.

## 구조 (npm workspaces, 배포 2단위)

```
shared/  → web·worker 공용 계약 (타입 · 유니버스 · drizzle 스키마 · fillOrder · 시장 캘린더)
web/     → Next.js 16 앱 (UI · 인증 · 주문/리그 API · DB)        [Vercel]
worker/  → Node 상주 게이트웨이 (Finnhub·KIS WS → SSE · 매칭 · 크론) [Railway]
docs/    → PRD · 설계 · ADR · 지표
```

## 데이터 소스

- **미국 주식**: Finnhub WebSocket (무료·실시간)
- **한국 주식**: 한국투자증권 KIS 모의투자 WebSocket (실시간체결가)
- 키 없이도 **mock 시세 피드**로 로컬 실행 가능 (`FEED_*=mock`)

## 로컬 실행

```bash
npm install                 # 워크스페이스 전체 (최초 1회)
npm run dev:worker          # 실시간 워커  http://localhost:8787  (mock, 키 불필요)
npm run dev:web             # 웹앱        http://localhost:3000  (별도 터미널)
```

환경변수는 `web/.env.example`, `worker/.env.example` 참고.

## 상태

v1 뼈대 완성. 구현은 티켓 T01~T10 (`docs/tickets.md` 매핑 · 노션 + `docs/specs/2026-07-04-모의주식게임-v1-PRD.md` 로드맵).
2차 적대적 리뷰(6렌즈 32건) 반영 완료 — 2026-07-05.
현재 동작: 발견 홈 · mock 실시간 시세 · SSE. 다음: DB·인증·시장가 체결(T02~T04).
