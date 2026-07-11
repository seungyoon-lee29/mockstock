# 종목 로고 수급

`npx tsx scripts/logos/fetch-logos.mjs` — 실행 시점의 shared `UNIVERSE`를 읽어 `web/public/logos/{market}/{symbol}.png`로 저장(있으면 스킵, 멱등). 유니버스가 확대되면 `domains.json`에 신규 심볼→도메인을 보강한 뒤 재실행하면 신규 종목만 받는다. 실패 종목은 UI에서 2글자 폴백 아바타로 표시된다.
