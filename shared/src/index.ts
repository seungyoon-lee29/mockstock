// @mockstock/shared 클라이언트 안전 배럴 (types·universe·mock).
// 주의: schema/fillOrder/marketCalendar 는 서버 전용이라 배럴에서 제외 —
// 각각 "@mockstock/shared/schema" 등 서브패스로 임포트한다.
export * from "./types";
export * from "./universe";
export * from "./mock";
export * from "./colors";
export * from "./rules";
export * from "./seasons"; // 시즌 수명주기(서버 전용, web 폴백·worker 크론 공용) — T06
export * from "./candles"; // 캔들 집계(일→주봉·틱→분봉) 단일 소스 — 멀티 타임프레임 차트
export * from "./indices"; // 홈 인덱스 스트립 정의·시세 계약(코스피·코스닥·SPY·QQQ) — REST 폴링
export * from "./orderbook"; // 호가창 계약 + mock 합성기(표시 전용) — 종목 상세 호가 래더
