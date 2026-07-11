// AI 투자 성향 통계(§D9)·해시·규칙 폴백 단위 테스트 — node:test + tsx, DB·네트워크 없음.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProfileStats, hashProfileInput, type FilledOrderRow } from "./stats";
import { buildRuleProfile } from "./fallback";
import { parseProfileText } from "./generate";

const SEED = "10000000.00"; // KR 시드 ₩10,000,000

test("computeProfileStats: 빈 데이터 → 전부 0, NaN 없음", () => {
  const s = computeProfileStats({
    seedMoney: SEED,
    cash: null,
    orders: [],
    positions: [],
    snapshots: [],
  });
  assert.deepEqual(s, {
    tradeCount: 0,
    buyRatio: 0,
    limitRatio: 0,
    turnover: 0,
    holdingCount: 0,
    maxConcentrationPct: 0,
    realizedPnlPct: 0,
    cashRatioPct: 100, // 계좌 미생성 = 시드 전액 현금
    mddPct: 0,
  });
  for (const v of Object.values(s)) assert.ok(Number.isFinite(v));
});

test("computeProfileStats: 전형 케이스 — 9개 수치 전부 검증", () => {
  const orders: FilledOrderRow[] = [
    // 매수 3(지정가 2) + 매도 1(시장가) = 체결대금 100만+100만+200만+150만 = 550만
    { symbol: "005930", side: "buy", type: "limit", qty: "10", filledPrice: "100000.00" },
    { symbol: "005930", side: "buy", type: "limit", qty: "10", filledPrice: "100000.00" },
    { symbol: "000660", side: "buy", type: "market", qty: "10", filledPrice: "200000.00" },
    { symbol: "005930", side: "sell", type: "market", qty: "15", filledPrice: "100000.00" },
  ];
  const s = computeProfileStats({
    seedMoney: SEED,
    cash: "4000000.00",
    orders,
    positions: [
      // qty>0 두 종목(원가 50만/200만) + 전량 매도 잔여 로우(realized만 기여)
      { symbol: "005930", qty: "5", costBasis: "500000.00", realizedPnl: "100000.00" },
      { symbol: "000660", qty: "10", costBasis: "2000000.00", realizedPnl: "0" },
      { symbol: "035420", qty: "0", costBasis: "0", realizedPnl: "-50000.00" },
    ],
    snapshots: [
      { totalValue: "10000000.00" },
      { totalValue: "11000000.00" }, // 피크
      { totalValue: "9900000.00" }, // 피크 대비 -10%
      { totalValue: "10500000.00" },
    ],
  });
  assert.equal(s.tradeCount, 4);
  assert.equal(s.buyRatio, 0.75); // 매수 3/4
  assert.equal(s.limitRatio, 0.5); // 지정가 2/4
  assert.equal(s.turnover, 0.55); // 550만 / 1000만
  assert.equal(s.holdingCount, 2); // qty>0만
  // 기준자산 = 현금 400만 + 원가 250만 = 650만 → 최대 종목 200만 = 30.77%
  assert.equal(s.maxConcentrationPct, 30.77);
  assert.equal(s.realizedPnlPct, 0.5); // (10만 - 5만) / 1000만
  assert.equal(s.cashRatioPct, 61.54); // 400만 / 650만
  assert.equal(s.mddPct, 10); // 1100만 → 990만
});

test("computeProfileStats: 음수 실현손익·소수 수량 센트 계산", () => {
  const s = computeProfileStats({
    seedMoney: "10000.00", // US 시드 $10,000
    cash: "9000.00",
    orders: [
      { symbol: "AAPL", side: "buy", type: "market", qty: "0.5", filledPrice: "230.50" },
    ],
    positions: [{ symbol: "AAPL", qty: "0.5", costBasis: "115.25", realizedPnl: "-25.50" }],
    snapshots: [],
  });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.turnover, 0.01); // $115.25 / $10,000 ≈ 0.01
  assert.equal(s.realizedPnlPct, -0.25); // -25.50/10000 = -0.255 → 소수 2자리 반올림
});

test("hashProfileInput: 결정적 + 통계·심볼 변화에 반응", () => {
  const base = computeProfileStats({
    seedMoney: SEED,
    cash: "5000000.00",
    orders: [],
    positions: [],
    snapshots: [],
  });
  const h1 = hashProfileInput(base, ["005930", "000660"]);
  const h2 = hashProfileInput(base, ["000660", "005930"]); // 정렬 → 순서 무관
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const h3 = hashProfileInput({ ...base, tradeCount: 1 }, ["005930", "000660"]);
  assert.notEqual(h1, h3);
  const h4 = hashProfileInput(base, ["005930"]);
  assert.notEqual(h1, h4);
});

test("buildRuleProfile: 빈 통계에서도 3~5문장·3~5태그", () => {
  const s = computeProfileStats({
    seedMoney: SEED,
    cash: null,
    orders: [],
    positions: [],
    snapshots: [],
  });
  const p = buildRuleProfile(s);
  assert.ok(p.summary.length > 0);
  // 폴백 문장은 전부 "~요."로 끝난다 — 문장 수 3~5 검증
  const sentences = (p.summary.match(/요\./g) ?? []).length;
  assert.ok(sentences >= 3 && sentences <= 5, `문장 수 ${sentences}`);
  assert.ok(p.traits.length >= 3 && p.traits.length <= 5, `태그 수 ${p.traits.length}`);
});

test("buildRuleProfile: 공격적·집중 투자 통계 → 해당 태그 반영", () => {
  const p = buildRuleProfile({
    tradeCount: 40,
    buyRatio: 0.6,
    limitRatio: 0.7,
    turnover: 3.2,
    holdingCount: 2,
    maxConcentrationPct: 65,
    realizedPnlPct: 4.2,
    cashRatioPct: 5,
    mddPct: 12,
  });
  assert.ok(p.traits.includes("적극 매매"));
  assert.ok(p.traits.includes("집중 투자"));
  assert.ok(p.traits.includes("지정가 선호"));
  assert.ok(p.traits.length <= 5);
  assert.match(p.summary, /40번 체결/);
});

test("parseProfileText: 코드펜스 허용 + 셰이프 검증", () => {
  const ok = parseProfileText('```json\n{"summary":"신중한 스타일이에요.","traits":["신중","분산 투자","현금 지킴이"]}\n```');
  assert.equal(ok.summary, "신중한 스타일이에요.");
  assert.deepEqual(ok.traits, ["신중", "분산 투자", "현금 지킴이"]);
  assert.throws(() => parseProfileText('{"summary":""}'));
  assert.throws(() => parseProfileText('{"summary":"a","traits":"not-array"}'));
  assert.throws(() => parseProfileText("그냥 텍스트"));
});
