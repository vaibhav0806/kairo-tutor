// A framerate-independent 1-D spring integrator. Two of these (x and y) drive the
// companion cursor's motion: the value chases `target`, with `stiffness` pulling
// toward it and `damping` bleeding off velocity. Higher damping relative to
// stiffness = smooth, no overshoot (shadow). Lower damping = a little overshoot /
// rubber-band settle (pointing).

export type Spring = {
  value: number;
  velocity: number;
};

export type SpringConfig = {
  stiffness: number;
  damping: number;
};

// Loose, slightly overdamped: trails the mouse with visible lag, never overshoots.
export const SHADOW_SPRING: SpringConfig = { stiffness: 90, damping: 19 };

// Crisp, fluid glide to a target — the modern-notch motion vocabulary (Raycast
// tightness + Arc fluidity). Stiffness raised for a snappier arrival; damping kept
// just above critical (2*sqrt(120) ≈ 21.9) so it settles fast with NO overshoot/bounce.
export const POINTING_SPRING: SpringConfig = { stiffness: 120, damping: 22 };

export function createSpring(value = 0): Spring {
  return { value, velocity: 0 };
}

// Advance one spring by `dt` seconds toward `target`. `dt` is clamped so a stalled
// tab (huge frame gap) can't fling the value to infinity.
export function stepSpring(
  spring: Spring,
  target: number,
  config: SpringConfig,
  dt: number
): void {
  const clampedDt = Math.min(Math.max(dt, 0), 1 / 30);
  const accel = config.stiffness * (target - spring.value) - config.damping * spring.velocity;
  spring.velocity += accel * clampedDt;
  spring.value += spring.velocity * clampedDt;
}

// True once the spring has effectively settled on its target (used to stop the
// rAF loop when idle, so an unmoving cursor costs nothing).
export function springAtRest(spring: Spring, target: number, epsilon = 0.05): boolean {
  return Math.abs(target - spring.value) < epsilon && Math.abs(spring.velocity) < epsilon;
}
