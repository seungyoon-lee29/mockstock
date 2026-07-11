// 배치 B 단위 테스트 — TTL 캐시, KIS 콜 예산 컷오프, KIS 응답 매핑, Alpaca 매핑·end 클램프.
// 네트워크 없음: globalThis.fetch를 픽스처로 교체(finally 복원).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache, krDailyRange, krMinuteRange, mergeEntries } from "./backfillRoute";
import { fetchKrDaily, _resetKisRestForTest } from "./kisRest";
import { fetchUsMinutes } from "./alpaca";

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** fetch 교체 헬퍼 — 테스트 본문 실행 후 원복. */
async function withFetch(impl: (url: URL) => Response | Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => impl(new URL(String(input)))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

function setKisEnv(): void {
  process.env.KIS_APP_KEY = "test-key";
  process.env.KIS_APP_SECRET = "test-secret";
  process.env.KIS_REST_RPS = "1000"; // 테스트에서 스로틀 대기 최소화
  _resetKisRestForTest();
}
function clearKisEnv(): void {
  delete process.env.KIS_APP_KEY;
  delete process.env.KIS_APP_SECRET;
  delete process.env.KIS_REST_RPS;
  _resetKisRestForTest();
}

// ── TtlCache ─────────────────────────────────────────────────────────────────
test("TtlCache — 적중·만료·LRU 축출", () => {
  let now = 0;
  const c = new TtlCache<string>(2, () => now);
  c.set("a", "A", 100);
  assert.equal(c.get("a"), "A"); // 적중
  now = 99;
  assert.equal(c.get("a"), "A"); // TTL 직전 적중
  now = 100;
  assert.equal(c.get("a"), undefined); // 만료
  now = 0;
  c.set("a", "A", 1_000);
  c.set("b", "B", 1_000);
  c.get("a"); // a를 최근 사용으로 갱신
  c.set("c", "C", 1_000); // 상한 2 초과 → 가장 오래된 b 축출
  assert.equal(c.get("a"), "A");
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("c"), "C");
});

// ── KIS 분봉 콜 예산 ─────────────────────────────────────────────────────────
/** FHKST03010230 픽스처 — 요청 시각부터 1분씩 과거로 120건(같은 날짜 내). */
function minuteRows(dateYmd: string, hhmmss: string): Record<string, string>[] {
  let hh = Number(hhmmss.slice(0, 2));
  let mm = Number(hhmmss.slice(2, 4));
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < 120; i++) {
    rows.push({
      stck_bsop_date: dateYmd,
      stck_cntg_hour: `${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}00`,
      stck_oprc: "100",
      stck_hgpr: "101",
      stck_lwpr: "99",
      stck_prpr: "100.5",
      cntg_vol: "10",
    });
    mm -= 1;
    if (mm < 0) {
      mm = 59;
      hh -= 1;
    }
  }
  return rows;
}

test("krMinuteRange — 콜 예산 컷오프(부분 응답)·오름차순·중복 없음", async () => {
  setKisEnv();
  let dataCalls = 0;
  try {
    await withFetch(
      (url) => {
        if (url.pathname.endsWith("/oauth2/tokenP")) return jsonRes({ access_token: "tok" });
        dataCalls++;
        return jsonRes({
          rt_cd: "0",
          output2: minuteRows(url.searchParams.get("FID_INPUT_DATE_1")!, url.searchParams.get("FID_INPUT_HOUR_1")!),
        });
      },
      async () => {
        // 2026-07-08(수) 15:30 KST = 06:30 UTC. from은 열흘 전 — 예산 3콜로는 커버 불가.
        const toSec = Date.UTC(2026, 6, 8, 6, 30) / 1_000;
        const fromSec = toSec - 10 * 86_400;
        const out = await krMinuteRange("005930", fromSec, toSec, 3);
        assert.equal(dataCalls, 3); // 예산에서 정확히 끊김
        assert.equal(out.length, 360); // 3콜 × 120건, 중복 없음
        for (let i = 1; i < out.length; i++) assert.ok(out[i].time > out[i - 1].time); // 오름차순
        assert.equal(out[out.length - 1].time, toSec); // 최신(15:30)부터 채우고 오래된 쪽 절단
      },
    );
  } finally {
    clearKisEnv();
  }
});

