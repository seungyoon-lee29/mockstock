// 종목 로고 다운로드 — shared UNIVERSE 기준, web/public/logos/{market}/{symbol}.png 저장(멱등).
// 실행: npx tsx scripts/logos/fetch-logos.mjs  (shared TS 소스를 직접 임포트하므로 tsx 필요)
// 소스 체인: ① parqet(US 심볼) ② domains.json 도메인 → 구글 s2 파비콘(KR 포함).
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNIVERSE } from "../../shared/src/universe.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "web/public/logos"); // symbol-avatar.tsx symbolLogoSrc()와 동일 포맷
const DOMAINS_PATH = path.join(ROOT, "scripts/logos/domains.json");
const DELAY_MS = 200; // 요청 간 예의 간격
const FETCH_TIMEOUT_MS = 10_000;

const parqetUrl = (symbol) =>
  `https://assets.parqet.com/logos/symbol/${encodeURIComponent(symbol)}?format=png`;
const faviconUrl = (domain) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PNG 매직바이트(89 50 4E 47) + 크기>0 검증 */
const isPng = (buf) =>
  buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

async function fetchPng(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return isPng(buf) ? buf : null;
  } catch {
    return null;
  }
}

const exists = (p) => access(p).then(() => true, () => false);

const domains = JSON.parse(await readFile(DOMAINS_PATH, "utf8"));
const failed = [];
let ok = 0;
let skipped = 0;

for (const e of UNIVERSE) {
  const dest = path.join(OUT_DIR, e.market, `${e.symbol}.png`);
  if (await exists(dest)) {
    skipped += 1;
    continue;
  }

  let buf = e.market === "US" ? await fetchPng(parqetUrl(e.symbol)) : null;
  if (!buf && domains[e.symbol]) buf = await fetchPng(faviconUrl(domains[e.symbol]));

  if (buf) {
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    ok += 1;
  } else {
    failed.push(`${e.market}:${e.symbol} (${e.name})`);
  }
  await sleep(DELAY_MS);
}

console.log(`로고 수급 완료 — 신규 ${ok} / 스킵(기존) ${skipped} / 실패 ${failed.length} (전체 ${UNIVERSE.length})`);
if (failed.length > 0) {
  console.log("실패 종목(폴백 아바타로 표시됨):");
  for (const f of failed) console.log(`  - ${f}`);
}
