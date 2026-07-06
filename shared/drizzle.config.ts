// drizzle-kit 설정 — 마이그레이션 생성/적용의 단일 소스.
// db:generate 는 DB 없이 스키마→SQL 생성. db:migrate 는 적용이라 DATABASE_URL 필요
// (env: DATABASE_URL="postgres://…"). 로컬 적용 예: DATABASE_URL=… npm run db:migrate -w shared.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
