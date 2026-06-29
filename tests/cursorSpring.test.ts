import { describe, expect, test } from 'vitest';
import {
  POINTING_SPRING,
  SHADOW_SPRING,
  createSpring,
  springAtRest,
  stepSpring
} from '../src/cursor/spring';

const DT = 1 / 60;

function simulate(config = SHADOW_SPRING, target = 100, steps = 600) {
  const spring = createSpring(0);
  let max = 0;
  for (let i = 0; i < steps; i += 1) {
    stepSpring(spring, target, config, DT);
    max = Math.max(max, spring.value);
  }
  return { spring, max };
}

describe('stepSpring', () => {
  test('shadow spring converges on its target', () => {
    const { spring } = simulate(SHADOW_SPRING);
    expect(spring.value).toBeCloseTo(100, 1);
    expect(springAtRest(spring, 100)).toBe(true);
  });

  test('shadow spring is overdamped — it does not overshoot', () => {
    const { max } = simulate(SHADOW_SPRING);
    expect(max).toBeLessThanOrEqual(100.5);
  });

  test('pointing spring overshoots slightly then settles', () => {
    const { spring, max } = simulate(POINTING_SPRING);
    expect(max).toBeGreaterThan(100); // a little rubber-band
    expect(spring.value).toBeCloseTo(100, 1);
  });

  test('clamps large frame gaps so it cannot blow up', () => {
    const spring = createSpring(0);
    stepSpring(spring, 100, POINTING_SPRING, 5); // 5-second stall
    expect(Number.isFinite(spring.value)).toBe(true);
    expect(Math.abs(spring.value)).toBeLessThan(1000);
  });
});
