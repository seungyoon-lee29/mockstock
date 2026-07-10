# 카카오 로그인 + 전용 로그인 화면 (서브프로젝트 ①)

- 상태: 설계 확정 (2026-07-10)
- 범위: **web 워크스페이스만.** 기존 Better Auth v1.6.23 스택(Google·GitHub·anonymous) 위에 (a) 카카오 프로바이더를 genericOAuth 플러그인으로 추가, (b) `/login` 전용 로그인 화면 신설. 재구축 없음 — 순수 증분 2가지.
- 관련: `web/src/lib/auth.ts`(서버 설정) · `web/src/lib/auth-client.ts`(클라이언트) · `web/src/components/layout/session-widget.tsx` · `shared/src/schema.ts` L35–51(users)·L224–283(auth_*) · `web/.env.example` L15–27
- 비고: `/login`은 서브프로젝트 ②(Capacitor 앱 래핑)에서 앱 웹뷰의 최초 화면으로 재사용될 예정이다. 이 스펙에서는 일반 웹 페이지로만 만들면 되고 앱 대응 설계는 하지 않는다.

## 0. 설치 버전 검증 요약 (기억이 아니라 node_modules 기준)

아래 API는 전부 이 리포에 설치된 `better-auth@1.6.23`(루트 `node_modules/better-auth/`, npm workspaces 호이스팅)에서 직접 확인했다.

| 항목 | 확인 내용 | 근거 파일 |
| --- | --- | --- |
| 서버 플러그인 | `genericOAuth({ config: GenericOAuthConfig[] })`, `better-auth/plugins`에서 export | `node_modules/better-auth/dist/plugins/index.d.mts` |
| `GenericOAuthConfig` 필드 | `providerId`, `clientId`, `clientSecret?`, `authorizationUrl?`, `tokenUrl?`, `userInfoUrl?`, `scopes?`, `mapProfileToUser?`, `getUserInfo?`, `redirectURI?`, `pkce?`, `authentication?`("basic"\|"post", 기본 "post"), `overrideUserInfo?` 등 | `dist/plugins/generic-oauth/types.d.mts` |
| 클라이언트 플러그인 | `genericOAuthClient()`, `better-auth/client/plugins`에서 export | `dist/client/plugins/index.d.mts` L45·L60 |
| 로그인 호출 | `POST /sign-in/oauth2` body = `{ providerId, callbackURL?, errorCallbackURL?, newUserCallbackURL?, disableRedirect?, scopes?, requestSignUp?, additionalData? }` → 클라이언트에서 `authClient.signIn.oauth2({...})` | `dist/plugins/generic-oauth/routes.mjs` L21–30 |
| 콜백 경로 | `{auth baseURL}/oauth2/callback/{providerId}` — builtin 소셜(`/callback/google`)과 **경로가 다름** | `routes.mjs` L101·L179 |
| email 부재 시 동작 | 콜백이 **하드 실패**: `redirectOnError(..., "email_is_missing")`. 프로바이더가 email을 안 주면 `mapProfileToUser`에서 반드시 합성해야 함 | `routes.mjs` L211–214, `dist/oauth2/errors.mjs` |
| name 부재 시 동작 | 동일하게 `name_is_missing` 하드 실패 → name도 폴백 필수 | `routes.mjs` L222–226 |
| 동의 취소 시 동작 | 카카오가 `?error=`로 콜백 → state 파싱 **전이라** `errorCallbackURL`이 아니라 `onAPIError.errorURL`(기본 `{auth baseURL}/error`)로 리다이렉트 | `routes.mjs` L139, `@better-auth/core/dist/types/init-options.d.mts` L1318–1340 |
| anonymous 링크 훅 | `onLinkAccount?: (data: { anonymousUser, newUser }) => …` 존재. after-hook matcher가 `/oauth2/callback`을 포함하므로 **genericOAuth 로그인도 게스트 전환을 트리거**함. 기본 동작 = 익명 user 행·세션 삭제(`disableDeleteAnonymousUser`로 끌 수 있음) | `dist/plugins/anonymous/types.d.mts` L30–44, `dist/plugins/anonymous/index.mjs` L121–158 |
| 기본 `getUserInfo` | idToken이 없으면 `userInfoUrl`을 `Authorization: Bearer {accessToken}`로 GET, 응답 JSON을 그대로 `mapProfileToUser`에 전달 | `routes.mjs` L392+ |

## 1. 서버: 카카오 genericOAuth 구성 (`web/src/lib/auth.ts`)

### 1.1 카카오 엔드포인트 상수

