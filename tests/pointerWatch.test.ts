import { describe, it, expect, vi } from 'vitest';
import { createPointerWatch, type PointerWatchDeps } from '../src/notch/pointerWatch';

const REF = [0, 0, 0, 0, 0, 0, 0, 0];                          // the screen the box was drawn on
const CHANGED = [0xffffffff, 0xffffffff, 0, 0, 0, 0, 0, 0];    // a clearly different screen (64 bits off)
const BOX = { x: 100, y: 100, width: 40, height: 30 };
const IN_BOX = { x: 120, y: 115 };
const OUT_OF_BOX = { x: 999, y: 999 };

function deps(overrides: Partial<PointerWatchDeps> = {}): PointerWatchDeps {
  return {
    captureFrameHash: vi.fn(async () => [...REF]),
    fadePointer: vi.fn(),
    reshowPointer: vi.fn(),
    onValidClick: vi.fn(),
    onWrongButton: vi.fn(),
    onIdleFade: vi.fn(),
    // Both background timers (the ~800ms armed-watch poll and the ~30s idle fade) never
    // resolve by default so neither can spuriously drive the watch — and the poll's
    // while(true) loop can't spin forever on an instant sleep and hang the suite. Tests
    // that exercise either timer swap in a gated sleep that hands back the resolver.
    sleep: vi.fn((ms: number) =>
      ms === 800 || ms === 30000 ? new Promise<void>(() => {}) : Promise.resolve()
    ) as any,
    log: vi.fn(),
    cfg: { armedPollMs: 800, sameScreenBits: 28, clickPadPt: 24, idleFadeMs: 30000 },
    ...overrides,
  };
}

// Flush pending microtasks (the poll's capture awaits) via one macrotask turn.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Gate the two long timers to never-resolve but capture each resolver, so a test can
// fire exactly one poll tick / the idle timer by hand. The poll loop re-arms sleep(800)
// after each tick, overwriting poll.fn, so successive ticks fire in turn.
const gated = (
  poll: { fn?: () => void },
  idle: { fn?: () => void },
  overrides: Partial<PointerWatchDeps> = {},
): PointerWatchDeps =>
  deps({
    sleep: vi.fn((ms: number) => {
      if (ms === 800) return new Promise<void>((r) => { poll.fn = r; });
      if (ms === 30000) return new Promise<void>((r) => { idle.fn = r; });
      return Promise.resolve();
    }) as any,
    ...overrides,
  });

