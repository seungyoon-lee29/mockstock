"use client";

// 아이디(username)+비밀번호 로그인·회원가입 화면(이메일·구글 OAuth 없이 로컬에서도 동작).
// Better Auth username 플러그인: 로그인은 signIn.username. 가입은 코어 email/password 경로라
// 이메일이 필요 → 아이디로 합성 이메일(아이디@id.local)을 만들어 전달(사용자에겐 아이디만 노출).
// 성공 시 callbackURL(소셜 로그인과 동일 관용구)로 복귀, 없으면 홈.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isValidUsername, USERNAME_MIN } from "@/lib/username";

const MIN_PASSWORD = 8; // auth.ts emailAndPassword.minPasswordLength와 동일 정책.
const USERNAME_HINT = "아이디는 3~30자 영문·숫자·_·. (점은 처음/끝/연속 불가)";
// 아이디 → 내부 합성 이메일. 정규화(소문자)는 플러그인과 동일 규칙 → 유니크 정합. 라우팅 불가 TLD(.local).
const synthEmail = (u: string) => `${u.trim().toLowerCase()}@id.mockstock.local`;

/** Better Auth 에러 코드 → 한국어 메시지. 미매핑은 원문 폴백(빈 값이면 일반 문구). */
function authErrorMessage(err: { code?: string; message?: string } | null): string {
  switch (err?.code) {
    case "INVALID_USERNAME_OR_PASSWORD":
      return "아이디 또는 비밀번호가 올바르지 않습니다.";
    case "USERNAME_IS_ALREADY_TAKEN":
      return "이미 사용 중인 아이디입니다. 다른 아이디를 써 주세요.";
    case "USERNAME_TOO_SHORT":
    case "USERNAME_TOO_LONG":
    case "INVALID_USERNAME":
      return USERNAME_HINT;
    case "PASSWORD_TOO_SHORT":
      return `비밀번호는 최소 ${MIN_PASSWORD}자 이상이어야 합니다.`;
    default:
      return err?.message || "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

/**
 * 오픈 리다이렉트 가드 — 같은 오리진만 허용. location.origin 기준으로 파싱해 origin을 비교하면
 * 절대 URL·프로토콜상대("//")·백슬래시·퍼센트인코딩 제어문자 우회를 한 번에 차단한다(codex 리뷰 2차).
 * 반환은 경로+쿼리+해시만(오리진 제거). window 없으면(SSR) 안전 폴백 "/".
 */
function safeCallback(raw: string | null): string {
  if (!raw || typeof window === "undefined") return "/";
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const callbackURL = safeCallback(search.get("callbackURL"));

  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
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
    if (tab === "signup" && !isValidUsername(username.trim())) {
      setError(USERNAME_HINT);
      return;
    }
    setBusy(true);
    try {
      const uname = username.trim();
      const res =
        tab === "signin"
          ? await authClient.signIn.username({ username: uname, password })
          : await authClient.signUp.email({
              // 아이디만 노출 — 이메일은 내부 유니크 키(합성), name은 리더보드 표시용.
              email: synthEmail(uname),
              password,
              name: name.trim() || uname,
              username: uname,
            });
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

  const canSubmit = username.trim().length >= USERNAME_MIN && password.length >= MIN_PASSWORD && !busy;

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
            <div className="space-y-1">
              <label htmlFor="username" className="text-sm font-medium">
                아이디
              </label>
              <Input
                id="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="영문·숫자 3~30자"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            {tab === "signup" && (
              <div className="space-y-1">
                <label htmlFor="name" className="text-sm font-medium">
                  닉네임 <span className="text-muted-foreground">(선택)</span>
                </label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="리더보드 표시 이름 (미입력 시 아이디)"
                  autoComplete="nickname"
                />
              </div>
            )}
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
