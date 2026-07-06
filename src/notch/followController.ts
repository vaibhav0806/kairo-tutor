import {
  parseFollowStep, clickInBox, waitFloorMs, stillMoving, sameScreen,
  type FollowAlongState, type FollowStep, type FollowWait, type WaitFloors,
} from './followAlong';

export interface FollowCfg {
  settlePollMs: number;
  settleMaxIterations: number;
  settleMovingBits: number;
  sameScreenBits: number;
  clickPadPt: number;
  pointerIdleFadeMs: number;
  waitFloors: WaitFloors;
}

export interface FollowDeps {
  captureFrameHash: () => Promise<number[]>;
  captureScreenB64: () => Promise<{ imageBase64: string; mediaType: string }>;
  runFollowTurn: (args: {
    goal: string; history: string[]; imageBase64: string; mediaType: string;
    activeApp?: string; windowTitle?: string;
  }) => Promise<any>;
  runAckTurn: (completedStep: string) => Promise<string>;
  speak: (text: string) => Promise<void>;
  showPointer: (step: FollowStep) => void;
  fadePointer: () => void;
  armFollowClick: () => void;
  disarmFollowClick: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
  cfg: FollowCfg;
}

export interface FollowController {
  state: FollowAlongState;
  start(goal: string, ctx: { activeApp?: string; windowTitle?: string }): Promise<void>;
  onClick(click: { x: number; y: number }): Promise<void>;
  onScreenMoved(): void;   // scroll / tab / window change → fade pointer, keep step
  stop(reason: string): void;
}

/** A model that keeps emitting box-null observe steps must not auto-flow (and
 *  bill vision calls) forever — pause after this many consecutive observes. */
const MAX_CONSECUTIVE_OBSERVE = 5;

export function createFollowController(d: FollowDeps): FollowController {
  const state: FollowAlongState = {
    active: false, goal: '', history: [], currentStep: null, referenceHash: null,
  };
  let epoch = 0;               // bumped on stop / supersede
  let clickLatch = false;      // synchronous re-entrancy guard against double-clicks
  let consecutiveObserve = 0;  // capped so observe-only models can't loop forever
  let lastCtx: { activeApp?: string; windowTitle?: string } = {};

  function stop(reason: string) {
    epoch++;
    state.active = false;
    state.currentStep = null;
    state.referenceHash = null;
    d.disarmFollowClick();
    d.fadePointer();
    d.log('info', 'follow stopped', { reason });
  }

  async function planAndShow(myEpoch: number) {
    // referenceHash and the model's screenshot are two separate grabs a moment
    // apart; dHash tolerance (sameScreenBits) intentionally absorbs that gap.
    const hash = await d.captureFrameHash();
    const shot = await d.captureScreenB64();
    if (epoch !== myEpoch) return;
    const raw = await d.runFollowTurn({
      goal: state.goal, history: state.history,
      imageBase64: shot.imageBase64, mediaType: shot.mediaType,
      activeApp: lastCtx.activeApp, windowTitle: lastCtx.windowTitle,
    });
    if (epoch !== myEpoch) return;
    const step = parseFollowStep(raw);
    state.currentStep = step;
    state.referenceHash = hash;
    d.log('info', 'follow step', { expect: step.expect, wait: step.wait, status: step.status });

    if (step.status === 'done') {
      if (step.say) await d.speak(step.say).catch(() => {});
      if (epoch === myEpoch) stop('done');
      return;
    }
    if (step.say) void d.speak(step.say).catch((e) => d.log('debug', 'speak failed', { err: String(e) }));
    if (step.box) {
      consecutiveObserve = 0;
      d.showPointer(step);
      d.armFollowClick();
    } else {
      // observe step: no target, nothing to wait for → auto-flow to the next step
      consecutiveObserve++;
      if (consecutiveObserve > MAX_CONSECUTIVE_OBSERVE) {
        d.log('warn', 'observe auto-flow cap hit — pausing', { consecutiveObserve });
        d.fadePointer(); // leave the machine active + idle rather than looping
        return;
      }
      state.history.push(step.say);
      await autoFlow(myEpoch);
    }
  }

  async function autoFlow(myEpoch: number) {
    // observe steps chain straight into the next plan (screen usually unchanged)
    if (epoch !== myEpoch || !state.active) return;
    await planAndShow(myEpoch);
  }

  async function settleThenPlan(myEpoch: number, wait: FollowWait) {
    // wait floor
    await d.sleep(waitFloorMs(wait, d.cfg.waitFloors));
    if (epoch !== myEpoch) return;
    // settle-diff loop (capped)
    let prev = await d.captureFrameHash();
    for (let i = 0; i < d.cfg.settleMaxIterations; i++) {
      await d.sleep(d.cfg.settlePollMs);
      if (epoch !== myEpoch) return;
      const cur = await d.captureFrameHash();
      if (!stillMoving(prev, cur, d.cfg.settleMovingBits)) break;
      prev = cur;
      if (i === d.cfg.settleMaxIterations - 1) {
        d.log('warn', 'settle cap hit — sending slightly-moving frame');
      }
    }
    if (epoch !== myEpoch) return;
    await planAndShow(myEpoch);
  }

  return {
    state,
    async start(goal, ctx) {
      epoch++;
      const myEpoch = epoch;
      state.active = true;
      state.goal = goal;
      state.history = [];
      consecutiveObserve = 0;
      lastCtx = ctx;
      d.log('info', 'follow start', { goal });
      try {
        await planAndShow(myEpoch);
      } catch (e) {
        d.log('warn', 'follow plan failed', { err: String(e) });
        stop('error');
      }
    },

    async onClick(click) {
      const step = state.currentStep;
      if (!state.active || !step || step.expect !== 'click' || !step.box) return;
      if (!clickInBox(click, step.box, d.cfg.clickPadPt)) {
        d.log('debug', 'click outside box — ignored');
        return; // passive: do nothing
      }
      if (clickLatch) {
        d.log('debug', 'click already being processed — ignored');
        return; // a fast double-click: only the first advances
      }
      clickLatch = true;
      try {
        // screen-match guard: is the screen still the one we drew the pointer on?
        const nowHash = await d.captureFrameHash();
        if (!state.referenceHash || !sameScreen(state.referenceHash, nowHash, d.cfg.sameScreenBits)) {
          d.log('debug', 'in-box click but screen changed — ignored');
          return; // they scrolled/navigated then clicked the same coordinate
        }
        // VALID: disarm, fade the old pointer, ack, settle, next step.
        // Bump epoch to supersede any stray in-flight settle/plan; stay active.
        const myEpoch = ++epoch;
        d.disarmFollowClick();
        d.fadePointer();
        consecutiveObserve = 0;
        const completed = step.say;
        state.history.push(completed);
        // ack (screen-blind) speaks immediately; failure → skip, never block
        void d.runAckTurn(completed)
          .then((t) => { if (t && epoch === myEpoch) return d.speak(t); })
          .catch((e) => d.log('debug', 'ack failed', { err: String(e) }));
        await settleThenPlan(myEpoch, step.wait);
      } catch (e) {
        d.log('warn', 'follow click handling failed', { err: String(e) });
        stop('error');
      } finally {
        clickLatch = false;
      }
    },

    onScreenMoved() {
      if (!state.active || !state.currentStep) return;
      d.fadePointer(); // stale — hide the hint; keep the step + goal
      d.log('debug', 'screen moved — pointer faded, step kept');
    },

    stop,
  };
}
