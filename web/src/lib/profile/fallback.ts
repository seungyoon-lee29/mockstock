// 규칙 기반 간이 분석(§D8 폴백) — API 키 부재·익명 유저·일일 상한 초과 시 LLM 대신 사용.
// 공격성(회전율)·분산(보유·집중도)·주문 스타일(지정가율)·성과(실현손익·MDD) 조합으로
// 자연스러운 한국어 3~5문장 + 태그 3~5개를 만든다. aiGenerated=false(model NULL) 경로.
import type { ProfileStats } from "./stats";

export interface ProfileText {
  summary: string;
  traits: string[];
}

// 구간 경계 — 폴백 문장 선택용 휴리스틱(게임 규칙 아님, 이 모듈 로컬).
const TURNOVER_HIGH = 2; // 시드 대비 2배 이상 회전 = 공격적
const TURNOVER_LOW = 0.5;
const CONCENTRATION_HIGH_PCT = 40;
const DIVERSIFIED_MIN_HOLDINGS = 5;
const LIMIT_PREF_RATIO = 0.5;
const CASH_HEAVY_PCT = 50;
const ALL_IN_PCT = 10;
const MDD_HIGH_PCT = 10;

export function buildRuleProfile(stats: ProfileStats): ProfileText {
  const sentences: string[] = [];
  const traits: string[] = [];

  // 1) 매매 활동량(회전율 = 공격성)
  if (stats.turnover >= TURNOVER_HIGH) {
    sentences.push(
      `이번 시즌 ${stats.tradeCount}번 체결하며 시드머니의 ${stats.turnover.toFixed(1)}배를 회전시킨 공격적인 트레이더예요.`,
    );
    traits.push("적극 매매");
  } else if (stats.turnover <= TURNOVER_LOW) {
    sentences.push(
      `이번 시즌 체결 ${stats.tradeCount}건, 회전율 ${stats.turnover.toFixed(1)}배로 신중하게 매매하는 편이에요.`,
    );
    traits.push("신중한 매매");
  } else {
    sentences.push(
      `이번 시즌 ${stats.tradeCount}번 체결하며 무리하지 않는 페이스로 매매하고 있어요.`,
    );
    traits.push("꾸준한 매매");
  }

  // 2) 분산 vs 집중
  if (stats.holdingCount === 0) {
    sentences.push("지금은 보유 종목 없이 전액 현금으로 다음 기회를 노리고 있어요.");
    traits.push("현금 대기");
  } else if (stats.maxConcentrationPct >= CONCENTRATION_HIGH_PCT) {
    sentences.push(
      `보유 종목 ${stats.holdingCount}개 중 한 종목에 자산의 ${Math.round(stats.maxConcentrationPct)}%를 실은 집중 투자 스타일이에요.`,
    );
    traits.push("집중 투자");
  } else if (stats.holdingCount >= DIVERSIFIED_MIN_HOLDINGS) {
    sentences.push(
      `${stats.holdingCount}개 종목에 고르게 나눠 담아 리스크를 분산하는 스타일이에요.`,
    );
    traits.push("분산 투자");
  } else {
    sentences.push(
      `${stats.holdingCount}개 종목을 균형 있게 담아 안정감을 챙기고 있어요.`,
    );
    traits.push("균형 포트폴리오");
  }

  // 3) 주문 스타일(지정가 사용률)
  if (stats.limitRatio >= LIMIT_PREF_RATIO) {
    sentences.push(
      `주문의 ${Math.round(stats.limitRatio * 100)}%를 지정가로 걸어 원하는 가격을 기다릴 줄 알아요.`,
    );
    traits.push("지정가 선호");
  } else {
    sentences.push("대부분 시장가로 바로 체결하는 속도 중시형이에요.");
    traits.push("시장가 위주");
  }

  // 4) 성과(실현손익 = 승률 대용 지표) — 실현 이력이 있을 때만 언급
  if (stats.realizedPnlPct > 0) {
    sentences.push(
      `실현손익은 시드 대비 +${stats.realizedPnlPct.toFixed(1)}%로 수익을 챙기는 감각도 보여줬어요.`,
    );
    traits.push("수익 실현형");
  } else if (stats.realizedPnlPct < 0) {
    sentences.push(
      `실현손익은 시드 대비 ${stats.realizedPnlPct.toFixed(1)}%지만, 손절도 전략의 일부죠.`,
    );
    traits.push("과감한 손절");
  }

  // 5) 리스크(MDD·현금 비중) — 태그가 3개 미만이면 여기서 보충
  if (stats.mddPct >= MDD_HIGH_PCT) {
    if (sentences.length < 5)
      sentences.push(`최대 낙폭 ${stats.mddPct.toFixed(1)}%의 굴곡도 견뎌냈어요.`);
    traits.push("변동성 감내");
  } else if (stats.cashRatioPct >= CASH_HEAVY_PCT) {
    traits.push("현금 지킴이");
  } else if (stats.cashRatioPct <= ALL_IN_PCT && stats.holdingCount > 0) {
    traits.push("풀매수 스타일");
  }
  if (traits.length < 3) traits.push("마이페이스");

  return { summary: sentences.slice(0, 5).join(" "), traits: [...new Set(traits)].slice(0, 5) };
}
