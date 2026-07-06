# ADR 0001 — web(Vercel) + worker(Railway) + Neon 3분리

- 상태: 채택 (2026-07-04)
- 맥락: 실시간 시세로 가상 매매하는 모의투자. 1인 개발, ~$5/월, 동접 <20, 포트폴리오.

## 결정

브라우저 SSE는 상주 **worker**(Node)에 직결하고, **web**(Next.js/Vercel)은 인증·주문·리그 CRUD만 담당한다. DB는 **Neon Postgres**. worker가 업스트림 WS(Finnhub·KIS)를 시장당 단일 커넥션으로 받아 인메모리 시세북에 모으고 SSE로 팬아웃한다.

## 대안과 기각

- **(A) Vercel 단일 앱 + 폴링**: 인프라 0이지만 "실시간"이 2~3초 지연 폴링 → 틱 스트림 부재로 핵심 어필 상실.
- **(C) Supabase Realtime**: ingest 프로세스가 여전히 상주해야 해 worker를 없애주지 못하면서 메시지 쿼터 절벽($25/월)만 추가.

## 근거

Vercel serverless는 장시간 WS/SSE 유지가 불가(함수 실행시간 제한·인스턴스별 메모리 분리)하므로 상주 프로세스가 필수. worker 분리가 업스트림 커넥션을 사용자 수와 무관하게 1개로 고정해 레이트리밋을 지키고, 체결가 단일 소스(`/snapshot`)를 제공한다.

> ⚠️ 리스크: KIS가 해외 IP를 차단하는 사례 확인됨. Railway(싱가포르)에서 KIS WS 접속을 **T01 스파이크로 선검증**, 실패 시 Oracle Cloud Free(서울)로 전환.
