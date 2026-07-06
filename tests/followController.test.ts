import { describe, it, expect, vi } from 'vitest';
import { createFollowController, type FollowDeps } from '../src/notch/followController';

function deps(overrides: Partial<FollowDeps> = {}): FollowDeps {
  return {
    captureFrameHash: vi.fn(async () => [0, 0, 0, 0, 0, 0, 0, 0]),
    captureScreenB64: vi.fn(async () => ({ imageBase64: 'x', mediaType: 'image/jpeg' })),
    runFollowTurn: vi.fn(async () => ({
      say: 'click this', box: { x: 100, y: 100, width: 40, height: 30 },
      visualTargets: [{ kind: 'highlight_box', screenRegion: { x: 100, y: 100, width: 40, height: 30 } }],
      expect: 'click', wait: 'instant', status: 'guiding',
    })),
    runAckTurn: vi.fn(async () => 'nice, next step'),
    speak: vi.fn(async () => {}),
    showPointer: vi.fn(),
    fadePointer: vi.fn(),
    armFollowClick: vi.fn(),
    disarmFollowClick: vi.fn(),
    sleep: vi.fn(async () => {}),
    now: (() => { let t = 0; return () => (t += 1000); })(),
    log: vi.fn(),
    cfg: {
      settlePollMs: 300, settleMaxIterations: 10, settleMovingBits: 6, sameScreenBits: 28,
      clickPadPt: 24, pointerIdleFadeMs: 30000,
      waitFloors: { instant: 75, uiSettle: 400, pageLoad: 1500, network: 2500 },
    },
    ...overrides,
  };
}

// A guiding step that highlights a box the tests can click into.
function guidingStep(say = 'click this') {
  return {
    say, box: { x: 100, y: 100, width: 40, height: 30 },
    visualTargets: [{ kind: 'highlight_box', screenRegion: { x: 100, y: 100, width: 40, height: 30 } }],
    expect: 'click', wait: 'instant', status: 'guiding',
  };
}

// Flush pending microtasks (the capture awaits) via one macrotask turn.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('follow controller', () => {
  it('start() plans and shows the first step, arms the click watch', async () => {
    const d = deps();
    const c = createFollowController(d);
    await c.start('open my first PR', { activeApp: 'Chrome', windowTitle: 'repo' });
    expect(d.runFollowTurn).toHaveBeenCalledTimes(1);
    expect(d.showPointer).toHaveBeenCalledTimes(1);
    expect(d.armFollowClick).toHaveBeenCalled();
    expect(c.state.active).toBe(true);
    expect(c.state.currentStep?.expect).toBe('click');
  });

  it('a valid in-box click on the same screen acks + advances', async () => {
    const d = deps();
    const c = createFollowController(d);
    await c.start('goal', {});
    d.runFollowTurn = vi.fn(async () => ({
      say: 'done!', box: null, visualTargets: [], expect: 'observe', wait: 'instant', status: 'done',
    })) as any;
    await c.onClick({ x: 120, y: 115 });
    expect(d.runAckTurn).toHaveBeenCalledTimes(1);
    expect(c.state.history.length).toBe(1);
    expect(c.state.active).toBe(false);
  });

  it('an in-box click but the screen CHANGED does nothing', async () => {
    const d = deps();
    d.captureFrameHash = vi
      .fn()
      .mockResolvedValueOnce([0, 0, 0, 0, 0, 0, 0, 0])
      .mockResolvedValue([0xffffffff, 0xffffffff, 0, 0, 0, 0, 0, 0]);
    const c = createFollowController(d);
    await c.start('goal', {});
    const acksBefore = (d.runAckTurn as any).mock.calls.length;
    await c.onClick({ x: 120, y: 115 });
    expect((d.runAckTurn as any).mock.calls.length).toBe(acksBefore);
    expect(c.state.history.length).toBe(0);
  });

  it('a click outside the box does nothing', async () => {
    const d = deps();
    const c = createFollowController(d);
    await c.start('goal', {});
    await c.onClick({ x: 999, y: 999 });
    expect(d.runAckTurn).not.toHaveBeenCalled();
    expect(c.state.history.length).toBe(0);
  });

  it('stop() mid-plan supersedes: no showPointer, machine deactivated', async () => {
    let resolveTurn!: (v: any) => void;
    const turnP = new Promise<any>((r) => { resolveTurn = r; });
    const d = deps({ runFollowTurn: vi.fn(() => turnP) as any });
    const c = createFollowController(d);
    const startP = c.start('goal', {}); // don't await — leave the plan in-flight
    await flush();                       // captures settle; parked at runFollowTurn
    c.stop('x');                         // supersede mid-plan
    resolveTurn(guidingStep());          // late resolution must be ignored
    await startP;
    expect(d.showPointer).not.toHaveBeenCalled();
    expect(c.state.active).toBe(false);
    expect(c.state.currentStep).toBeNull();
  });

  it('a second start() supersedes the first plan', async () => {
    let resolveFirst!: (v: any) => void;
    const firstP = new Promise<any>((r) => { resolveFirst = r; });
    let call = 0;
    const runFollowTurn = vi.fn(() => {
      call += 1;
      return call === 1 ? firstP : Promise.resolve(guidingStep('second step'));
    });
    const d = deps({ runFollowTurn: runFollowTurn as any });
    const c = createFollowController(d);
    const first = c.start('first goal', {}); // parks at runFollowTurn
    await flush();
    await c.start('second goal', {});        // supersede; the second plan completes
    resolveFirst(guidingStep('first step')); // first's late resolution is ignored
    await first;
    expect(c.state.goal).toBe('second goal');
    expect(c.state.currentStep?.say).toBe('second step');
    expect(d.showPointer).toHaveBeenCalledTimes(1); // only the second showed
  });

  it('a fast double-click advances exactly once', async () => {
    const d = deps();
    const c = createFollowController(d);
    await c.start('goal', {});
    // Fire two clicks back-to-back; the first is still awaiting when the second lands.
    const p1 = c.onClick({ x: 120, y: 115 });
    const p2 = c.onClick({ x: 120, y: 115 });
    await Promise.all([p1, p2]);
    expect(d.runAckTurn).toHaveBeenCalledTimes(1);
    expect(c.state.history.length).toBe(1);
  });

  it('a provider error during planning stops the machine (no unhandled rejection)', async () => {
    const d = deps({ runFollowTurn: vi.fn(async () => { throw new Error('boom'); }) as any });
    const c = createFollowController(d);
    await c.start('goal', {}); // must resolve, not reject
    expect(c.state.active).toBe(false);
    expect(d.showPointer).not.toHaveBeenCalled();
  });

  it('caps consecutive observe steps instead of looping forever', async () => {
    const d = deps({
      runFollowTurn: vi.fn(async () => ({
        say: 'just look', box: null, visualTargets: [], expect: 'observe', wait: 'instant', status: 'guiding',
      })) as any,
    });
    const c = createFollowController(d);
    await c.start('goal', {});
    // 1 initial plan + MAX_CONSECUTIVE_OBSERVE (5) auto-flows, then paused.
    expect((d.runFollowTurn as any).mock.calls.length).toBe(6);
    expect(c.state.active).toBe(true); // active + idle, not torn down
  });
});