describe('pointerWatch', () => {
  it('setPending then a valid in-box click (screen unchanged) fires onValidClick once', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'page-load');
    expect(w.pending).toBe(true);
    w.onClick(IN_BOX);
    expect(d.onValidClick).toHaveBeenCalledTimes(1);
    // the pending step's wait + the pre-click baseline (the ref the box was drawn on) +
    // the button used (defaults to 'left')
    expect(d.onValidClick).toHaveBeenCalledWith('page-load', REF, 'left');
    expect(w.pending).toBe(false);
  });

  it('an out-of-box click does nothing and stays pending', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant');
    w.onClick(OUT_OF_BOX);
    expect(d.onValidClick).not.toHaveBeenCalled();
    expect(w.pending).toBe(true);
  });

  it('the poll fades the pointer when the live screen changes, and then an in-box click is ignored', async () => {
    // THE BUG-FIX guard: pointerFaded is set by the poll (not by a post-click capture).
    const poll: { fn?: () => void } = {};
    const idle: { fn?: () => void } = {};
    const d = gated(poll, idle, { captureFrameHash: vi.fn(async () => [...CHANGED]) });
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant');
    expect(d.fadePointer).not.toHaveBeenCalled(); // pointer shown; poll hasn't ticked yet
    poll.fn?.();                                  // one armed tick → screen changed → fade
    await flush();
    expect(d.fadePointer).toHaveBeenCalledTimes(1);
    // guard now active: a subsequent in-box click is ignored (no post-click capture)
    w.onClick(IN_BOX);
    expect(d.onValidClick).not.toHaveBeenCalled();
    expect(w.pending).toBe(true); // still pending, just faded
  });

  it('the poll re-shows the pointer when the screen returns, then an in-box click advances', async () => {
    const poll: { fn?: () => void } = {};
    const idle: { fn?: () => void } = {};
    const d = gated(poll, idle, {
      captureFrameHash: vi
        .fn()
        .mockResolvedValueOnce([...CHANGED]) // tick 1: changed → fade
        .mockResolvedValue([...REF]) as any, // tick 2: back to reference → re-show
    });
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'ui-settle');
    poll.fn?.();                 // tick 1 → fade
    await flush();
    expect(d.fadePointer).toHaveBeenCalledTimes(1);
    poll.fn?.();                 // tick 2 → re-show (loop re-armed sleep(800) after tick 1)
    await flush();
    expect(d.reshowPointer).toHaveBeenCalledTimes(1);
    // pointer is back (guard cleared) → a valid in-box click now advances
    w.onClick(IN_BOX);
    expect(d.onValidClick).toHaveBeenCalledTimes(1);
    expect(d.onValidClick).toHaveBeenCalledWith('ui-settle', REF, 'left');
  });

  it('idle-fade fires after idleFadeMs → fadePointer + onIdleFade, pending false', async () => {
    const poll: { fn?: () => void } = {};
    const idle: { fn?: () => void } = {};
    const d = gated(poll, idle);
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant');
    expect(d.fadePointer).not.toHaveBeenCalled(); // shown; idle timer still pending
    idle.fn?.();                                  // the idle timer elapses
    await flush();
    expect(d.fadePointer).toHaveBeenCalledTimes(1);
    expect(d.onIdleFade).toHaveBeenCalledTimes(1);
    expect(w.pending).toBe(false);
  });

  it('right-expected + right-click advances (button matches)', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'ui-settle', 'right');
    w.onClick(IN_BOX, 'right');
    expect(d.onValidClick).toHaveBeenCalledWith('ui-settle', REF, 'right');
    expect(d.onWrongButton).not.toHaveBeenCalled();
    expect(w.pending).toBe(false);
  });

  it('right-expected + LEFT-click nudges, does NOT advance, stays pending', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'ui-settle', 'right');
    w.onClick(IN_BOX, 'left');
    expect(d.onWrongButton).toHaveBeenCalledTimes(1);
    expect(d.onWrongButton).toHaveBeenCalledWith('right');
    expect(d.onValidClick).not.toHaveBeenCalled();
    expect(w.pending).toBe(true); // still waiting for the correct button
  });

  it('left-expected + RIGHT-click nudges (symmetric), stays pending', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant', 'left');
    w.onClick(IN_BOX, 'right');
    expect(d.onWrongButton).toHaveBeenCalledWith('left');
    expect(d.onValidClick).not.toHaveBeenCalled();
    expect(w.pending).toBe(true);
  });

  it('a wrong-button click OUTSIDE the box does NOT nudge (button check is after in-box)', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant', 'right');
    w.onClick(OUT_OF_BOX, 'left');
    expect(d.onWrongButton).not.toHaveBeenCalled();
    expect(d.onValidClick).not.toHaveBeenCalled();
    expect(w.pending).toBe(true);
  });

  it('default expected button is left (3-arg setPending + no-button onClick unchanged)', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant'); // no button → left
    w.onClick(IN_BOX);                 // no button → left
    expect(d.onValidClick).toHaveBeenCalledTimes(1);
    expect(d.onWrongButton).not.toHaveBeenCalled();
  });

  it('a fast double-click advances exactly once (latch)', () => {
    const d = deps();
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant');
    w.onClick(IN_BOX);
    w.onClick(IN_BOX); // pending already false → no-op
    expect(d.onValidClick).toHaveBeenCalledTimes(1);
    expect(w.pending).toBe(false);
  });

  it('clear() stops everything — a later poll tick and the idle timer both no-op', async () => {
    const poll: { fn?: () => void } = {};
    const idle: { fn?: () => void } = {};
    const d = gated(poll, idle, { captureFrameHash: vi.fn(async () => [...CHANGED]) });
    const w = createPointerWatch(d);
    w.setPending(BOX, REF, 'instant');
    w.clear();
    expect(w.pending).toBe(false);
    // fire the now-stale poll tick and idle timer → both must do nothing (token moved on)
    poll.fn?.();
    idle.fn?.();
    await flush();
    expect(d.fadePointer).not.toHaveBeenCalled();
    expect(d.reshowPointer).not.toHaveBeenCalled();
    expect(d.onIdleFade).not.toHaveBeenCalled();
    // and no click can advance after clear()
    w.onClick(IN_BOX);
    expect(d.onValidClick).not.toHaveBeenCalled();
  });
});
