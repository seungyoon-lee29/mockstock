// 분봉 수집·저장 파이프라인(P3-①) — 라이브 틱 → 심볼별 1분봉 → minute_candles 배치 영속화.
// 과거 분봉은 합법 소스로 못 구하므로(ADR-0003) 지금부터 축적하는 유일한 경로.
//
// 게이트 3종:
//  - B4 mock 제외: source==='mock' 틱은 영속화 안 함(로컬 데모 오염 방지).
//  - B5 시장시간: 정규장 외 틱 폐기(isMarketOpen, 틱 ts 기준).
//  - B13 Neon 보존: DB write는 getDb() 존재 + 개장 중일 때만. 유휴엔 미접촉(autosuspend 유지).
// 틱마다 write 금지 — 완성 분봉을 버퍼에 모아 주기(기본 30초)·상한(기본 500) flush.
import { MinuteAggregator, keyOf, type IntradayCandle, type Market, type Tick } from "@mockstock/shared";
import { isMarketOpen } from "@mockstock/shared/calendar";
import { minuteCandles } from "@mockstock/shared/schema";
import { getDb } from "./db";

const FLUSH_INTERVAL_MS = Number(process.env.MINUTE_CANDLE_FLUSH_MS ?? 30_000);
const FLUSH_MAX_BUFFER = Number(process.env.MINUTE_CANDLE_FLUSH_MAX ?? 500);

type PendingRow = typeof minuteCandles.$inferInsert;

function toRow(market: Market, symbol: string, c: IntradayCandle): PendingRow {
  return {
    market,
    symbol,
    ts: new Date(c.time * 1000), // c.time=epoch초(분 버킷 시작)
    o: c.o.toFixed(2), // numeric(18,2) — 문자열로(float 금지, db.md)
    h: c.h.toFixed(2),
    l: c.l.toFixed(2),
    c: c.c.toFixed(2),
    v: String(c.v), // numeric(20,0) — 틱 수(정수)
  };
}

export class CandleAggregator {
  private aggs = new Map<string, MinuteAggregator>();
  private meta = new Map<string, { market: Market; symbol: string }>();
  private buffer: PendingRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 관찰용(테스트) — flush 대기 중 완성 분봉 수. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** 주기 flush 타이머 기동. getDb null(mock 로컬)이면 flush가 조용히 no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.(); // 타이머가 프로세스 종료를 막지 않게(종료는 stop()이 담당)
  }

  /** 틱 탭 — 게이트 통과분만 심볼별 버킷에 반영, 완성 분봉은 버퍼 적재. */
  add(tick: Tick): void {
    if (tick.source === "mock") return; // B4
    if (!isMarketOpen(tick.market, new Date(tick.ts))) return; // B5
    const key = keyOf(tick.market, tick.symbol);
    let agg = this.aggs.get(key);
    if (!agg) {
      agg = new MinuteAggregator();
      this.aggs.set(key, agg);
      this.meta.set(key, { market: tick.market, symbol: tick.symbol });
    }
    const done = agg.add(tick);
    if (done) {
      this.buffer.push(toRow(tick.market, tick.symbol, done));
      if (this.buffer.length >= FLUSH_MAX_BUFFER) void this.flush();
    }
  }

  /** 버퍼 배치 write. getDb 있고 개장 중일 때만(B13). 실패분은 상한 내 재시도 큐. */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const db = getDb();
    if (!db) return; // DATABASE_URL 없음(mock 로컬) — no-op
    // B13: 장 마감·유휴엔 DB 미접촉. 버퍼는 개장 틱만 담기지만 flush 시점에도 재확인.
    // ponytail: 마감 직후 버퍼에 남은 완성 분봉은 여기서 유실이 아니라 다음 개장 flush로 지연 영속화(B13이 off-hours write를 금지).
    if (!isMarketOpen("KR", new Date()) && !isMarketOpen("US", new Date())) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await db.insert(minuteCandles).values(rows).onConflictDoNothing(); // PK(market,symbol,ts) 중복 무시
    } catch (e) {
      console.error("[aggregator] 분봉 flush 실패", e);
      if (this.buffer.length < FLUSH_MAX_BUFFER) this.buffer.unshift(...rows); // 다음 주기 재시도
    }
  }

  /** 종료 훅 — 타이머 정지 후 진행중 버킷 방출(개장 중 심볼만) + 마지막 flush(insert 완료까지 await). */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const now = new Date();
    for (const [key, agg] of this.aggs) {
      const m = this.meta.get(key);
      const done = agg.flush();
      // ponytail: 장 마감 후엔 마지막 분봉을 버림(B13 유휴 write 금지). 세션 마지막 1분 손실은 v1 허용.
      if (done && m && isMarketOpen(m.market, now)) this.buffer.push(toRow(m.market, m.symbol, done));
    }
    // 완성 분봉 버퍼 insert 완료까지 대기 — 배포(SIGTERM) 시 fire-and-forget 유실 방지.
    return this.flush();
  }
}
