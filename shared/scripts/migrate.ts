#!/usr/bin/env tsx
/**
 * db:migrate 래퍼 — 프로덕션 URL 실수 방지 안전장치.
 * ponytail: 가드 + drizzle-kit 위임, 다른 기능 없음.
 *
 * 규칙:
 *   - DATABASE_URL 이 localhost / 127.0.0.1 이 아니면 프로덕션으로 판정.
 *   - 프로덕션 대상이면 ALLOW_PROD_MIGRATE=1 이 없을 때 종료 코드 1로 중단.
 */
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL ?? "";
const isLocal = /localhost|127\.0\.0\.1/.test(url);
const allowProd = process.env.ALLOW_PROD_MIGRATE === "1";

if (!url) {
  console.error("[migrate] DATABASE_URL 이 설정되지 않았습니다.");
  process.exit(1);
}

if (!isLocal && !allowProd) {
  console.error(
    "[migrate] 프로덕션 DB 감지 — 안전장치 작동.\n" +
      "  이력 폐기(0003) 포함 마이그레이션입니다. 의도가 맞다면:\n" +
      "  ALLOW_PROD_MIGRATE=1 npm run db:migrate -w shared",
  );
  process.exit(1);
}

if (!isLocal) {
  console.log("[migrate] ALLOW_PROD_MIGRATE=1 확인 — 프로덕션 마이그레이션 실행.");
}

try {
  execSync("drizzle-kit migrate", { stdio: "inherit" });
} catch (e: any) {
  process.exit(e.status ?? 1);
}