// ── 캐시 커버 연장 병합 ──────────────────────────────────────────────────────
test("mergeEntries — time/date 중복 제거·오름차순·coveredFromSec 최솟값", () => {
  const c = (time: number) => ({ time, o: 1, h: 1, l: 1, c: 1, v: 1 });
  const merged = mergeEntries(
    { candles: [c(0), c(60)], coveredFromSec: 0 },
    { candles: [c(60), c(120)], coveredFromSec: 60 },
    "1m",
  );
  assert.deepEqual(
    (merged.candles as { time: number }[]).map((x) => x.time),
    [0, 60, 120],
  );
  assert.equal(merged.coveredFromSec, 0);

  const d = (date: string) => ({ date, o: 1, h: 1, l: 1, c: 1, v: 1 });
  const day = mergeEntries(
    { candles: [d("2026-07-01")], coveredFromSec: 100 },
    { candles: [d("2026-07-01"), d("2026-07-02")], coveredFromSec: 200 },
    "day",
  );
  assert.deepEqual(
    (day.candles as { date: string }[]).map((x) => x.date),
    ["2026-07-01", "2026-07-02"],
  );
  assert.equal(day.coveredFromSec, 100);
});

// ── KIS 일봉 매핑 ────────────────────────────────────────────────────────────
test("fetchKrDaily — 역순 응답 → 오름차순 DailyCandle 매핑, 빈 로우 방어", async () => {
  setKisEnv();
  try {
    await withFetch(
      (url) =>
        url.pathname.endsWith("/oauth2/tokenP")
          ? jsonRes({ access_token: "tok" })
          : jsonRes({
              rt_cd: "0",
              output2: [
                { stck_bsop_date: "20260710", stck_clpr: "71000", stck_oprc: "70000", stck_hgpr: "71500", stck_lwpr: "69500", acml_vol: "123456" },
                { stck_bsop_date: "20260709", stck_clpr: "70000", stck_oprc: "69000", stck_hgpr: "70500", stck_lwpr: "68500", acml_vol: "654321" },
                {}, // KIS 빈 로우 패딩 — 무시돼야 함
              ],
            }),
      async () => {
        const out = await fetchKrDaily("005930", "20260709", "20260710");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0], { date: "2026-07-09", o: 69000, h: 70500, l: 68500, c: 70000, v: 654321 });
        assert.deepEqual(out[1], { date: "2026-07-10", o: 70000, h: 71500, l: 69500, c: 71000, v: 123456 });
      },
    );
  } finally {
    clearKisEnv();
  }
});

test("krDailyRange — 100건 미만 페이지(KIS 빈 로우 패딩)에도 조기 종료 없이 계속, 진전 없으면 중단", async () => {
  setKisEnv();
  const dailyRow = (ymd: string) => ({
    stck_bsop_date: ymd,
    stck_oprc: "100",
    stck_hgpr: "110",
    stck_lwpr: "90",
    stck_clpr: "105",
    acml_vol: "1000",
  });
  // 페이지별 로우(항상 100건 미만) — 마지막 페이지는 진전 없음(earliest 불변)으로 종료를 검증.
  const pages: Record<string, string[]> = {
    "20260710": ["20260710", "20260709"],
    "20260708": ["20260708", "20260707"],
    "20260706": ["20260708", "20260707"], // 진전 없음 — 같은 earliest 반복
  };
  let dataCalls = 0;
  try {
    await withFetch(
      (url) => {
        if (url.pathname.endsWith("/oauth2/tokenP")) return jsonRes({ access_token: "tok" });
        dataCalls++;
        const to = url.searchParams.get("FID_INPUT_DATE_2")!;
        return jsonRes({ rt_cd: "0", output2: (pages[to] ?? []).map(dailyRow) });
      },
      async () => {
        const out = await krDailyRange("005930", "2026-07-01", "2026-07-10", 10);
        assert.equal(dataCalls, 3); // 2건짜리 페이지에서 멈추지 않고 계속, 진전 없을 때만 중단
        assert.deepEqual(
          out.map((d) => d.date),
          ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"], // 중복 제거·오름차순
        );
      },
    );
  } finally {
    clearKisEnv();
  }
});

