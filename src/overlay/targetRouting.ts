import type { VisualTarget } from '../core/types';
import { klog } from '../core/logger';
import type { NativeBridge, NativeOverlayDisplayBounds } from '../native/nativeBridge';
import { DRAW_APPROACH_MS, DRAW_DURATION_MS, boxCornerRegions } from '../core/penDraw';

// Target kinds the companion cursor flies to. The overlay suppresses a duplicate
// point cursor when a persistent highlight is already on screen.
export const POINT_KINDS: ReadonlySet<VisualTarget['kind']> = new Set(['pointer']);

// How a box arrives on screen: `draw` = the pet drags it into existence (first
// reveal); `glide` = the same box slides to the next walkthrough step's target.
export type RevealTransition = 'draw' | 'glide';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single source of truth for how an answer's visual targets reach the screen.
// The primary point-like target drives the companion cursor; persistent shapes
// render in the overlay so the user gets a stable visual explanation.
export async function routeVisualTargets(
  nativeBridge: Pick<NativeBridge, 'cursorPoint' | 'cursorDrag' | 'showOverlay' | 'hideOverlay'>,
  targets: VisualTarget[],
  displayBounds: NativeOverlayDisplayBounds,
  transition: RevealTransition = 'draw',
  // Multi-point turns pass the ACCUMULATED boxes (every box drawn so far this turn) so
  // they all stay on screen, and name which one is new — otherwise `.find()` below picks
  // the oldest box and the pet re-draws the first target on every step.
  drawTargetId?: string
): Promise<void> {
  const boxTarget =
    (drawTargetId
      ? targets.find(
          (target) => target.kind === 'highlight_box' && target.targetId === drawTargetId
        )
      : undefined) ?? targets.find((target) => target.kind === 'highlight_box');
  const pointTarget = targets.find((target) => POINT_KINDS.has(target.kind)) ?? targets[0];
  const targetSummary = targets
    .map(
      (target) =>
        `${target.kind}:${target.label}[${target.screenRegion.x.toFixed(1)},${target.screenRegion.y.toFixed(1)},${target.screenRegion.width.toFixed(1)},${target.screenRegion.height.toFixed(1)}]`
    )
    .join(' | ');

  klog('overlay', 'debug', 'route visual targets', {
    target_count: targets.length,
    transition,
    point_target: pointTarget ? `${pointTarget.kind}:${pointTarget.label}` : 'none',
    bounds: `${displayBounds.x.toFixed(1)},${displayBounds.y.toFixed(1)},${displayBounds.width.toFixed(1)},${displayBounds.height.toFixed(1)},${displayBounds.scaleFactor.toFixed(3)}`,
    targets: targetSummary
  });

  // First reveal of a box: the pet flies to the top-left corner, then drags the
  // box into existence along the diagonal. Hold the box hidden during that
  // approach so it appears exactly when the drag begins (welded to the cursor).
  if (transition === 'draw' && boxTarget) {
    const { fromRegion, toRegion } = boxCornerRegions(boxTarget.screenRegion);
    await nativeBridge.cursorDrag({
      fromRegion,
      toRegion,
      displayBounds,
      durationMs: DRAW_DURATION_MS,
      approachMs: DRAW_APPROACH_MS,
      color: boxTarget.color
    });
    await delay(DRAW_APPROACH_MS);
    await nativeBridge.showOverlay({ displayBounds, targets });
    return;
  }

  // Point-only reveal, or a glide of an already-drawn box to the next target: the
  // cursor springs and the box slides (CSS transition) to the new position.
  if (pointTarget) {
    await nativeBridge.cursorPoint({
      screenRegion: pointTarget.screenRegion,
      displayBounds,
      color: pointTarget.color
    });
  }

  if (targets.length > 0) {
    await nativeBridge.showOverlay({ displayBounds, targets });
  } else {
    await nativeBridge.hideOverlay();
  }
}

// Tear-down counterpart: clear the overlay and glide the cursor back to the mouse.
export async function releaseVisualTargets(
  nativeBridge: Pick<NativeBridge, 'cursorRelease' | 'hideOverlay'>
): Promise<void> {
  await nativeBridge.hideOverlay();
  await nativeBridge.cursorRelease();
}
