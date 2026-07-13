#!/usr/bin/env tsx
/**
 * 봇 데이터 전체 삭제 스크립트 — 리더보드/시즌 봇을 초기화한다.
 *
 * ⚠️ 실행 순서 중요: **워커를 재시작해야 봇이 재생성된다.** 봇 재시드(bots.ts seedUsersEach)는
 * in-memory 플래그(seededUsers)로 프로세스당 1회만 돈다 — 워커가 살아있는 채로 이 스크립트를 돌리면
 * DB에선 봇이 사라졌는데 워커는 "이미 시드함"으로 알아 재시드하지 않고, place()가 없는 봇 userId로
 * 주문을 넣어 FK 위반으로 실패한다. 반드시:
 *   1) 워커를 정지(또는 정지 예정)한 상태에서 이 스크립트 실행
 *   2) 워커를 (재)시작 → 부팅 시 seededUsers=false로 시작해 봇을 깨끗이 재시드
 *
 * 실행법:
 *   cd shared && npx tsx --env-file=../worker/.env scripts/reset-bots.ts
 *   # 이어서 워커 재시작
 *
 * ponytail: pg Client 직접 사용(migrate.ts와 동일 --env-file 관용구). FK 안전 순서로
 * is_bot=true 유저에 딸린 모든 행을 삭제하고 마지막에 users를 지운다. 멱등 — 재실행 시 0행.
 * 파괴적(원격 DB) — CI/자동 실행 금지, 수동 전용.
 */
import pg from "pg";

const { Client } = pg;

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("[reset-bots] DATABASE_URL 이 설정되지 않았습니다.");
  process.exit(1);
}

// FK 안전 삭제 순서: 봇 userId를 참조하는 자식 테이블부터 → 마지막에 users.
// (accounts/positions/orders/portfolioSnapshots/seasonResults 모두 users.id FK)
const BOT_IDS = "select id from users where is_bot = true";
const STEPS: { table: string; sql: string }[] = [
  { table: "season_results", sql: `delete from season_results where user_id in (${BOT_IDS})` },
  { table: "portfolio_snapshots", sql: `delete from portfolio_snapshots where user_id in (${BOT_IDS})` },
  { table: "positions", sql: `delete from positions where user_id in (${BOT_IDS})` },
  { table: "orders", sql: `delete from orders where user_id in (${BOT_IDS})` },
  { table: "accounts", sql: `delete from accounts where user_id in (${BOT_IDS})` },
  { table: "users", sql: `delete from users where is_bot = true` },
];

async function main(): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    for (const step of STEPS) {
      const res = await client.query(step.sql);
      console.log(`[reset-bots] ${step.table}: ${res.rowCount ?? 0}행 삭제`);
    }
    await client.query("commit");
    console.log("[reset-bots] 완료 — 봇은 워커 다음 루프에 자동 재생성됩니다.");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[reset-bots] 실패", e);
  process.exit(1);
});
