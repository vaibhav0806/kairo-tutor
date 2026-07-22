import { useEffect } from 'react';
import { getAccent } from '../../core/accent';
import { klog } from '../../core/logger';
import { useCoach } from '../useCoach';
import { act6Ending } from '../copy';
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
  const { say, bridge } = useCoach(name);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Persist name + accent + source in the background — it must not delay the sign-off.
      void (async () => {
        const jwt = await getBackendJwt();
        const accent = await getAccent(); // Phase 0
        if (jwt) {
          const ok = await saveOnboarding(jwt, name || 'there', source || 'unknown', accent);
          klog('onboarding', 'info', 'onboarding saved', { ok, name_len: name.length, accent });
        }
        await bridge.setUserName(name); // cache the name natively for the notch (§12)
      })();

      // The warm sign-off: notch caption == the spoken line.
      await say(act6Ending(name));
      // Let it land (peak-end), then finish onboarding (drops to Accessory; product goes live).
      await new Promise((r) => setTimeout(r, 1200));
      if (!cancelled) onComplete();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null; // the sign-off lives in the notch caption; the pet settles toward it
}