카카오 OAuth2 엔드포인트는 카카오가 정한 고정 프로토콜 값이므로 env가 아니라 **`auth.ts` 상단의 이름 있는 상수**로 둔다(하드코딩 금지 규칙의 예외 아님 — 인라인 매직 스트링을 금지하는 것이고, 이름 있는 상수로 의도를 드러낸다):

```ts
// 카카오 OAuth2 고정 엔드포인트 (https://developers.kakao.com/docs/latest/ko/kakaologin/rest-api)
const KAKAO_AUTHORIZATION_URL = "https://kauth.kakao.com/oauth/authorize";
const KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token";
const KAKAO_USERINFO_URL = "https://kapi.kakao.com/v2/user/me";
```

### 1.2 플러그인 등록

`plugins` 배열에서 `anonymous(...)` **뒤, `nextCookies()` 앞**에 추가한다(nextCookies는 반드시 마지막 — 기존 주석 유지):

```ts
import { anonymous, genericOAuth } from "better-auth/plugins";

genericOAuth({
  config: [
    {
      providerId: "kakao",
      clientId: process.env.KAKAO_CLIENT_ID as string,       // 기존 GOOGLE_* 와 동일한 lazy-env 패턴
      clientSecret: process.env.KAKAO_CLIENT_SECRET,          // 콘솔에서 secret 미사용 시 빈 값 허용(옵셔널 필드)
      authorizationUrl: KAKAO_AUTHORIZATION_URL,
      tokenUrl: KAKAO_TOKEN_URL,
      userInfoUrl: KAKAO_USERINFO_URL,
      scopes: ["profile_nickname", "profile_image"],
      mapProfileToUser: mapKakaoProfile, // §1.3 — 이름 있는 export 함수(단위 테스트 대상, §7.3)
    },
  ],
}),
```

- `authentication`은 기본값 "post"를 그대로 쓴다 — 카카오 토큰 엔드포인트는 `client_secret`을 POST body로 받는다.
- `pkce`·`discoveryUrl`은 쓰지 않는다. 카카오는 OIDC discovery 없이도 위 3개 URL로 충분하고, PKCE는 서버 confidential client라 불필요.
- **스코프에 `account_email`을 넣지 않는다.** email은 카카오 비즈 앱 심사를 통과해야 동의 항목으로 켤 수 있어, 개인 개발자 앱인 v1에서는 사실상 항상 부재다. §1.3의 매핑이 email 존재/부재를 모두 처리하므로, 나중에 비즈 앱 전환 시 이 배열에 `"account_email"`만 추가하면 코드 변경 없이 실이메일이 흘러들어온다.

### 1.3 프로필 매핑 — email·name 부재를 반드시 흡수

카카오 `/v2/user/me` 응답 형태: `{ id: number, kakao_account?: { profile?: { nickname?, profile_image_url? }, email?, is_email_verified? } }`. §0에서 확인했듯 설치 버전의 콜백은 email 또는 name이 비면 하드 실패하므로 매핑에서 폴백을 강제한다:

```ts
// auth.ts에서 이름 있는 함수로 export — genericOAuth config와 단위 테스트가 공유
export function mapKakaoProfile(profile: Record<string, any>) {
  const account = profile.kakao_account ?? {};
  return {
    // nickname은 profile_nickname 동의 거부 시 부재 가능 → name_is_missing 하드 실패 방지 폴백
    name: account.profile?.nickname ?? "카카오 사용자",
    image: account.profile?.profile_image_url ?? undefined,
    // email 부재(비즈 앱 아님·동의 안 함) → 결정적 합성 이메일. 카카오 id 기준이라 재로그인 시 항상 동일.
    // .invalid 는 RFC 2606 예약 TLD — 실제 메일 주소와 충돌 불가. 이 앱은 메일 발송 기능이 없다.
    email: account.email ?? `kakao_${profile.id}@kakao.invalid`,
    emailVerified: account.is_email_verified === true,
  };
}
```

- **스키마 확인 결과 변경 불필요**: `users.email`은 nullable unique(`shared/src/schema.ts` L40)지만, Better Auth 경로에서는 위 매핑이 항상 non-null email을 공급하므로 nullable 여부와 무관하게 안전하다. 합성 이메일은 카카오 id에 결정적이라 unique 제약과도 충돌하지 않는다(같은 카카오 유저 = 같은 합성 주소, 재로그인은 email이 아니라 `auth_account(provider_id='kakao', account_id)` 매칭으로 기존 유저에 붙는다).
- 유저 id 매핑은 불필요 — 콜백이 `profile.id`(number)를 `String()`으로 계정 id에 쓴다(§0 검증).
- **email 충돌 엣지**(카카오가 실이메일을 준 경우 그 이메일의 구글 가입자가 이미 존재): v1은 `account.accountLinking`을 별도 설정하지 않고 Better Auth 기본 정책에 맡긴다. 실패 시 콜백이 에러 리다이렉트를 타고 `/login`의 일반 실패 문구(§3.4)로 표면화된다. v1 스코프(email 스코프 자체를 요청 안 함)에서는 발생하지 않는 경로다.

