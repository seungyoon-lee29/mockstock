// 리더보드 순수 로직 단위 테스트 — node:test + tsx, DB·네트워크 없이 실행.
// (실제 DB 쿼리 경로는 키 발급 후 통합 테스트 몫, §10.)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Market } from "@mockstock/shared";
import {
  LEADERBOARD_CACHE_TTL_MS,
  isCacheFresh,
  buildLeaderboard,
  rankParticipants,
  type AccountRow,
  type Participant,
  type PositionRow,
  type ReservedRow,
  type SeasonMetaRow,
} from "./leaderboard";

test("isCacheFresh: TTL 경계", () => {
  assert.equal(isCacheFresh(1000, 1000), true); // 0 경과
  assert.equal(isCacheFresh(1000 + LEADERBOARD_CACHE_TTL_MS - 1, 1000), true);
  assert.equal(isCacheFresh(1000 + LEADERBOARD_CACHE_TTL_MS, 1000), false); // 정확히 TTL이면 만료
  assert.equal(isCacheFresh(1000 + LEADERBOARD_CACHE_TTL_MS + 1, 1000), false);
});

// ── KR 리그 픽스처 ──
const krSeason: SeasonMetaRow = {
  id: "season_kr",
  market: "KR",
  startsAt: new Date("2026-07-06T00:00:00.000Z"),
  endsAt: new Date("2026-07-10T06:30:00.000Z"),
  seedMoney: "10000000.00",
};

// ── US 리그 픽스처 ──
const usSeason: SeasonMetaRow = {
  id: "season_us",
  market: "US",
  startsAt: new Date("2026-07-06T00:00:00.000Z"),
  endsAt: new Date("2026-07-11T21:00:00.000Z"),
  seedMoney: "10000.00", // 네이티브 USD
};

test("buildLeaderboard(KR): 셰이프 + 익명 제외 + 그룹핑 + 기본값", () => {
  const accounts: AccountRow[] = [
    { userId: "u1", name: "앨리스", isBot: false, isAnonymous: false, joinedAt: new Date("2026-07-06T01:00:00.000Z"), cash: "5000000.00" },
    { userId: "bot1", name: "벤치봇", isBot: true, isAnonymous: false, joinedAt: new Date("2026-07-06T00:00:00.000Z"), cash: "9000000.00" },
    { userId: "guest1", name: null, isBot: false, isAnonymous: true, joinedAt: new Date("2026-07-06T02:00:00.000Z"), cash: "10000000.00" },
  ];
  const reserved: ReservedRow[] = [{ userId: "u1", reserved: "1200000.00" }];
  const positions: PositionRow[] = [
    { userId: "u1", market: "KR", symbol: "005930", qty: "10", costBasis: "700000.00" },
    { userId: "u1", market: "KR", symbol: "000660", qty: "5", costBasis: "300000.00" },
    { userId: "bot1", market: "KR", symbol: "000660", qty: "5", costBasis: "500000.00" },
  ];

  const r = buildLeaderboard(krSeason, accounts, reserved, positions);

  // 시즌 메타: market 포함, Date → ISO 문자열, seedMoney 원문 유지
  assert.equal(r.season.market, "KR");
  assert.equal(r.season.startsAt, "2026-07-06T00:00:00.000Z");
  assert.equal(r.season.endsAt, "2026-07-10T06:30:00.000Z");
  assert.equal(r.season.seedMoney, "10000000.00");

  // fxRate 필드 없음
  assert.equal("fxRate" in r, false);

  // 익명(guest1) 제외 → 2명, 봇 포함
  assert.equal(r.participants.length, 2);
  assert.deepEqual(r.participants.map((p) => p.userId).sort(), ["bot1", "u1"]);

  const u1 = r.participants.find((p) => p.userId === "u1")!;
  assert.equal(u1.reserved, "1200000.00");
  assert.equal(u1.positions.length, 2); // 유저별 그룹핑
  assert.equal(u1.joinedAt, "2026-07-06T01:00:00.000Z");

  // reserved 없는 유저는 "0", positions 없으면 그대로 봇은 1건
  const bot1 = r.participants.find((p) => p.userId === "bot1")!;
  assert.equal(bot1.reserved, "0");
  assert.equal(bot1.isBot, true);
  assert.equal(bot1.positions.length, 1);
});

