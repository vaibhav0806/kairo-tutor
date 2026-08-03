import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The onboarding act order is a security boundary, not just a UX choice.
 *
 * Everything before sign-in must be free to run: baked audio and a colour wheel. Everything that
 * calls a provider — the hearing drill's transcription, the practice beats' vision turns — must sit
 * after it, so every paid call in the product is authenticated and attributable to a user. That is
 * what let the unauthenticated `/v1/onboarding/*` routes be deleted outright.
 *
 * A future reorder that moves sign-in later would silently reopen that surface, and nothing else in
 * the codebase would notice. Hence this test, which reads the order as written rather than trusting
 * a comment to stay true.
 */
const source = readFileSync(join(__dirname, '../src/onboarding/OnboardingApp.tsx'), 'utf8');

function actIndex(name: string): number {
  const match = source.match(new RegExp(`\\b${name}:\\s*(\\d+)`));
  if (!match) throw new Error(`ACT.${name} not found in OnboardingApp.tsx`);
  return Number(match[1]);
}

describe('onboarding act order', () => {
  it('puts sign-in before every act that can spend money', () => {
    const signin = actIndex('SIGNIN');
    // HEARING runs the push-to-talk drill (speech-to-text); PRACTICE runs the real vision turns.
    expect(signin).toBeLessThan(actIndex('HEARING'));
    expect(signin).toBeLessThan(actIndex('PRACTICE'));
  });

  it('keeps the free front door first, so the ask is not the very first thing', () => {
    // The hero and colour step are baked audio plus a colour wheel — no provider call at all — so
    // they can stay ahead of the account ask without costing anything.
    expect(actIndex('WELCOME')).toBeLessThan(actIndex('SIGNIN'));
  });

  it('leaves the run to the peak uninterrupted', () => {
    // The practice beats are the emotional high point; a credential step between them and the
    // ending is what moving sign-in earlier was partly meant to remove.
    expect(actIndex('PRACTICE')).toBeLessThan(actIndex('SOURCE'));
    expect(actIndex('SOURCE')).toBeLessThan(actIndex('ENDING'));
  });

  it('has no spoken line or cached audio for the silent sign-in act', () => {
    const copy = readFileSync(join(__dirname, '../src/onboarding/copy.ts'), 'utf8');
    expect(copy).not.toContain('ACT5_SIGNIN');
    expect(copy).not.toContain('act5_signin');
  });
});
