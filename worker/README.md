# worker — 실시간 시세 게이트웨이

업스트림 WS(Finnhub·KIS)를 단일 커넥션으로 받아 인메모리 시세북에 모으고,
브라우저에 SSE로 팬아웃한다. 지정가 매칭 엔진과 시즌 크론도 여기 상주한다.
배포: Railway (KIS 해외 IP 차단 시 Oracle Cloud 서울 — T01에서 확정).

## 로컬 실행 (키 없이 mock)

```bash
cp .env.example .env      # 기본값 FEED_*=mock 이면 키 불필요
npm run dev -w @mockstock/worker
# http://localhost:8787/health
# http://localhost:8787/stream?symbols=US:AAPL,KR:005930
```

## 엔드포인트

| 경로 | 용도 |
| --- | --- |
| `GET /health` | 업스트림 상태 (UptimeRobot 모니터, B14) |
| `GET /snapshot?symbols=US:AAPL` | 체결가 조회 (web 주문 API, `x-worker-secret` 헤더, B1) |
| `GET /stream?symbols=…` | SSE — `event:snapshot` 1건 → `event:ticks` 델타 (B2) |

## 구현 현황

| 파일 | 상태 |
| --- | --- |
| `feeds/mock.ts` · `priceBook.ts` · `sse.ts` | ✅ 동작 (mock) |
| `feeds/finnhub.ts` · `feeds/kis.ts` | 🔲 T05 |
| `matching.ts` | 🔲 T08 |
| `cron.ts` | 🔲 T06 |

> `KIS_*` / `FINNHUB_*` 키는 **워커 env에만** 둔다 (web 금지, B6/B14).
