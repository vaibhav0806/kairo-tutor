import { useEffect, useState } from 'react';
import { klog } from '../../core/logger';
import { useCoach } from '../useCoach';
import { ACT5_SIGNIN } from '../copy';
import { getAuthStatus, onAuthChanged, startGoogleAuth } from '../authClient';
import { syncUserName } from '../userName';
import { TempPanel } from './TempPanel';

/**
 * Act 5a — sign in (master spec §4). The Google button opens the system browser; on the deep-link
 * return the orchestrator window regains focus (already built). Once signed in we pull the user's
 * name from `/v1/me` (Google profile → account) and cache it, then advance — the resolved name is
 * held by the orchestrator for the warm ending + the account save.
 */
export function Act5SignIn({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const { say, clear, bridge } = useCoach('');
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
      // Pull focus back to Kairo from the OAuth browser BEFORE the next step starts talking.
      void bridge.focusOnboarding();
      void clear();
      onSignedIn(name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  return (
    <TempPanel>
      <div className="ob-signin">
        <span className="ob-signin-mark">Kairo</span>
        {signedIn ? (
          <span className="ob-signin-done">Signed in — one sec…</span>
        ) : (
          <>
            <span className="ob-signin-sub">Sign in to save your setup</span>
            {/* Official "Sign in with Google" — Light theme (white) per Google's branding guidelines;
                the crisp white button is the always-safe placement on a near-black card. */}
            <button
              type="button"
              className="google-signin-btn"
              onClick={() => void startGoogleAuth()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              <span>Continue with Google</span>
            </button>
          </>
        )}
      </div>
    </TempPanel>
  );
}