### 1.4 에러 리다이렉트 목적지

동의 취소(`access_denied`)는 state 파싱 전에 발생해 `errorCallbackURL`이 아닌 전역 기본값으로 간다(§0). 기본값 `{auth baseURL}/error`는 Better Auth 내장 에러 페이지(영문)라 UX에 맞지 않으므로 전역 옵션을 `/login`으로 돌린다:

```ts
// betterAuth({ ... }) 최상위 옵션에 추가
onAPIError: {
  errorURL: `${process.env.BETTER_AUTH_URL}/login`,
},
```

이로써 콜백 단계의 모든 실패가 `/login?error=<코드>`로 수렴한다 (`redirectOnError`가 `error`·`error_description` 쿼리 파라미터를 붙임 — `dist/oauth2/errors.mjs` 검증).

## 2. 클라이언트 (`web/src/lib/auth-client.ts`)

플러그인 1개 추가가 전부다:

```ts
import { anonymousClient, genericOAuthClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [anonymousClient(), genericOAuthClient()],
});
```

호출 시그니처(설치 버전 검증, §0):

```ts
// 카카오
await authClient.signIn.oauth2({ providerId: "kakao", callbackURL: "/", errorCallbackURL: "/login" });
// 구글 (기존 builtin — 변경 없음)
await authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/login" });
// 게스트 (기존 — 리다이렉트 없음, 성공 후 router.replace("/"))
await authClient.signIn.anonymous();
```

## 3. `/login` 화면 (`web/src/app/login/page.tsx` + 클라이언트 버튼 컴포넌트)

### 3.1 구조

- `page.tsx` = **서버 컴포넌트**. `auth.api.getSession({ headers: await headers() })`로 세션 조회 후:
  - 세션 있음 **그리고** `user.isAnonymous !== true` → `redirect("/")` (`next/navigation`, Next 16 문서 `03-api-reference/04-functions/redirect.md`로 시그니처 확인 완료 — 서버 컴포넌트에서 그대로 사용 가능).
  - 세션 없음 → 버튼 3개 전부 노출.
  - **게스트 세션** → 페이지 노출하되(전환 경로!) 게스트 버튼은 숨기고 안내 문구 1줄: "게스트로 플레이 중 — 소셜 로그인하면 정식 계정으로 전환됩니다."
- 버튼·에러 표시는 하위 클라이언트 컴포넌트(`web/src/components/auth/login-buttons.tsx` 신설, `"use client"`)로 분리. `useSearchParams`로 `?error=` 읽기.
- shadcn `Button` 재사용(`web/src/components/ui/button.tsx`, ui.md 규칙). 새 CSS 파일 금지 — Tailwind 유틸리티만.

### 3.2 버튼 구성 (위→아래, UI 텍스트 한국어)

| 순서 | 버튼 | 스타일 | 동작 |
| --- | --- | --- | --- |
| 1 | **카카오로 시작하기** | 카카오 관례: 배경 `#FEE500`, 텍스트 검정 85% (`KAKAO_BRAND` 상수 객체를 컴포넌트 파일 상단에 명명 — 인라인 매직값 금지) | `signIn.oauth2({ providerId: "kakao", callbackURL: "/", errorCallbackURL: "/login" })` |
| 2 | **구글로 시작하기** | outline variant | `signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/login" })` |
| 3 | **게스트로 둘러보기** | ghost/secondary variant. 게스트 세션이면 숨김 | `signIn.anonymous()` 성공 후 `router.replace("/")` |

- 각 버튼은 진행 중 `disabled`(기존 session-widget의 `busy` 패턴 재사용).
- GitHub 버튼은 **두지 않는다** — 현재도 UI 진입점이 없고(session-widget은 게스트 버튼뿐), 서버 설정은 현행 유지(§6).
- 페이지 상단: 서비스명 + 한 줄 소개("매주 리셋되는 주식 배틀로얄"). 별도 온보딩 스텝(닉네임 입력 등)은 만들지 않는다 — 카카오 닉네임/구글 이름이 곧 표시명이고, 게스트는 기존 anonymous 플로우 그대로.

### 3.3 리다이렉트 정책

