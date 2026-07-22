// The coach surface: the two low-level primitives that push Kairo's caption into the REAL notch
// panel using the Phase-0 'coach' state (rendered by the Phase-1 modern notch as a caption line +
// optional chip). The onboarding acts never call these directly — they go through `useCoach`, which
// guarantees the caption stays in sync with the voice. Kept tiny on purpose.
import type { NativeBridge } from '../native/nativeBridge';
import type { NotchPayload } from '../notch/types';
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
