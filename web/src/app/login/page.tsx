"use client";

// 이메일+비밀번호 로그인·회원가입 화면(구글 OAuth 없이 로컬에서도 동작).
// Better Auth authClient.signIn.email / signUp.email 사용 — 해시·세션은 서버가 처리.
// 성공 시 callbackURL(소셜 로그인과 동일 관용구)로 복귀, 없으면 홈.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MIN_PASSWORD = 8; // auth.ts emailAndPassword.minPasswordLength와 동일 정책.

/** Better Auth 에러 코드 → 한국어 메시지. 미매핑은 원문 폴백(빈 값이면 일반 문구). */
function authErrorMessage(err: { code?: string; message?: string } | null): string {
  switch (err?.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "이메일 또는 비밀번호가 올바르지 않습니다.";
    case "USER_ALREADY_EXISTS":
      return "이미 가입된 이메일입니다. 로그인해 주세요.";
    case "PASSWORD_TOO_SHORT":
      return `비밀번호는 최소 ${MIN_PASSWORD}자 이상이어야 합니다.`;
    default:
      return err?.message || "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const callbackURL = search.get("callbackURL") || "/";

  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onSuccess() {
    // useSession이 자동 갱신되지만, 서버 컴포넌트 세션 반영을 위해 refresh 후 이동.
    router.replace(callbackURL);
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        tab === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0] });
      if (res.error) {
        setError(authErrorMessage(res.error));
        return;
      }
      onSuccess();
    } catch {
      setError("네트워크 오류로 요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    email.includes("@") && password.length >= MIN_PASSWORD && (tab === "signin" || true) && !busy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tab === "signin" ? "로그인" : "회원가입"}</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as "signin" | "signup");
            setError(null);
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="signin" className="flex-1">
              로그인
            </TabsTrigger>
            <TabsTrigger value="signup" className="flex-1">
              회원가입
            </TabsTrigger>
          </TabsList>

          <form onSubmit={submit} className="mt-4 space-y-3">
            {tab === "signup" && (
              <div className="space-y-1">
                <label htmlFor="name" className="text-sm font-medium">
                  닉네임
                </label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="리더보드에 표시될 이름"
                  autoComplete="nickname"
                />
              </div>
            )}
            <div className="space-y-1">
              <label htmlFor="email" className="text-sm font-medium">
                이메일
              </label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="password" className="text-sm font-medium">
                비밀번호
              </label>
              <Input
                id="password"
                type="password"
                required
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`${MIN_PASSWORD}자 이상`}
                autoComplete={tab === "signin" ? "current-password" : "new-password"}
              />
            </div>

            {error && <p className="text-sm text-down">{error}</p>}

            <Button type="submit" className="w-full rounded-full font-semibold" disabled={!canSubmit}>
              {busy ? "처리 중…" : tab === "signin" ? "로그인" : "회원가입"}
            </Button>
          </form>
        </Tabs>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            홈으로
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-sm px-4 py-12">
      <Suspense fallback={<div className="h-80 animate-pulse rounded-xl bg-muted" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
