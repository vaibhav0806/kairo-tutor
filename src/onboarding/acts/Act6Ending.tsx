import { useEffect, useMemo } from 'react';
import { createNativeBridge } from '../../native/nativeBridge';
import { getAccent } from '../../core/accent';
import { klog } from '../../core/logger';
import { useVoice } from '../useVoice';
import { act6Ending } from '../copy';
import { setCoachCaption } from '../coachSurface';
import { getBackendJwt } from '../authClient';
import { saveOnboarding } from '../backendClient';

/**
 * Act 6 — warm ending (master spec §4, §9 peak-END). Speaks a name-personalized sign-off in the
 * real notch, persists name + accent + source to the account, caches the name natively (so the live
 * product knows it — §12), then finishes (the pet retreats naturally via the product's normal
 * post-turn backoff; no special graduation choreography).
 */
export function Act6Ending({
  name,
  source,
  onComplete
}: {
  name: string;
  source: string;
  onComplete: () => void;
}) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await setCoachCaption(bridge, { title: "You're all set", detail: '' });
      void voice.speak(act6Ending(name), name);

      // Persist name + accent + source to the account; cache the name natively for the notch.
      const jwt = await getBackendJwt();
      const accent = await getAccent(); // Phase 0
      if (jwt) {
        const ok = await saveOnboarding(jwt, name || 'there', source || 'unknown', accent);
        klog('onboarding', 'info', 'onboarding saved', { ok, name_len: name.length, accent });
      }
      await bridge.setUserName(name);

      // Let the sign-off finish, then finish onboarding (drops to Accessory; product goes live).
      await new Promise((r) => setTimeout(r, 2600));
      if (!cancelled) onComplete();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null; // the sign-off lives in the notch caption; the pet settles toward it
}
