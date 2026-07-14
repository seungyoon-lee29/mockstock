# 모의 주식게임

매주 리셋되는 주식 배틀로얄 + 과거장 훈련소. 실시간 시세(KIS·Finnhub)로 가상 현금 매매하는 풀스택 포트폴리오 작품.

> 확정 설계: `docs/specs/2026-07-04-모의주식게임-v1-PRD.md`. 구현 티켓 T01~T10 매핑은 `docs/tickets.md`(노션 미러), 상세·상태는 노션 + PRD 로드맵 참고.

## 구조 (npm workspaces 모노레포)


| 경로               | 역할                                                                |
| ---------------- | ----------------------------------------------------------------- |
| `shared/`        | web·worker 공용 계약 — 도메인 타입, 유니버스, drizzle 스키마, `fillOrder`, 시장 캘린더 |
| `web/`           | Next.js 16 앱 — UI · 인증 · 주문/리그 API (Vercel 배포)                    |
| `worker/`        | Node 상주 게이트웨이 — 시세 WS→SSE, 지정가 매칭, 크론 (Railway 배포)                |
| `docs/specs/`    | PRD·설계 문서 · `docs/adr/` 결정 기록 · `docs/metrics.md` 지표              |
| `.claude/rules/` | 경로별 자동 적용 코딩 규칙                                                   |


`shared`는 빌드 스텝 없이 TS 소스 그대로 소비된다 (web은 `transpilePackages`, worker는 tsx). 임포트는 `@mockstock/shared` (배럴) / `@mockstock/shared/schema` · `/fillOrder` · `/calendar` (서버 전용 서브패스).

## 명령어 (루트에서)

```bash
npm install                # 워크스페이스 전체 설치 (최초 1회)
npm run dev:web            # web  http://localhost:3000
npm run dev:worker         # worker http://localhost:8787 (mock 피드, 키 불필요)
npm run build              # web 프로덕션 빌드
npm run typecheck          # shared + worker 타입 검사
```

## 작업 규칙 (승윤 지시, 2026-07-13 갱신)

- **메인 모델은 판단만 한다** — 플랜·아키텍처 설계와 최종 리뷰만 직접 수행. 리뷰·조사·구현·문서 수정 등 생산 작업은 서브에이전트에게 위임. 단, **trivial한 건(한 줄 수정·오타·순수 읽기·자명한 조회)은 직접 수행 가능** — 콜드 스타트 위임이 결과를 안 바꾸는 경우. 그 이상 규모/판단이 필요하면 위임하고, 굳이 직접 해야 하면 사용자 허락을 먼저 받는다.
- **확정 게이트는 리스크에 비례** — 확정 산출물은 리스크에 맞춰 검증 강도를 조절한다.
  - **틀리면 비싼 것**(아키텍처·DB 스키마·`fillOrder`/금액 경로·보안·인증) = **풀 게이트**: 리뷰 → 적대적 리뷰 → 메인 판단 후 반영.
  - **일반 코드** = 리뷰 1패스 + 메인 판단.
  - **docs·문구·설정 한 줄** = 게이트 생략, 바로 반영.
- **적대적 리뷰는 원 작성자와 다른 모델로** — 같은 모델이 자기 결과를 보면 블라인드 스팟이 상관됨. codex를 기본 적대자로 쓰되, 없으면 다른 서브에이전트 등 **작성자와 다른 관점**이면 된다.
- **완료 게이트** — "완료" 선언 전 `npm run typecheck`(+영향 시 `build`) 통과, UI 변경은 실제 렌더로 확인.
- **스킬/MCP 활용 (메인·서브 공통)** — 작업 전 관련 스킬/MCP가 있는지 먼저 확인하고 맞으면 쓴다. deferred MCP는 `ToolSearch`로 로드 후 사용. 라이브러리·API·설정 값은 기억으로 답하지 말고 스킬(context7 등)·실제 명령 출력으로 확인한다.
- 서브에이전트는 작업 시작 전 사용 가능한 스킬을 확인하고 적합한 것을 활용한다. 작업 중 애매한 판단은 다른 서브에이전트와 상의해 해소한다. **위임 시 메인 모델이 후보 스킬/MCP를 프롬프트에 명시하고, 결과에서 실제 사용 여부를 검증한다.**

## 코딩 규칙

- **하드코딩 금지** — URL·시크릿·매직 넘버·정책 값은 env, 설정, `shared/` 상수로만. 코드에 인라인 금지. 새 상수 만들기 전 **기존 `shared/` 상수를 먼저 찾아 재사용**한다.
- 경로별 상세 규칙은 `.claude/rules/*.md`가 해당 파일 편집 시 자동 로드 — DB·정산(`db.md`), Next.js 16(`nextjs.md`), UI·색상·한국어(`ui.md`), 워커(`worker.md`).

## 주의

- 시세: 키 없이도 mock 피드로 로컬 실행 가능 (`worker/src/feeds/mock.ts`, web 폴백 `web/src/lib/market/priceSource.ts`).

## Agent skills

### Issue tracker

Issues live as GitHub issues (`seungyoon-lee29/mockstock`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

