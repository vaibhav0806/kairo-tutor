// Thin, dependency-injected pointer-watch: the proven poll + geometry-gate +
// fade/re-show + idle-fade mechanics lifted out of followController's state machine.
//
// It knows nothing about goals / history / plans / settle / ack. Its whole job is to
// watch ONE pending click-target:
//   • fade it when the live screen drifts away from where it was drawn (scroll/nav/tab),
//   • re-show it when the screen returns,
//   • detect a valid in-box click on it (and hand the caller the step's `wait`),
//   • fade it after an idle timeout and tell the caller.
//
// Token discipline (mirrors the old controller's epoch/watchToken): a single
// `watchToken` supersedes BOTH background loops. setPending / clear / a valid click /
// an idle fire each bump it; every await-resume in the poll and the idle timer re-checks
// the token (and `pending`) before acting, so a superseded/cleared watch exits cleanly
// and two poll loops can never both act.
//
// THE BUG FIX preserved: the click guard is the synchronous `pointerFaded` flag, kept
// live by the background poll. onClick reads it directly — it does NOT capture a fresh
// frame after the click — so a click that itself navigates the page can't be falsely
// rejected by the already-navigated screen.

import {
  buttonMatches,
  clickInBox,
  sameScreen,
  type FollowButton,
  type ScreenRegion,
  type FollowWait,
} from './followAlong';

export interface PointerWatchCfg {
  armedPollMs: number;      // poll interval while a pointer is pending (~800)
  sameScreenBits: number;   // dHash tolerance for "same screen"
  clickPadPt: number;       // click tolerance around the box
  idleFadeMs: number;       // fade the pending pointer after this idle (~30000)
}

export interface PointerWatchDeps {
  captureFrameHash: () => Promise<number[]>;
  fadePointer: () => void;              // hide the pending pointer visually
  reshowPointer: () => void;            // re-show the same pending pointer (glide back)
  // A valid in-box click landed on the pending pointer. `baselineHash` is the
  // pre-click screen (the reference the box was drawn on, kept valid by the click
  // guard) — the caller uses it to tell "the screen reacted" from "still the old
  // screen" while settling before its next screenshot.
  onValidClick: (wait: FollowWait, baselineHash: number[], button: FollowButton) => void;
  // A click landed IN the box, on the right target, but with the WRONG button (e.g. a
  // left-click where a right-click was expected). The pointer stays pending; the caller
  // nudges the user to use the other button. Never fires on a correct click or a miss.
  onWrongButton: (expected: FollowButton) => void;
  onIdleFade: () => void;              // the pointer faded due to idle timeout (caller decides what next)
  sleep: (ms: number) => Promise<void>;
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
  cfg: PointerWatchCfg;
}

export interface PointerWatch {
  /**
   * Begin watching a pending click-target drawn from `referenceHash`, whose click needs
   * `wait` settle. `expectedButton` is which mouse button advances it (default 'left').
   */
  setPending(
    box: ScreenRegion,
    referenceHash: number[],
    wait: FollowWait,
    expectedButton?: FollowButton,
  ): void;
  /** A raw click at display-point coords (from input:click), with which button was used (default 'left'). */
  onClick(coords: { x: number; y: number }, button?: FollowButton): void;
  /** Stop watching (no pending pointer). */
  clear(): void;
  readonly pending: boolean;
}

