// Pure helpers + types for the follow-along guide loop. No React, no side effects.

export type FollowExpect = 'click' | 'observe';
export type FollowWait = 'instant' | 'ui-settle' | 'page-load' | 'network';
export type FollowStatus = 'guiding' | 'done';
/** Which mouse button a click-step expects. Defaults to 'left' everywhere. */
export type FollowButton = 'left' | 'right';

export interface ScreenRegion { x: number; y: number; width: number; height: number }
export interface FrameHashV { hash: number[] } // 8 x u32

export interface FollowStep {
  say: string;
  box: ScreenRegion | null;
  visualTargets: any[];
  expect: FollowExpect;
  wait: FollowWait;
  status: FollowStatus;
}

export interface FollowAlongState {
  active: boolean;
  goal: string;
  history: string[];
  currentStep: FollowStep | null;
  referenceHash: number[] | null;
}

export interface WaitFloors { instant: number; uiSettle: number; pageLoad: number; network: number }

/** Differing-bit count between two 8x u32 dHashes (0..256). */
export function hammingDistance(a: number[], b: number[]): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    d += (x * 0x01010101) >>> 24;
  }
  return d;
}

/** Same screen as the reference: distance within the tolerant threshold. Used by the
 *  pointer-watch to fade/re-show a pending hint as the live screen drifts and returns. */
export function sameScreen(a: number[], b: number[], samescreenBits: number): boolean {
  return hammingDistance(a, b) <= samescreenBits;
}

/** Is a click (display points) inside the box, padded by padPt points? */
export function clickInBox(
  click: { x: number; y: number },
  box: ScreenRegion,
  padPt: number,
): boolean {
  return (
    click.x >= box.x - padPt &&
    click.x <= box.x + box.width + padPt &&
    click.y >= box.y - padPt &&
    click.y <= box.y + box.height + padPt
  );
}

/** Coerce a raw button string (from await_click) to a known button. Unknown → 'left'. */
export function asFollowButton(raw: unknown): FollowButton {
  return raw === 'right' ? 'right' : 'left';
}

/** Does the actual mouse button match the button the step expects? */
export function buttonMatches(expected: FollowButton, actual: FollowButton): boolean {
  return expected === actual;
}

/**
 * Cooldown gate for the wrong-button nudge: true only once enough time has passed
 * since the last nudge. Keeps a fumbling user from being nagged on every click.
 */
export function shouldNudge(now: number, lastNudgeAt: number, cooldownMs: number): boolean {
  return now - lastNudgeAt >= cooldownMs;
}

/** Map a `wait` bucket to its floor in ms. Unknown → uiSettle. */
export function waitFloorMs(wait: FollowWait, floors: WaitFloors): number {
  switch (wait) {
    case 'instant': return floors.instant;
    case 'ui-settle': return floors.uiSettle;
    case 'page-load': return floors.pageLoad;
    case 'network': return floors.network;
    default: return floors.uiSettle;
  }
}

/** Normalize a raw follow-step payload (from run_follow_turn) into a FollowStep. */
export function parseFollowStep(raw: any): FollowStep {
  const targets: any[] = Array.isArray(raw?.visualTargets) ? raw.visualTargets : [];
  const boxTarget = targets.find((t) => t?.kind === 'highlight_box') ?? null;
  const region = boxTarget?.screenRegion ?? null;
  const box: ScreenRegion | null = region
    ? { x: region.x, y: region.y, width: region.width, height: region.height }
    : null;
  const expect: FollowExpect = raw?.expect === 'click' ? 'click' : 'observe';
  const status: FollowStatus = raw?.status === 'done' ? 'done' : 'guiding';
  const wait: FollowWait = (['instant', 'ui-settle', 'page-load', 'network'] as const)
    .includes(raw?.wait) ? raw.wait : 'ui-settle';
  return { say: String(raw?.say ?? ''), box, visualTargets: targets, expect, wait, status };
}
