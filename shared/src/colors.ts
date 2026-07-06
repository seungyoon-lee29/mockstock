// 상승/하락 색 단일 소스. CSS 변수를 못 읽는 JS 소비(lightweight-charts 차트 옵션 등)용.
// globals.css 의 --color-up/--color-down 과 같은 값을 유지할 것 (한국식: 상승=빨강, 하락=파랑).
export const PRICE_COLORS = {
  up: "#f04452",
  down: "#3182f6",
} as const;
