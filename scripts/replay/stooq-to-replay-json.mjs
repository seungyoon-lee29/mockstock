#!/usr/bin/env node
// Stooq 일봉 CSV → 리플레이 JSON 변환기 (covid-2020 시나리오)
//
// 사용법:
//   node scripts/replay/stooq-to-replay-json.mjs <inputDir> [outputDir]
//   node scripts/replay/stooq-to-replay-json.mjs --selftest
//
// inputDir 의 <SYMBOL>.csv 를 전부 읽어 outputDir/<SYMBOL>.json 으로 변환한다.
// outputDir 기본값은 web/public/replay/covid-2020/ (dataPeriod 등은 그 안의 manifest.json 에서 읽음).
// fail-closed: 검증 실패 심볼은 쓰지 않고 리포트에만 남긴다. 전부 통과해야 manifest.source 를 갱신한다.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const DEFAULT_OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'web', 'public', 'replay', 'covid-2020',
);
const OHLCV = ['o', 'h', 'l', 'c', 'v'];

// Stooq CSV(헤더 "Date,Open,High,Low,Close,Volume") → [{date,o,h,l,c,v}, ...].
// 빈 값·NaN·열 부족 행은 throw (fail-closed: 나쁜 데이터로 리플레이 오염 금지).
export function parseStooqCsv(text, symbol = '') {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error(`${symbol}: 데이터 행 없음`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) throw new Error(`${symbol} L${i + 1}: 열 부족 → ${lines[i]}`);
    const [date, o, h, l, c, v] = cols;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${symbol} L${i + 1}: 날짜 형식 오류 → ${date}`);
    // 빈 값 방어: Number('')===0 이라 명시 체크 필요.
    for (const [k, s] of Object.entries({ o, h, l, c, v })) {
      if (s === undefined || s.trim() === '') throw new Error(`${symbol} L${i + 1}: ${k} 빈 값`);
    }
    const row = { date, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: parseInt(v, 10) };
    for (const k of OHLCV) {
      if (!Number.isFinite(row[k])) throw new Error(`${symbol} L${i + 1}: ${k} 숫자 아님 → ${lines[i]}`);
    }
    rows.push(row);
  }
  return rows;
}

// 반환: { reasons:[거부 사유], warnings:[경고] }. reasons 비어있으면 통과.
export function validate(rows, { dataStart, dataEnd, existingCount }) {
  const reasons = [];
  const warnings = [];
  if (rows.length === 0) reasons.push('행 없음');

  // (a) 기존 JSON 대비 행수: ±5 초과=경고, ±20 초과=거부.
  if (existingCount != null) {
    const diff = Math.abs(rows.length - existingCount);
    if (diff > 20) reasons.push(`행수 차이 ${diff} (>20 거부, 신규 ${rows.length} vs 기존 ${existingCount})`);
    else if (diff > 5) warnings.push(`행수 차이 ${diff} (>5 경고, 신규 ${rows.length} vs 기존 ${existingCount})`);
  }

  let prev = null;
  for (const r of rows) {
    // (b) manifest.dataPeriod 범위 안
    if (r.date < dataStart || r.date > dataEnd) reasons.push(`${r.date}: dataPeriod(${dataStart}~${dataEnd}) 벗어남`);
    // (c) 단조 오름차순·중복 없음
    if (prev != null && r.date <= prev) reasons.push(`${r.date}: 날짜 비단조/중복 (이전 ${prev})`);
    prev = r.date;
    // (d) sanity
    if (!(r.o > 0 && r.h > 0 && r.l > 0 && r.c > 0)) reasons.push(`${r.date}: OHLC>0 위반 (o${r.o} h${r.h} l${r.l} c${r.c})`);
    if (!(r.l <= r.o && r.l <= r.c && r.l <= r.h && r.o <= r.h && r.c <= r.h)) reasons.push(`${r.date}: OHLC 관계 위반 (o${r.o} h${r.h} l${r.l} c${r.c})`);
    if (!(r.v >= 0)) reasons.push(`${r.date}: 거래량 음수 (${r.v})`);
  }
  return { reasons, warnings };
}

function abbrev(list, n = 3) {
  return list.length <= n ? list.join('; ') : `${list.slice(0, n).join('; ')} … (+${list.length - n})`;
}

function convertDir(inputDir, outputDir) {
  const manifestPath = join(outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`manifest 없음: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dataStart = manifest.dataPeriod?.start;
  const dataEnd = manifest.dataPeriod?.end;
  if (!dataStart || !dataEnd) throw new Error('manifest.dataPeriod.start/end 누락');

  const csvFiles = readdirSync(inputDir).filter((f) => /\.csv$/i.test(f)).sort();
  if (csvFiles.length === 0) throw new Error(`CSV 없음: ${inputDir}`);

  const passed = []; // {symbol, rows, warnings, outPath}
  const rejected = []; // {symbol, reasons}

  for (const file of csvFiles) {
    const symbol = basename(file, '.csv').toUpperCase();
    const outPath = join(outputDir, `${symbol}.json`);
    let rows;
    try {
      rows = parseStooqCsv(readFileSync(join(inputDir, file), 'utf8'), symbol);
    } catch (e) {
      rejected.push({ symbol, reasons: [e.message] });
      continue;
    }
    const existingCount = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')).length : null;
    const { reasons, warnings } = validate(rows, { dataStart, dataEnd, existingCount });
    if (reasons.length) rejected.push({ symbol, reasons });
    else passed.push({ symbol, rows, warnings, outPath });
  }

  // 통과 심볼만 기록 (기존 포맷 재현: 압축 JSON, 개행 없음).
  for (const p of passed) writeFileSync(p.outPath, JSON.stringify(p.rows));

  // 리포트
  console.log(`\n=== Stooq → 리플레이 변환 리포트 (${outputDir}) ===`);
  console.log(`입력 CSV: ${csvFiles.length}종목 | 성공: ${passed.length} | 거부: ${rejected.length}`);
  for (const p of passed) {
    const w = p.warnings.length ? `  ⚠ ${abbrev(p.warnings)}` : '';
    console.log(`  ✓ ${p.symbol.padEnd(6)} ${String(p.rows.length).padStart(4)}행${w}`);
  }
  for (const r of rejected) console.log(`  ✗ ${r.symbol.padEnd(6)} 거부: ${abbrev(r.reasons)}`);

  // 전부 성공 시에만 manifest.source 갱신
  if (rejected.length === 0 && passed.length > 0) {
    manifest.source = {
      provider: 'Stooq',
      note: 'Stooq 일봉 CSV(https://stooq.com/q/d/l/?s=<sym>.us&d1=20191202&d2=20200930&i=d) → stooq-to-replay-json.mjs 변환.',
      fetchedAt: new Date().toISOString().slice(0, 10),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`  → manifest.source 를 Stooq 로 갱신함 (fetchedAt ${manifest.source.fetchedAt}).`);
  } else if (rejected.length > 0) {
    console.log('  → 거부 심볼이 있어 manifest.source 미갱신.');
  }
  return { passed: passed.length, rejected: rejected.length };
}

