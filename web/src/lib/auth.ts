// Better Auth v1.6 서버 설정 (T03). drizzleAdapter(pg) + google 소셜 +
// anonymous 게스트 + nextCookies. env 접근은 전부 런타임 lazy — 키·DB 없이 빌드 통과.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, username } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import {
  users,
  authSession,
  authAccount,
  authVerification,
} from "@mockstock/shared/schema";
import { isValidUsername, USERNAME_MIN, USERNAME_MAX } from "./username";

// Neon serverless Pool. 생성만으로는 커넥션을 열지 않고 첫 쿼리 시 lazy 연결 —
// DATABASE_URL 미설정(빌드/키 없음) 상태에서도 모듈 로드는 안전.
// ponytail: WS 커넥션 폴백은 실제 런타임 접속 이슈가 관측될 때 추가.
const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), {
  schema: { users, authSession, authAccount, authVerification },
});

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
    // 키 = Better Auth 모델명, 값 = drizzle 테이블. session/account/verification은
    // auth_ 프리픽스 테이블로 매핑해 도메인 accounts(시즌 계좌)와 이름 충돌 회피(PRD §9).
    schema: {
      user: users,
      session: authSession,
      account: authAccount,
      verification: authVerification,
    },
  }),
  // 이메일+비밀번호 로그인 — 로컬/키 없는 환경에서도 동작(구글 OAuth 리다이렉트 불필요).
  // 해시(scrypt)·세션은 Better Auth가 처리, 해시 비번은 auth_account.password에 저장.
  // requireEmailVerification:false — 메일 발송 인프라 없이 가입 즉시 로그인(autoSignIn 기본 true).
  //   트레이드오프(codex 리뷰 HIGH): 미검증 이메일 허용 → email-squatting(타인 이메일 선점) 가능.
  //   본 게임은 이메일을 신뢰 앵커로 쓰지 않음(비번 재설정·복구 없음, 리더보드는 닉네임). 이메일을
  //   신뢰 식별자로 쓰거나 복구 기능 추가 시 반드시 true + 메일 발송 구성으로 전환할 것.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  plugins: [
    anonymous({
      onLinkAccount: async () => {
        // PRD §5.4: 게스트는 도메인 데이터(주문·계좌)를 만들지 않는다 — 게이트가 주문·리그
        // 참여뿐이라 이전할 행이 없다. v1은 의도적으로 no-op(익명 행은 링크 시 기본 삭제).
      },
    }),
    // 아이디(username) 로그인 — /sign-in/username. 소문자 정규화·[a-zA-Z0-9_.] 기본.
    // 가입은 코어 email/password 경로라 이메일이 필요 → 로그인 폼이 아이디로 합성 이메일을 만들어 전달.
    // usernameValidator: 점 위치 제한(선행/후행/연속) — 합성 이메일이 항상 유효하도록(클라와 동일 규칙).
    username({
      minUsernameLength: USERNAME_MIN,
      maxUsernameLength: USERNAME_MAX,
      usernameValidator: isValidUsername,
    }),
    // nextCookies는 반드시 마지막 플러그인 — set-cookie를 Next 라우트/서버액션에 자동 전파.
    nextCookies(),
  ],
});
