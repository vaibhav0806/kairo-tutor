import { useEffect, useState } from 'react';
import { App } from './App';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { getBackendJwt } from './onboarding/authClient';
import { fetchMe } from './onboarding/backendClient';
import { klog } from './core/logger';

const ONBOARDED_KEY = 'kairo_onboarded';

/**
 * Main-window root: run the onboarding flow on first launch, otherwise the normal app shell.
 * A local flag short-circuits the check so returning users never see onboarding (and it works
 * offline); only unflagged users hit the backend to confirm.
 */
export function AppRoot() {
  const [state, setState] = useState<'checking' | 'show' | 'done'>('checking');

  useEffect(() => {
    if (localStorage.getItem(ONBOARDED_KEY) === '1') {
      klog('onboarding', 'info', 'AppRoot: local flag set → dashboard');
      setState('done');
      return;
    }
    let alive = true;
    void (async () => {
      const jwt = await getBackendJwt();
      if (!alive) return;
      if (!jwt) {
        klog('onboarding', 'info', 'AppRoot: no jwt → show onboarding');
        setState('show'); // not signed in yet → onboard
        return;
      }
      const me = await fetchMe(jwt);
      if (!alive) return;
      klog('onboarding', 'info', 'AppRoot: me checked', { onboarded: !!me?.onboarded });
      if (me?.onboarded) {
        localStorage.setItem(ONBOARDED_KEY, '1');
        setState('done');
      } else {
        setState('show');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state === 'checking') return null;
  if (state === 'show') {
    return (
      <OnboardingFlow
        onComplete={() => {
          localStorage.setItem(ONBOARDED_KEY, '1');
          setState('done');
        }}
      />
    );
  }
  return <App />;
}
