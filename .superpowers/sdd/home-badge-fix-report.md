# Home Badge Fix Report

## Scope

Fix the Muyeong home-page caption clipping without moving either portrait illustration.

## Root cause

`.home-portrait--muyeong` is positioned `right: -8%`. Its caption was inset by
only `right: 5%` of a 65%-wide figure, leaving the caption's right edge outside
the `.home-portraits` panel at desktop widths. The same selector is used by the
responsive 768px and 390px layouts.

## RED

Added Playwright coverage in `e2e/archive.spec.ts` that asserts every edge of
`.home-portrait--muyeong figcaption` is inside `.home-portraits` at 1440px,
768px, and 390px.

`npx playwright test -g "Muyeong home caption" --workers=1` failed before the
CSS fix with these right-edge bounds (pixels):

| Viewport | Panel right | Caption right | Overflow |
| --- | ---: | ---: | ---: |
| 1440px | 1256 | 1277.859375 | 21.859375 |
| 768px | 729.609375 | 749.46875 | 19.859375 |
| 390px | 370 | 384.703125 | 14.703125 |

## GREEN

Changed only `.home-portrait--muyeong figcaption` from `right: 5%` to
`right: 13%`. This is greater than the 12.31% figure-relative inset required
to compensate for the 8% negative figure offset at the base 65% figure width;
the artwork rule remains unchanged.

The focused regression passed at all three widths. Post-fix bounds (pixels):

| Viewport | Panel right | Caption right | Right clearance |
| --- | ---: | ---: | ---: |
| 1440px | 1256 | 1253.9375 | 2.0625 |
| 768px | 729.609375 | 723.484375 | 6.125 |
| 390px | 370 | 363.421875 | 6.578125 |

## Verification

- `npx playwright test -g "Muyeong home caption" --workers=1` — 3 passed.
- `npm run e2e` — 6 passed.
- `npm run build` — passed (`tsc --noEmit` and Vite production build).

## Self-review

- The selector is restricted to Muyeong's caption, preserving both illustration
  positions and Cheonryeong's caption.
- The regression tests the rendered layout, including the responsive widths
  sharing this selector, rather than asserting CSS text.