| 상황 | 목적지 |
| --- | --- |
| 로그인 성공(기존/신규 무관) | `/` (`callbackURL: "/"`; `newUserCallbackURL`은 지정하지 않음 — 신규도 홈) |
| 이미 정식 로그인 상태로 `/login` 접근 | 서버 컴포넌트에서 `redirect("/")` |
| 게스트 상태로 `/login` 접근 | 페이지 노출 (전환 UI) |
| 콜백 실패 전부 | `/login?error=<코드>` (§1.4 + `errorCallbackURL`) |

### 3.4 에러 표시

`?error=` 값에 따라 버튼 위에 안내 배너 1개:

- `access_denied` → "로그인을 취소했어요. 다시 시도해 주세요."
- 그 외 전부(`email_is_missing`·`oauth_code_verification_failed`·`user_info_is_missing` 등) → "로그인에 실패했어요. 잠시 후 다시 시도해 주세요."

코드별 세분화는 하지 않는다 — 사용자가 할 수 있는 행동이 "재시도" 하나뿐이라 구분 가치가 없다. (`email_is_missing`은 §1.3 폴백으로 정상 경로에선 발생하지 않는다.)

## 4. session-widget과의 관계 — **대체가 아니라 진입점 위임**

`web/src/components/layout/session-widget.tsx` 변경:

| 상태 | 현재 | 변경 후 |
| --- | --- | --- |
| 비로그인 | "게스트로 시작" 버튼(인라인 `signIn.anonymous()`) | **"로그인" 버튼 — `/login`으로 이동** (`Button asChild` + `Link`). 인라인 게스트 로그인 로직은 위젯에서 삭제 — 로그인 수단 선택은 `/login` 한곳으로 통일 |
| 게스트 로그인 | 닉네임 + 로그아웃 | 닉네임 + **"계정 전환" 링크(→ `/login`)** + 로그아웃 — 게스트가 정식 전환할 유일한 진입점 |
| 정식 로그인 | 닉네임 + 로그아웃 | 변경 없음 |

즉 session-widget은 **세션 상태 표시 + `/login`으로의 링크**만 담당하고, 로그인 실행은 전부 `/login`이 담당한다(병존이되 역할 분리; 인라인 소셜/게스트 버튼은 위젯에서 제거).

게스트 여부 판별: anonymous 플러그인이 세션 user에 `isAnonymous`를 노출한다(`shared/src/schema.ts` L46 컬럼과 정합).

## 5. 게스트 → 소셜 전환 정책 (가장 단순한 안 확정)

- **자산 승계 없음 = 현행 no-op 유지.** `web/src/lib/auth.ts` L48–53의 `anonymous({ onLinkAccount: no-op })`을 그대로 둔다. 근거: PRD §5.4 — 게스트는 주문·리그 참여가 게이트되어 도메인 데이터(주문·계좌·포지션)를 만들지 않으므로 승계할 행 자체가 없다.
- 기본 동작대로 전환 시 익명 user 행과 세션은 삭제되고(§0 검증: `deleteUserSessions` + `deleteUser`), 소셜 신규 유저로 새 세션이 열린다. `disableDeleteAnonymousUser`는 쓰지 않는다.
- §0에서 검증했듯 anonymous 플러그인의 matcher가 `/oauth2/callback`을 포함하므로 **카카오(genericOAuth) 전환도 구글(builtin)과 동일하게 동작한다.** 추가 코드 불필요.

## 6. env (`web/.env.example` — web 전용, 자리만 추가)

기존 GOOGLE_*/GITHUB_* 블록(L20–27)과 같은 패턴으로 추가. **실제 키 값은 사용자가 직접 붙여넣는다 — 예시 파일·스펙·커밋 어디에도 실제 값 금지.**

```bash
# Kakao OAuth (genericOAuth): https://developers.kakao.com/console/app
#   KAKAO_CLIENT_ID = 앱 키 > REST API 키
#   Redirect URI 등록값 = {BETTER_AUTH_URL}/api/auth/oauth2/callback/kakao  ← builtin 소셜(/callback/google)과 경로 다름 주의
#   KAKAO_CLIENT_SECRET: [내 애플리케이션] > 보안 에서 활성화한 경우에만 필수, 미사용 시 빈 값
KAKAO_CLIENT_ID=
KAKAO_CLIENT_SECRET=
```

Vercel 프로젝트 env에도 같은 두 키를 추가한다(배포 시 `BETTER_AUTH_URL`이 실제 오리진이므로 카카오 콘솔에 프로덕션 Redirect URI를 별도 등록).

## 7. 테스트 계획

### 7.1 카카오 콘솔 사전 설정 (로컬)

