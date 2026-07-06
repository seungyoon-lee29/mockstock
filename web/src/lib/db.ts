// web 도메인 DB 핸들 (T04). drizzle + neon-serverless(WebSocket Pool — 트랜잭션 지원, PRD §8).
// DATABASE_URL은 런타임 lazy 접근 — 첫 getDb() 호출 시에만 읽어 빌드 타임 평가·연결이 없다.
// (auth.ts의 Better Auth 어댑터 Pool과는 별개 관심사라 각자 lazy Pool을 둔다.)
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";

let db: ReturnType<typeof drizzle> | undefined;

export function getDb() {
  if (!db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL 미설정 — 주문 API는 DB 연결이 필요합니다.");
    }
    // Pool 생성만으로는 커넥션을 열지 않고 첫 쿼리 시 lazy 연결.
    db = drizzle(new Pool({ connectionString }));
  }
  return db;
}
