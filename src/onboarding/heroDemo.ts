// The looping hero demo shown on the right half of Act 0 (the split "front door").
//
// TODAY: `null` → <Act0Hero> renders the pure-CSS <HeroDemoMock>, so the layout is fully testable
// with ZERO image asset.
//
// WHEN THE REAL GIF LANDS (founder produces it later): drop it at
//   src/assets/onboarding/hero-demo.gif
// and make this file exactly:
//   import gif from '../assets/onboarding/hero-demo.gif';
//   export const heroDemoSrc: string | null = gif;
// That one-file change is the ENTIRE wiring surface for the real asset (mirrors the same
// placeholder-then-swap pattern the plan uses for the morph/settle sound cues).
export const heroDemoSrc: string | null = null;
