import { useEffect, useState } from 'react';
import { klog } from '../../core/logger';
import { useCoach } from '../useCoach';
import { ACT5_SIGNIN } from '../copy';
import { getAuthStatus, onAuthChanged, startGoogleAuth } from '../authClient';
import { syncUserName } from '../userName';
import { TempPanel } from './TempPanel';
import type { ActProps } from './actTypes';

/**
 * Act 5a — sign in (master spec §4). The Google button opens the system browser; on the deep-link
 * return the orchestrator window regains focus (already built). Once signed in we pull the user's
 * name from `/v1/me` (Google profile → account) and cache it, then advance — the resolved name is
 * held by the orchestrator for the warm ending + the account save.
 */
export function Act5SignIn({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const { say, clear } = useCoach('');
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    void say(ACT5_SIGNIN); // caption == the spoken line
    let un = () => {};
    void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    void onAuthChanged((s) => s && setSignedIn(true)).then((u) => {
      un = u;
    });
    // Belt-and-suspenders: re-check when the window regains focus (tab back from the browser).
    const recheck = () => void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    window.addEventListener('focus', recheck);
    return () => {
      un();
      window.removeEventListener('focus', recheck);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void syncUserName().then((name) => {
      klog('onboarding', 'info', 'act5 signed in', { name_len: name.length });
      void clear();
      onSignedIn(name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  return (
    <TempPanel>
      {signedIn ? (
        <div className="ob-signed">
          <span className="ob-check">✓</span> signed in
        </div>
      ) : (
        <button type="button" className="ob-cta" onClick={() => void startGoogleAuth()}>
          Continue with Google
        </button>
      )}
    </TempPanel>
  );
}

// Keep the ActProps contract available for typing at the mount site even though this act takes a
// richer callback (the orchestrator renders it explicitly, not via the generic ACTS map).
export type Act5SignInProps = Pick<ActProps, never> & { onSignedIn: (name: string) => void };
