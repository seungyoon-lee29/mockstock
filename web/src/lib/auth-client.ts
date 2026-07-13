// Better Auth 클라이언트 (T03). 같은 오리진의 /api/auth로 자동 연결(baseURL 불필요).
// 게스트(anonymous)·소셜 로그인 메서드를 컴포넌트에 노출.
"use client";
import { createAuthClient } from "better-auth/react";
import { anonymousClient, usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [anonymousClient(), usernameClient()],
});

// signIn.social({ provider }) · signIn.username({ username, password }) · signIn.anonymous() · signOut · useSession
export const { signIn, signOut, useSession } = authClient;
