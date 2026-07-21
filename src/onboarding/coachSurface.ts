// The coach surface: onboarding pushes Kairo's spoken caption into the REAL notch panel using the
// Phase-0 'coach' state (rendered by the Phase-1 modern notch as a caption line + optional chip).
// This is deliberately tiny — the notch is Kairo's real home, so by the end the user already knows
// where Kairo lives (master spec §3).
import type { NativeBridge } from '../native/nativeBridge';
import type { NotchPayload } from '../notch/types';
import type { Segment } from './copy';
import { klog } from '../core/logger';

export type CoachCaption = { title: string; detail: string; chip?: string };

/** Show (or update) the caption in the real notch. */
export async function setCoachCaption(bridge: NativeBridge, c: CoachCaption): Promise<void> {
  const payload: NotchPayload = {
    state: 'coach',
    layout: 'compact',
    title: c.title,
    detail: c.detail,
    ...(c.chip ? { chip: c.chip } : {})
  };
  klog('onboarding', 'info', 'coach caption', { detail_len: c.detail.length, chip: !!c.chip });
  await bridge.showNotch(payload);
}

/** Clear the caption (hide the notch) between acts. */
export async function clearCoachCaption(bridge: NativeBridge): Promise<void> {
  await bridge.hideNotch();
}

/**
 * Speak a scripted line via the passed `speak` (useVoice.speak) AND mirror it as the notch caption,
 * so the words the user hears are the words on screen. Resolves when speech ends; the caption stays
 * up (sticky) until the next set/clear.
 */
export async function coachSay(
  bridge: NativeBridge,
  speak: (segments: Segment[], name: string) => Promise<void>,
  segments: Segment[],
  name: string,
  opts: { title: string; chip?: string }
): Promise<void> {
  const detail = segments
    .map((s) => s.text(name))
    .join(' ')
    .trim();
  await setCoachCaption(bridge, { title: opts.title, detail, chip: opts.chip });
  await speak(segments, name);
}
