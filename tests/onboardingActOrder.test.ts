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
const frontDoor = readFileSync(join(__dirname, '../src/onboarding/acts/FrontDoor.tsx'), 'utf8');

function actIndex(name: string): number {
  const match = source.match(new RegExp(`\\b${name}:\\s*(\\d+)`));
  if (!match) throw new Error(`ACT.${name} not found in OnboardingApp.tsx`);
  return Number(match[1]);
}

describe('onboarding act order', () => {
  it('signs the user in inside the front door, before any act that spends money', () => {
    // Sign-in is the front door's third panel, not an act of its own. What matters for cost is that
    // the card cannot be left until it succeeds: HEARING runs speech-to-text and PRACTICE runs the
    // real vision turns, and both sit after WELCOME.
    expect(frontDoor).toContain("'hero' | 'color' | 'signin'");
    expect(frontDoor).toContain('SignInPanel');
    expect(actIndex('WELCOME')).toBeLessThan(actIndex('HEARING'));
    expect(actIndex('WELCOME')).toBeLessThan(actIndex('PRACTICE'));
  });

  it('only leaves the front door once sign-in has succeeded', () => {
    // The collapse is what ends the card and advances the flow. It must be reachable from the
    // sign-in success path and NOT from the colour confirm, or the paid acts open up early.
    const signInHandler = frontDoor.slice(frontDoor.indexOf('onSignedIn={'));
    expect(signInHandler).toContain('startCollapse()');
    const confirmBody = frontDoor.slice(
      frontDoor.indexOf('const confirm = useCallback'),
      frontDoor.indexOf('const startCollapse'),
    );
    expect(confirmBody).not.toContain('setCollapse(');
  });

  it('leaves the run to the peak uninterrupted', () => {
    // The practice beats are the emotional high point; a credential step between them and the
    // ending is what moving sign-in earlier was partly meant to remove.
    expect(actIndex('PRACTICE')).toBeLessThan(actIndex('SOURCE'));
    expect(actIndex('SOURCE')).toBeLessThan(actIndex('ENDING'));
  });

  it('has no spoken line or cached audio for the silent sign-in panel', () => {
    const copy = readFileSync(join(__dirname, '../src/onboarding/copy.ts'), 'utf8');
    expect(copy).not.toContain('ACT5_SIGNIN');
    expect(copy).not.toContain('act5_signin');
  });
});