1. https://developers.kakao.com/console/app 에서 앱 생성.
2. [플랫폼] > Web 사이트 도메인: `http://localhost:3000`.
3. [카카오 로그인] 활성화, Redirect URI 등록: `http://localhost:3000/api/auth/oauth2/callback/kakao`.
4. [동의항목] 닉네임(`profile_nickname`)·프로필 사진(`profile_image`)을 "필수 동의" 또는 "선택 동의"로 활성화. (email은 설정하지 않음 — v1 스코프 밖.)
5. REST API 키 → `KAKAO_CLIENT_ID`. [보안]에서 Client Secret 활성화했다면 → `KAKAO_CLIENT_SECRET`.

### 7.2 수동 시나리오 (로컬 `npm run dev:web`)

| # | 시나리오 | 기대 결과 |
| --- | --- | --- |
| 1 | 비로그인으로 `/login` → 카카오 버튼 → 동의 | `/`로 복귀. `users`에 신규 행(email = `kakao_<id>@kakao.invalid`, `is_anonymous=false`), `auth_account`에 `provider_id='kakao'` 행 |
| 2 | 로그아웃 후 카카오 재로그인 | 새 행 생성 없이 1의 유저로 로그인 (auth_account 매칭) |
| 3 | 카카오 동의 화면에서 취소 | `/login?error=access_denied` + "로그인을 취소했어요" 배너 |
| 4 | 게스트로 시작 → 위젯 "계정 전환" → 카카오 로그인 | 익명 user 행 삭제, 카카오 유저로 새 세션 (users에서 익명 행 소멸 확인) |
| 5 | 정식 로그인 상태에서 `/login` 직접 접근 | 즉시 `/` 리다이렉트 |
| 6 | 게스트 상태에서 `/login` 접근 | 페이지 노출 + 게스트 버튼 숨김 + 전환 안내 문구 |
| 7 | 구글 로그인 (회귀) | 기존과 동일하게 동작 (변경 영향 없음 확인) |
| 8 | 위젯 "로그인" 버튼 | `/login` 이동 (인라인 게스트 로그인이 사라졌는지 확인) |

### 7.3 자동 검증

- `npm run typecheck` + `npm run build` (web) 통과.
- `mapKakaoProfile`(§1.3의 이름 있는 export) 단위 테스트 1개 추가(기존 `*.test.ts` 패턴, `web/src/lib/auth.test.ts`): email·nickname 부재 프로필 → 합성 email·폴백 name 반환 assert. 콜백 하드 실패(§0)를 막는 유일한 방어선이므로 이 한 개는 필수.

## 8. 스코프 밖

- **Capacitor 앱 래핑** — 서브프로젝트 ②. `/login`이 나중에 앱 웹뷰 최초 화면으로 쓰인다는 비고만 남긴다(상단 비고 참조).
- **GitHub 프로바이더 제거 여부** — 현행 유지. 서버 설정(`auth.ts` L42–45)과 env는 그대로 두고 `/login`에 버튼만 두지 않는다.
- **애플 로그인.**
- **계정 연결(accountLinking) 커스텀** — trustedProviders·수동 링크 UI 등. v1은 Better Auth 기본값.
- **카카오 비즈 앱 전환·`account_email` 스코프** — 전환 시 §1.2 스코프 배열에 추가만 하면 됨.
- **온보딩 스텝(닉네임 편집 등)** — 소셜 프로필 이름을 그대로 사용.

## 9. 구현 파일 목록 (예상 diff 표면)

| 파일 | 변경 |
| --- | --- |
| `web/src/lib/auth.ts` | 카카오 상수 3개 + `genericOAuth` 플러그인 + `onAPIError.errorURL` |
| `web/src/lib/auth-client.ts` | `genericOAuthClient()` 추가 |
| `web/src/app/login/page.tsx` | 신규 — 서버 컴포넌트(세션 분기 + 리다이렉트) |
| `web/src/components/auth/login-buttons.tsx` | 신규 — 버튼 3종 + 에러 배너 클라이언트 컴포넌트 |
| `web/src/components/layout/session-widget.tsx` | 인라인 게스트 로그인 제거 → `/login` 링크 위임 + 게스트 "계정 전환" 링크 |
| `web/.env.example` | `KAKAO_CLIENT_ID`·`KAKAO_CLIENT_SECRET` 자리 추가 |
| `web/src/lib/auth.test.ts` | 신규 — `mapKakaoProfile` 폴백 단위 테스트 |

DB 마이그레이션 **없음** — 기존 users/auth_* 스키마가 그대로 수용한다(§1.3).