test("buildLeaderboard(US): US 시즌 market·seedMoney", () => {
  const accounts: AccountRow[] = [
    { userId: "u1", name: "칼", isBot: false, isAnonymous: false, joinedAt: new Date("2026-07-06T00:00:00.000Z"), cash: "5000.00" },
  ];
  const r = buildLeaderboard(usSeason, accounts, [], []);
  assert.equal(r.season.market, "US");
  assert.equal(r.season.seedMoney, "10000.00");
  assert.equal(r.participants[0].cash, "5000.00");
});

test("rankParticipants(KR): 평가·정렬·시세 미도착 폴백", () => {
  const parts: Participant[] = [
    // 현금 300만 + 삼성전자 10주(현재가 80만 → 800만) = 1,100만 → +10%
    { userId: "u1", name: "앨리스", isBot: false, joinedAt: "", cash: "3000000.00", reserved: "0", positions: [{ market: "KR", symbol: "005930", qty: "10", costBasis: "7000000.00" }] },
    // 현금 1,000만, 보유 없음 = 1,000만 → 0%
    { userId: "u2", name: "밥", isBot: false, joinedAt: "", cash: "10000000.00", reserved: "0", positions: [] },
    // 현금 500만 + AAPL(시세 미도착 → 취득원가 60만 폴백) = 560만 → -44%
    { userId: "bot1", name: "벤치봇", isBot: true, joinedAt: "", cash: "5000000.00", reserved: "0", positions: [{ market: "US", symbol: "AAPL", qty: "2", costBasis: "600000.00" }] },
  ];
  const priceOf = (m: Market, s: string) => (m === "KR" && s === "005930" ? 800000 : undefined);
  const r = rankParticipants(parts, 10_000_000, priceOf);

  assert.deepEqual(r.map((x) => x.userId), ["u1", "u2", "bot1"]); // 수익률 내림차순
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3]);
  assert.equal(r[0].returnAbs, 1_000_000);
  assert.equal(Math.round(r[0].returnPct), 10);
  assert.equal(r[1].returnPct, 0);
  const bot = r.find((x) => x.userId === "bot1")!;
  assert.equal(bot.totalValue, 5_600_000); // 시세 미도착 보유는 취득원가로 평가
  assert.equal(bot.isBot, true);
});

test("rankParticipants(US): US 보유 네이티브 USD 평가 — 환산 없음", () => {
  // US 시즌: seed=$10,000, AAPL 10주 × $200 = $2,000 보유, 현금 $0
  const parts: Participant[] = [
    { userId: "u1", name: "칼", isBot: false, joinedAt: "", cash: "0", reserved: "0", positions: [{ market: "US", symbol: "AAPL", qty: "10", costBasis: "0" }] },
  ];
  // 환산 없이 qty*price = 10*200 = 2,000
  const r = rankParticipants(parts, 10_000, () => 200);
  assert.equal(r[0].totalValue, 2_000); // USD 네이티브, 환산 없음
  assert.equal(r[0].returnAbs, -8_000); // 2000 - 10000
  assert.equal(Math.round(r[0].returnPct), -80);
});

test("rankParticipants: seed 0 방어", () => {
  const parts: Participant[] = [
    { userId: "u1", name: "칼", isBot: false, joinedAt: "", cash: "0", reserved: "0", positions: [] },
  ];
  const r = rankParticipants(parts, 0, () => undefined);
  assert.equal(r[0].returnPct, 0); // seed 0 → 0으로 방어(0 나눗셈 없음)
});

test("buildLeaderboard: reserved null → '0', 포지션 0건 → []", () => {
  const accounts: AccountRow[] = [
    { userId: "u1", name: "밥", isBot: false, isAnonymous: false, joinedAt: new Date("2026-07-06T00:00:00.000Z"), cash: "10000000.00" },
  ];
  const r = buildLeaderboard(krSeason, accounts, [{ userId: "u1", reserved: null }], []);
  assert.equal(r.participants[0].reserved, "0");
  assert.deepEqual(r.participants[0].positions, []);
});