// --- 자체검증: 합성 2행 CSV → 기대 JSON 매핑 assert ---
function selftest() {
  const csv = [
    'Date,Open,High,Low,Close,Volume',
    '2019-12-02,64.427,64.6617,63.5058,63.6766,98291527',
    '2019-12-03,62.5,63.0,62.0,62.8,114430400',
  ].join('\n');

  const rows = parseStooqCsv(csv, 'AAPL');
  const expected = [
    { date: '2019-12-02', o: 64.427, h: 64.6617, l: 63.5058, c: 63.6766, v: 98291527 },
    { date: '2019-12-03', o: 62.5, h: 63, l: 62, c: 62.8, v: 114430400 },
  ];
  assert.deepEqual(rows, expected, '매핑 불일치');

  // 포맷 재현: 압축 JSON, 키 순서 date/o/h/l/c/v
  const json = JSON.stringify(rows);
  assert.equal(
    json,
    '[{"date":"2019-12-02","o":64.427,"h":64.6617,"l":63.5058,"c":63.6766,"v":98291527},{"date":"2019-12-03","o":62.5,"h":63,"l":62,"c":62.8,"v":114430400}]',
    '직렬화 포맷 불일치',
  );

  // 빈 값·NaN 행은 반드시 throw
  assert.throws(() => parseStooqCsv('Date,Open,High,Low,Close,Volume\n2020-01-02,,,,,', 'X'), /빈 값/);
  assert.throws(() => parseStooqCsv('Date,Open,High,Low,Close,Volume\n2020-01-02,1,2,0.5,N/A,100', 'X'), /숫자 아님/);

  // 검증기: 정상 통과 / sanity·범위·단조 위반 거부
  const good = validate(expected, { dataStart: '2019-12-02', dataEnd: '2020-09-30', existingCount: 2 });
  assert.equal(good.reasons.length, 0, `정상 데이터 오거부: ${good.reasons}`);

  const badLowHigh = validate(
    [{ date: '2020-01-02', o: 10, h: 9, l: 8, c: 9.5, v: 100 }], // h<o
    { dataStart: '2019-12-02', dataEnd: '2020-09-30', existingCount: null },
  );
  assert.ok(badLowHigh.reasons.some((r) => /OHLC 관계/.test(r)), 'OHLC 관계 위반 미검출');

  const outOfRange = validate(
    [{ date: '2021-01-02', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
    { dataStart: '2019-12-02', dataEnd: '2020-09-30', existingCount: null },
  );
  assert.ok(outOfRange.reasons.some((r) => /dataPeriod/.test(r)), '범위 위반 미검출');

  const dup = validate(
    [
      { date: '2020-01-02', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
      { date: '2020-01-02', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
    ],
    { dataStart: '2019-12-02', dataEnd: '2020-09-30', existingCount: null },
  );
  assert.ok(dup.reasons.some((r) => /비단조|중복/.test(r)), '중복 날짜 미검출');

  const bigDiff = validate(expected, { dataStart: '2019-12-02', dataEnd: '2020-09-30', existingCount: 30 });
  assert.ok(bigDiff.reasons.some((r) => /행수 차이/.test(r)), '행수 초과 차이 미거부');

  console.log('셀프테스트 통과 ✓ (매핑·포맷·검증기 8건)');
}

// --- entrypoint ---
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  selftest();
} else {
  const args = argv.filter((a) => !a.startsWith('--'));
  const inputDir = args[0];
  const outputDir = args[1] || DEFAULT_OUTPUT;
  if (!inputDir) {
    console.error('사용법: node scripts/replay/stooq-to-replay-json.mjs <inputDir> [outputDir]');
    console.error('        node scripts/replay/stooq-to-replay-json.mjs --selftest');
    process.exit(1);
  }
  try {
    const { rejected } = convertDir(inputDir, outputDir);
    process.exit(rejected > 0 ? 1 : 0); // 거부가 있으면 비정상 종료(CI 감지용)
  } catch (e) {
    console.error(`오류: ${e.message}`);
    process.exit(1);
  }
}
