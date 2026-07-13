"use client";

// 헤더 우측 세션 위젯. 비로그인 → 게스트(anonymous) 시작 버튼, 로그인 → 닉네임 + 로그아웃.
// authClient.useSession()이 signIn/signOut 후 자동 갱신하므로 별도 상태 동기화 불필요.
import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SessionWidget() {
  const { data, isPending } = authClient.useSession();
  const [busy, setBusy] = useState(false);

  if (isPending) {
    // 세션 확인 중 레이아웃 시프트 방지용 자리표시.
    return (
      <div
        className="h-8 w-24 animate-pulse rounded-full bg-muted"
        aria-hidden
      />
    );
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="rounded-full font-semibold">
          <Link href="/login">로그인</Link>
        </Button>
        <Button
          size="sm"
          className="rounded-full font-semibold"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await authClient.signIn.anonymous();
            } finally {
              setBusy(false);
            }
          }}
        >
          게스트로 시작
        </Button>
      </div>
    );
  }

  const name = data.user.name?.trim() || "게스트";
  return (
    <div className="flex items-center gap-2">
      <span
        className="max-w-[9rem] truncate text-sm font-medium"
        title={name}
      >
        {name}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await authClient.signOut();
          } finally {
            setBusy(false);
          }
        }}
      >
        로그아웃
      </Button>
    </div>
  );
}