test("fetchKrDaily — 키 부재 시 빈 배열(외부 호출 없음)", async () => {
  clearKisEnv();
  await withFetch(
    () => {
      throw new Error("키 없이 fetch 호출 금지");
    },
    async () => {
      assert.deepEqual(await fetchKrDaily("005930", "20260701", "20260710"), []);
    },
  );
});

// ── Alpaca 매핑·클램프 ───────────────────────────────────────────────────────
test("fetchUsMinutes — bar 매핑(t→epoch초)·end now-16분 클램프·5Min·sort=desc 수신 → 오름차순 복원", async () => {
  process.env.ALPACA_API_KEY_ID = "id";
  process.env.ALPACA_API_SECRET_KEY = "sec";
  const captured: URL[] = [];
  try {
    await withFetch(
      (url) => {
        captured.push(url);
        return jsonRes({
          // sort=desc 계약 — 최신 bar부터 온다(페이지 캡 절단이 오래된 쪽에 걸리게).
          bars: [
            { t: "2026-07-01T13:35:00Z", o: 1.5, h: 3, l: 1, c: 2.5, v: 50 },
            { t: "2026-07-01T13:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
          ],
          next_page_token: null,
        });
      },
      async () => {
        const nowSec = Math.floor(Date.now() / 1_000);
        const out = await fetchUsMinutes("AAPL", 5, nowSec - 3_600, nowSec);
        assert.equal(captured.length, 1);
        const u = captured[0];
        assert.equal(u.searchParams.get("timeframe"), "5Min");
        assert.equal(u.searchParams.get("feed"), "iex");
        assert.equal(u.searchParams.get("sort"), "desc"); // 오래된 쪽 절단 계약
        // end는 now-16분으로 클램프(요청 to=now보다 과거).
        const end = Date.parse(u.searchParams.get("end")!);
        assert.ok(end <= Date.now() - 15 * 60 * 1_000);
        assert.deepEqual(out, [
          { time: Date.parse("2026-07-01T13:30:00Z") / 1_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
          { time: Date.parse("2026-07-01T13:35:00Z") / 1_000, o: 1.5, h: 3, l: 1, c: 2.5, v: 50 },
        ]); // desc 수신 → 오름차순 출력
      },
    );
  } finally {
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
  }
});

test("fetchUsMinutes — 10m은 5Min 수신 후 롤업(네이티브 tf 없음)", async () => {
  process.env.ALPACA_API_KEY_ID = "id";
  process.env.ALPACA_API_SECRET_KEY = "sec";
  try {
    await withFetch(
      (url) => {
        assert.equal(url.searchParams.get("timeframe"), "5Min"); // 10m → 5Min 요청
        return jsonRes({
          // sort=desc 계약 — 최신부터. 롤업 전 오름차순 복원이 전제.
          bars: [
            { t: "2026-07-01T13:35:00Z", o: 1.5, h: 3, l: 1, c: 2.5, v: 50 },
            { t: "2026-07-01T13:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
          ],
          next_page_token: null,
        });
      },
      async () => {
        const base = Date.parse("2026-07-01T13:30:00Z") / 1_000;
        const out = await fetchUsMinutes("AAPL", 10, base - 600, base + 600);
        assert.deepEqual(out, [{ time: base, o: 1, h: 3, l: 0.5, c: 2.5, v: 150 }]); // 10분 버킷 1개
      },
    );
  } finally {
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
  }
});
