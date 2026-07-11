# 모의 주식게임

매주 리셋되는 주식 배틀로얄 + 과거장 훈련소. 실시간 시세(KIS·Finnhub)로 가상 현금 매매하는 풀스택 포트폴리오 작품.

> 확정 설계: `docs/specs/2026-07-04-모의주식게임-v1-PRD.md`. 구현 티켓 T01~T10 매핑은 `docs/tickets.md`(노션 미러), 상세·상태는 노션 + PRD 로드맵 참고.

## 구조 (npm workspaces 모노레포)

| 경로 | 역할 |
| --- | --- |
| `shared/` | web·worker 공용 계약 — 도메인 타입, 유니버스, drizzle 스키마, `fillOrder`, 시장 캘린더 |
| `web/` | Next.js 16 앱 — UI · 인증 · 주문/리그 API (Vercel 배포) |
| `worker/` | Node 상주 게이트웨이 — 시세 WS→SSE, 지정가 매칭, 크론 (Railway 배포) |
| `docs/specs/` | PRD·설계 문서 · `docs/adr/` 결정 기록 · `docs/metrics.md` 지표 |
| `.claude/rules/` | 경로별 자동 적용 코딩 규칙 |

`shared`는 빌드 스텝 없이 TS 소스 그대로 소비된다 (web은 `transpilePackages`, worker는 tsx). 임포트는 `@mockstock/shared` (배럴) / `@mockstock/shared/schema` · `/fillOrder` · `/calendar` (서버 전용 서브패스).

## 명령어 (루트에서)

```bash
npm install                # 워크스페이스 전체 설치 (최초 1회)
npm run dev:web            # web  http://localhost:3000
npm run dev:worker         # worker http://localhost:8787 (mock 피드, 키 불필요)
npm run build              # web 프로덕션 빌드
npm run typecheck          # shared + worker 타입 검사
```

## 작업 규칙 (승윤 지시, 2026-07-10 갱신)

- **메인 모델은 판단만 한다** — 플랜·아키텍처 설계와 최종 리뷰만 직접 수행. 리뷰·조사·구현·문서 수정 등 생산 작업은 전부 서브에이전트에게 위임. 메인 모델이 직접 생산 작업을 해야 하는 상황이면 반드시 사용자 허락을 먼저 받는다. 허락 없이는 절대 직접 작업 금지.
- **3단계 확정 게이트** — 확정이 필요한 산출물(초기 플랜·아키텍처, 이후 서브에이전트 결과물)은 리뷰 → 적대적 리뷰 → Codex 적대적 리뷰를 거친 뒤 반영·업데이트하고 답변한다.
- 서브에이전트는 작업 시작 전 사용 가능한 스킬을 확인하고 적합한 것을 활용한다. 작업 중 애매한 판단은 다른 서브에이전트와 상의해 해소한다.
- **하드코딩 금지** — URL·시크릿·매직 넘버·정책 값은 env, 설정, `shared/` 상수로만. 코드에 인라인 금지.

## 주의

- **Next.js 16은 학습 데이터와 다름** — 코드 작성 전 `web/node_modules/next/dist/docs/`의 관련 가이드를 먼저 읽을 것.
- 시세: 키 없이도 mock 피드로 로컬 실행 가능 (`worker/src/feeds/mock.ts`, web 폴백 `web/src/lib/market/priceSource.ts`).
- 금액은 전부 `numeric`(float 금지), 체결은 `shared/fillOrder` 단일 함수로만 — 상세는 `.claude/rules/db.md`.
- UI 텍스트는 한국어. 상승 빨강 / 하락 파랑.
