import { describe, expect, it } from 'vitest';
import { planGate } from '../src/notch/gateRouting';

const voice = { source: 'voice' as const, annotationCount: 0, hasGestureMarks: false, gateNeedsScreen: false };

describe('gate routing', () => {
  it('runs the gate for a pen-marked voice ask so it is not answered in silence', () => {
    // The regression this fixes: marks skipped the gate, so nothing was spoken for the whole
    // vision turn (8.4s measured) and the app read as broken.
    const plan = planGate({ ...voice, hasGestureMarks: true });

    expect(plan.gateRan).toBe(true);
    expect(plan.needsScreen).toBe(true);
  });

  it('runs the gate for an annotated voice ask too', () => {
    const plan = planGate({ ...voice, annotationCount: 2 });

    expect(plan.gateRan).toBe(true);
    expect(plan.needsScreen).toBe(true);
  });

  it('never lets the gate route a marked turn away from the screen', () => {
    // The marks ARE the question; a gate that says "no screenshot needed" must not win.
    for (const marks of [{ annotationCount: 3 }, { hasGestureMarks: true }]) {
      const plan = planGate({ ...voice, ...marks, gateNeedsScreen: false });
      expect(plan.needsScreen).toBe(true);
    }
  });

  it('still lets a plain voice ask be answered directly', () => {
    const plan = planGate(voice);

    expect(plan.gateRan).toBe(true);
    expect(plan.needsScreen).toBe(false);
  });

  it('sends a plain voice ask to the screen when the gate asks for it', () => {
    expect(planGate({ ...voice, gateNeedsScreen: true }).needsScreen).toBe(true);
  });

  it('skips the gate for typed asks and routes them screen-first', () => {
    const plan = planGate({ ...voice, source: 'typed' });

    expect(plan.gateRan).toBe(false);
    expect(plan.needsScreen).toBe(true);
  });
});
