---
paths:
  - "web/src/components/**"
  - "web/src/app/**/*.tsx"
---

# UI 규칙

- 새 컴포넌트 전에 `web/src/components/ui/`(shadcn)에 이미 있는지 확인하고 재사용.
- 스타일은 Tailwind v4 유틸리티. 별도 CSS 파일 추가 금지 (`globals.css` 예외).
- UI 텍스트는 한국어. 금액·수량 포맷은 `web/src/lib/market/format.ts` 사용.
- 상승 빨강 / 하락 파랑 — 한국 관례 준수.
