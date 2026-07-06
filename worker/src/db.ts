// 워커 DB 핸들 — node-postgres(pg) Pool + drizzle. web은 neon-serverless지만 워커는 pg(§8).
// DATABASE_URL 미설정이면 null 반환 → 호출부(cron)가 DB 크론을 통째로 스킵한다
// (키 없는 mock 로컬 데모 npm run dev:worker 가 절대 깨지지 않도록).
//
// §7.7 Neon 보존: 24/7 상시 연결 금지. idleTimeoutMillis 로 유휴 커넥션을 자동 해제해
// 장 마감·유휴 구간에 Neon autosuspend 를 유지한다(크론은 짧은 버스트로만 DB 를 만진다).
// max 를 낮게 둬 동시 커넥션(=CU 가중)도 억제한다.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "./config";

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;
let db: ReturnType<typeof drizzle> | null = null;

/** drizzle 핸들 반환. DATABASE_URL 없으면 null(호출부에서 크론 스킵). */
export function getDb(): ReturnType<typeof drizzle> | null {
  if (!config.databaseUrl) return null;
  if (!db) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 4, idleTimeoutMillis: 10_000 });
    db = drizzle(pool);
  }
  return db;
}

/** 풀 해제(종료 훅용). 유휴 해제는 idleTimeoutMillis 가 담당하므로 상시 호출은 불필요. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
