// 인덱스 폴러 계약 테스트 — 키 없는 모드가 throw 없이 빈 결과를 내는지(핵심 계약) +
// 실 응답 파싱이 IndexQuote로 옳게 매핑되는지. 네트워크는 global fetch 스텁으로 대체.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INDICES } from "@mockstock/shared";
import { fetchKrIndex } from "./candles/kisRest";
import { fetchFinnhubQuote } from "./feeds/finnhub";
import { getIndices } from "./indices";

test("shared INDICES — 코스피·코스닥·S&P 500·나스닥 정의", () => {
  // KR 키는 Yahoo 심볼 스템(^KS11/^KQ11) — KIS 업종지수 코드(0001/1001)에서 전환됨.
  assert.deepEqual(INDICES.KR.map((d) => d.key), ["KS11", "KQ11"]);
  assert.deepEqual(INDICES.US.map((d) => d.label), ["S&P 500", "나스닥"]);
});

test("키 없음 — fetchKrIndex/fetchFinnhubQuote 는 throw 없이 null", async () => {
  delete process.env.KIS_APP_KEY;
  delete process.env.KIS_APP_SECRET;
  delete process.env.FINNHUB_API_KEY;
  assert.equal(await fetchKrIndex("0001"), null);
  assert.equal(await fetchFinnhubQuote("SPY"), null);
});

test("getIndices — 폴 전 초기값은 빈 배열(UI '—' 계약)", () => {
  const p = getIndices();
  assert.deepEqual(p, { KR: [], US: [] });
});

test("fetchFinnhubQuote — 실 응답(c/d/dp) 파싱", async () => {
  process.env.FINNHUB_API_KEY = "test-key";
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ c: 512.3, d: -1.7, dp: -0.33 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const q = await fetchFinnhubQuote("SPY");
    assert.deepEqual(q, { value: 512.3, change: -1.7, changePct: -0.33 });
  } finally {
    globalThis.fetch = orig;
    delete process.env.FINNHUB_API_KEY;
  }
});

test("fetchFinnhubQuote — c=0(데이터 없음)은 null", async () => {
  process.env.FINNHUB_API_KEY = "test-key";
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ c: 0, d: 0, dp: 0 }), { status: 200 })) as typeof fetch;
  try {
    assert.equal(await fetchFinnhubQuote("SPY"), null);
  } finally {
    globalThis.fetch = orig;
    delete process.env.FINNHUB_API_KEY;
  }
});

test("fetchKrIndex — 업종지수 응답(output) 파싱", async () => {
  process.env.KIS_APP_KEY = "k";
  process.env.KIS_APP_SECRET = "s";
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = String((input as URL).href ?? input);
    if (href.includes("/oauth2/tokenP")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        rt_cd: "0",
        output: { bstp_nmix_prpr: "2650.12", bstp_nmix_prdy_vrss: "12.34", bstp_nmix_prdy_ctrt: "0.47" },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const q = await fetchKrIndex("0001");
    assert.deepEqual(q, { value: 2650.12, change: 12.34, changePct: 0.47 });
  } finally {
    globalThis.fetch = orig;
    delete process.env.KIS_APP_KEY;
    delete process.env.KIS_APP_SECRET;
  }
});
