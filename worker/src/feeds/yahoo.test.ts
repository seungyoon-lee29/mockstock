// fetchYahooIndexDaily range 폴백 사다리 계약 테스트 — 무거운 range(1y)가 빈 결과면
// 다음으로 가벼운 range(6mo)로 재시도해 그 결과를 쓰는지. 네트워크는 global fetch 스텁으로 대체.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchYahooIndexDaily } from "./yahoo";

test("fetchYahooIndexDaily — 1y가 빈 결과면 6mo로 폴백", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = String((input as URL).href ?? input);
    if (href.includes("range=1y")) {
      // 1y는 결과는 오지만 캔들이 비어있는 상황(프로덕션에서 관측된 실패 양상)을 흉내.
      return new Response(
        JSON.stringify({ chart: { result: [{ timestamp: [], indicators: { quote: [{}] } }] } }),
        { status: 200 },
      );
    }
    if (href.includes("range=6mo")) {
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                timestamp: [1_700_000_000],
                indicators: {
                  quote: [{ open: [100], high: [101], low: [99], close: [100.5], volume: [0] }],
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`예상치 못한 range 호출: ${href}`);
  }) as typeof fetch;
  try {
    const candles = await fetchYahooIndexDaily("^GSPC");
    assert.equal(candles.length, 1);
    assert.equal(candles[0].c, 100.5);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchYahooIndexDaily — 사다리 전부 실패하면 []", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  try {
    assert.deepEqual(await fetchYahooIndexDaily("^GSPC"), []);
  } finally {
    globalThis.fetch = orig;
  }
});
