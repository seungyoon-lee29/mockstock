// 아이디(username) 유효성 — 클라(로그인 폼)·서버(auth.ts username 플러그인) 공용 순수 함수.
// Better Auth 기본([a-zA-Z0-9_.] 3~30)에 더해 **점 위치를 제한**한다: 선행/후행/연속 점은
// 합성 이메일(아이디@id.mockstock.local)의 local-part로 쓰면 이메일 검증기가 거부해(가입 실패) 막는다.
// 밑줄은 이메일 local-part에서 위치 무관 허용이라 제한하지 않는다.
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

export function isValidUsername(u: string): boolean {
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) return false;
  if (!/^[a-zA-Z0-9._]+$/.test(u)) return false; // 허용 문자
  if (u.startsWith(".") || u.endsWith(".")) return false; // 선행/후행 점 → 이메일 무효
  if (u.includes("..")) return false; // 연속 점 → 이메일 무효
  return true;
}