export function createPointerWatch(d: PointerWatchDeps): PointerWatch {
  let pending = false;                     // is a pointer currently being watched?
  let box: ScreenRegion | null = null;     // the pending click-target
  let referenceHash: number[] | null = null; // the screen the box was drawn on
  let wait: FollowWait = 'ui-settle';      // settle the caller's click needs
  let expectedButton: FollowButton = 'left'; // which mouse button advances this pointer
  let pointerFaded = false;                // is the box hidden because the live screen drifted?
  let watchToken = 0;                      // bumped to supersede/stop poll + idle loops
  let clickLatch = false;                  // synchronous re-entrancy guard against double-clicks

  // Armed-watch poll: while a pointer is pending, a background loop keeps asking "does
  // the live screen still match where the box was drawn?" and maintains pointerFaded.
  // That flag IS the click guard (read synchronously in onClick) and also drives
  // fade-when-you-scroll-away + re-show-when-you-scroll-back. Parks on sleep(armedPollMs)
  // between ticks; exits when watchToken moves on or nothing is pending.
  function startArmedWatch(myToken: number) {
    void (async () => {
      while (true) {
        await d.sleep(d.cfg.armedPollMs);
        if (watchToken !== myToken || !pending) return;
        let hash: number[];
        try {
          hash = await d.captureFrameHash();
        } catch (e) {
          d.log('debug', 'armed poll capture failed', { err: String(e) });
          continue;
        }
        if (watchToken !== myToken || !pending) return;
        if (!referenceHash) continue;
        const matches = sameScreen(referenceHash, hash, d.cfg.sameScreenBits);
        if (matches && pointerFaded) {
          // user returned to the right screen → bring the hint back (glide, not draw)
          d.reshowPointer();
          pointerFaded = false;
          d.log('debug', 'armed screen returned → pointer re-shown');
        } else if (!matches && !pointerFaded) {
          // screen changed on its own (scroll / nav / tab) → the box is stale
          d.fadePointer();
          pointerFaded = true;
          d.log('debug', 'armed screen changed → pointer faded');
        }
      }
    })().catch((e) => d.log('debug', 'armed watch loop error', { err: String(e) }));
  }

  // Idle fade: if a pending pointer sits untouched for cfg.idleFadeMs, fade it and tell
  // the caller (which decides what to do next — end the guide, re-plan, etc.). Uses the
  // injected sleep + a token guard so it is cancellable and unit-testable. The pending
  // state is cleared BEFORE onIdleFade so the callback may safely setPending a fresh one.
  function scheduleIdleFade(myToken: number) {
    void d.sleep(d.cfg.idleFadeMs)
      .then(() => {
        if (watchToken !== myToken || !pending) return;
        d.log('info', 'pointer idle fade');
        d.fadePointer();
        pointerFaded = true;
        watchToken++;        // supersede the poll loop too
        pending = false;
        box = null;
        referenceHash = null;
        d.onIdleFade();
      })
      .catch((e) => d.log('debug', 'idle fade error', { err: String(e) }));
  }

  // Restart BOTH background loops for the still-pending pointer with a fresh token —
  // used to reset the idle-fade countdown when the user is actively (if wrongly)
  // clicking the target, so the hint doesn't fade out from under them.
  function rearmTimers() {
    const myToken = ++watchToken;
    startArmedWatch(myToken);
    scheduleIdleFade(myToken);
  }

  return {
    setPending(b, refHash, w, btn = 'left') {
      const myToken = ++watchToken; // supersede any prior watch → its loops exit
      box = b;
      referenceHash = refHash;
      wait = w;
      expectedButton = btn;
      pending = true;
      pointerFaded = false;         // pointer is currently shown
      d.log('debug', 'pointer pending', { wait: w, button: btn });
      startArmedWatch(myToken);
      scheduleIdleFade(myToken);
    },

    onClick(coords, button = 'left') {
      if (!pending || !box) return;
      // The click guard: the armed-watch poll has decided the drawn box is stale
      // (screen scrolled/navigated/switched tabs). Read synchronously — no post-click
      // capture, so a click that itself navigates can't be falsely rejected. A rejected
      // click leaves the armed-watch RUNNING (re-show still works) and bumps nothing.
      if (pointerFaded) {
        d.log('debug', 'click while screen changed (box faded) — ignored');
        return;
      }
      if (!clickInBox(coords, box, d.cfg.clickPadPt)) {
        d.log('debug', 'click outside box — ignored');
        return; // passive: do nothing, stay pending
      }
      // In-box on the right target — but the button must match. A correct click can
      // NEVER reach the nudge below: it exits at this gate. Only an in-box click with
      // the wrong button falls through to the nudge (stays pending, keeps the pointer).
      if (!buttonMatches(expectedButton, button)) {
        d.log('info', 'wrong button on target — nudging', { expected: expectedButton, got: button });
        rearmTimers(); // the user is actively trying → keep the pointer alive
        d.onWrongButton(expectedButton);
        return;
      }
      if (clickLatch) {
        d.log('debug', 'click already being processed — ignored');
        return; // a fast double-click: only the first advances
      }
      clickLatch = true;
      try {
        const w = wait;
        // Grab the pre-click baseline BEFORE we null it below — the caller settles its
        // next screenshot against this "screen at click time" frame.
        const baseline = referenceHash ?? [];
        // VALID: supersede the poll + idle timer, clear pending, hand off. The caller
        // runs its turn and will setPending again for the next step. We do NOT fade here
        // — the caller decides (it typically fades the old pointer before its turn).
        watchToken++;
        pending = false;
        box = null;
        referenceHash = null;
        d.log('info', 'valid click on pending pointer', { wait: w, button });
        d.onValidClick(w, baseline, button);
      } finally {
        clickLatch = false;
      }
    },

    clear() {
      watchToken++;         // stop the poll + idle timer
      pending = false;
      pointerFaded = false;
      box = null;
      referenceHash = null;
      d.log('debug', 'pointer watch cleared');
    },

    get pending() {
      return pending;
    },
  };
}
