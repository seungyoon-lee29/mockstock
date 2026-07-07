# Stooq → 리플레이 JSON 수집·변환

`covid-2020` 시나리오(2019-12-02 ~ 2020-09-30, US 16종목)의 일봉을 Stooq에서 수동으로 받아
`web/public/replay/covid-2020/<SYMBOL>.json` 으로 변환하는 절차다.

Stooq는 JS PoW(작업증명) 챌린지 + **IP당 일일 hits 한도**가 있어 자동 대량 수집이 막혀 있다.
아래는 브라우저에서 한 종목씩 손으로 받는 **확인된 레시피**다.

## 1. 종목당 수집 (확인된 레시피)

**PoW는 종목별**이라 종목마다 그 종목의 HTML 페이지를 먼저 열어야 한다. 그리고 CSV는 다운로드가 아니라
**같은 탭 same-origin fetch로 텍스트를 직접 받아** `localStorage`에 쌓아둔 뒤, 마지막에 **딱 한 번** 번들로 내려받는다.
(파일 다운로드 방식은 3종목째부터 브라우저가 막는다 — 아래 함정 참고. 실제 16종목이 이 방식으로 검증됐다.)

각 종목에 대해 순서대로:

1. **그 종목의 HTML 페이지 로드** — 브라우저에서
   `https://stooq.com/q/d/?s=<sym>.us` 를 연다. (`<sym>`은 소문자, 예: `aapl`)
   이 페이지가 그 종목의 PoW 챌린지를 풀어 쿠키를 세팅한다. 차트/표가 보일 때까지 기다린다.
   PoW는 종목마다 걸리므로, A 종목 페이지에서 B 종목 CSV를 받으려 하면 `Access denied`가 온다.
2. **같은 탭에서 same-origin fetch로 CSV 텍스트 확보** — 방금 연 종목 페이지의 콘솔/스크립트에서
   `fetch('/q/d/l/?s=<sym>.us&d1=20191202&d2=20200930&i=d', { credentials: 'same-origin' })` 를 호출한다.
   `d1`/`d2`는 `dataPeriod`(YYYYMMDD), `i=d`는 일봉. PoW 쿠키가 자동 포함돼 status 200,
   `Date,Open,High,Low,Close,Volume` 헤더의 CSV 텍스트가 그대로 온다. 다운로드 프롬프트가 없어 파일 방식보다 안정적이다.
3. **localStorage에 누적** — 받은 CSV 텍스트를 stooq.com `localStorage`에 `scsv_<SYMBOL>` 키(대문자 심볼)로 저장한다.
   예: `aapl` → `scsv_AAPL`. 같은 origin이라 다음 종목 페이지로 이동해도 유지된다.
4. **마지막에 새 탭에서 단발 번들 다운로드** — 16종목을 다 모았으면 **새 탭**(다운로드 카운터가 리셋됨)에서 stooq.com을 열고,
   `localStorage`의 모든 `scsv_*`를 하나의 JSON 객체(`{ "AAPL": "csv텍스트", ... }`)로 묶어 **딱 한 번** 파일로 내려받는다.
5. **로컬에서 분할** — 받은 JSON을 파싱해 종목별 `<SYMBOL>.csv`(대문자 심볼)로 수집 폴더에 쪼갠다.
   숫자 재입력이 없어 바이트 단위로 정확하다.

받은 CSV 헤더는 `Date,Open,High,Low,Close,Volume`, 날짜 오름차순이다. 이 포맷 그대로 변환기가 먹는다.

### 함정 (반드시 지킬 것)

- **PoW는 종목별.** 한 종목 페이지에 머문 채 다른 종목 CSV를 fetch하면 `Access denied`가 온다.
  종목마다 반드시 그 종목의 HTML 페이지(`/q/d/?s=<sym>.us`)를 먼저 연 뒤 같은 탭에서 fetch한다.
- **파일 다운로드는 2종목까지만.** Chrome은 한 탭에서 3번째 이후 자동 다운로드를 조용히 차단한다.
  그래서 "종목마다 CSV 파일로 바로 다운로드"는 3종목째부터 파일이 안 떨어진다. 그래서 텍스트를 `localStorage`에 쌓고
  **새 탭**에서 한 번만 번들로 내려받는 것이다.
- **localStorage는 한 세션에서 마무리.** 브라우저 데이터/사이트 저장소를 지우면 `scsv_*`가 날아간다.
  되도록 수집 시작부터 번들 다운로드까지 한 세션 안에 끝낸다.
- **버스트 금지.** 16종목을 연달아 때리면 IP당 일일 hits 한도에 걸려 이후 요청이 빈 응답/차단된다.
  종목당 넉넉한 간격(수십 초, 실제로는 ~15초 간격)을 두고, 한도가 의심되면 그날은 멈추고 다음 날 이어받는다.
- **HTML 페이지 없이 `/q/d/l/` 직행 금지.** 1번(PoW 통과) 없이 바로 다운로드 URL을 치면 챌린지 페이지가 온다.
- **한 번에 전부 못 받아도 정상.** 변환기는 폴더에 있는 CSV만 처리한다. 며칠에 나눠 모아도 된다.
  단, 세션을 넘겨 이어받을 땐 이미 받은 종목의 CSV(또는 JSON)를 먼저 안전한 곳에 저장해 둔다.

## 2. 종목 목록 (16, US)

`AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO AMD NFLX JPM V DIS KO UBER SBUX`

각 티커의 Stooq 심볼은 `<소문자>.us` (예: `msft.us`, `googl.us`).

- **META**: 2020년 당시 티커는 `FB`였다. `meta.us`가 2019~2020 전이력을 반환하는지(사명 변경 후 심볼 승계) **먼저 확인**하고,
  비어 있거나 이력이 잘리면 `fb.us`로 받아 파일명만 `META.csv`로 저장한다.
- 제외 종목: `PLTR`(2020-09-30 직상장), `COIN`(2021 상장) — 시나리오 기간 미상장. 받지 않는다. (`manifest.symbolExclusions` 참고)

## 3. 변환 실행

CSV를 한 폴더(예: `~/stooq-csv/`)에 모았으면:

```bash
node scripts/replay/stooq-to-replay-json.mjs ~/stooq-csv
# 두 번째 인자로 출력 폴더 지정 가능 (기본: web/public/replay/covid-2020/)
node scripts/replay/stooq-to-replay-json.mjs ~/stooq-csv web/public/replay/covid-2020
```

동작:

- `<SYMBOL>.csv` → `<SYMBOL>.json` (기존 포맷: 압축 JSON 일봉 배열, 날짜 오름차순).
- **fail-closed 검증** — 심볼별로 (a) 기존 JSON 대비 행수(±5 초과 경고, ±20 초과 **거부**),
  (b) 날짜가 `manifest.dataPeriod` 범위 내, (c) 날짜 단조 오름차순·중복 없음,
  (d) OHLC>0·저가≤시·종·고가·거래량≥0 sanity. **하나라도 실패한 심볼은 파일을 쓰지 않고** 리포트에만 남긴다.
- 콘솔에 성공/거부 리포트 출력. **전부 통과했을 때만** `manifest.source`를 Stooq로 갱신한다.
- 거부 심볼이 하나라도 있으면 종료 코드 1(부분 성공도 1) — 문제 종목만 다시 받아 재실행한다.

### 자체검증

데이터 없이 매핑·포맷·검증 로직만 점검:

```bash
node scripts/replay/stooq-to-replay-json.mjs --selftest
```
