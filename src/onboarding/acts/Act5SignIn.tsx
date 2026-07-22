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
      {signedIn ? (
        <div className="ob-panel-body">
          <div className="ob-panel-icon is-done" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="ob-panel-kicker">you’re in</span>
          <p className="ob-panel-title">Signed in</p>
        </div>
      ) : (
        <div className="ob-panel-body">
          <div className="ob-panel-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l7 3v5c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="ob-panel-kicker">save your setup</span>
          <button type="button" className="ob-google-btn" onClick={() => void startGoogleAuth()}>
            <span className="ob-google-g" aria-hidden>
              <svg width="18" height="18" viewBox="0 0 48 48">
                <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
                <path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 17.1 2.1 20.4 2.1 24s.9 6.9 2.4 9.9l7.3-5.7z" />
                <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
              </svg>
            </span>
            Continue with Google
          </button>
        </div>
      )}
    </TempPanel>
  );
}

// Keep the ActProps contract available for typing at the mount site even though this act takes a
// richer callback (the orchestrator renders it explicitly, not via the generic ACTS map).
export type Act5SignInProps = Pick<ActProps, never> & { onSignedIn: (name: string) => void };
