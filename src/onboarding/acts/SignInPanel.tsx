import { useEffect, useState } from 'react';
import { klog } from '../../core/logger';
import { useCoach } from '../useCoach';
import { getAuthStatus, onAuthChanged, onAuthRejected, startGoogleAuth } from '../authClient';
import { syncUserName } from '../userName';
import { InlineNotice } from '../../components/InlineNotice';

/**
 * The front door's third panel: sign in, before anything in the product costs money.
 *
 * Deliberately part of the same card as the hero and the colour step rather than an act of its own.
 * Those three beats are one continuous first impression, and dropping a separate credential card
 * into the middle of the flow read as an interruption. The card collapses into the pet only once
 * this succeeds, so Kairo's first spoken line lands on a real account.
 *
 * Silent by design. Everything else in onboarding speaks; being talked at while reaching for a
 * password reads as pushy, so this panel says what it needs in text. There is no cached audio.
 *
 * The Google button opens the system browser; on the deep-link return the orchestrator window
 * regains focus. Once signed in we pull the user's name from `/v1/me` and cache it, then hand it
 * back for the warm ending and the account save.
 */
export function SignInPanel({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const { clear, bridge } = useCoach('');
  const [signedIn, setSignedIn] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  useEffect(() => {
    // No `say` here: this act is silent. Clear whatever the colour step left on the caption so the
    // card is not competing with a stale line.
    void clear();
    let un = () => {};
    let unRejected = () => {};
    void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    void onAuthChanged((s) => {
      if (!s) return;
      setRejected(null);
      setSignedIn(true);
    }).then((u) => {
      un = u;
    });
    void onAuthRejected(setRejected).then((u) => {
      unRejected = u;
    });
    // Belt-and-suspenders: re-check when the window regains focus (tab back from the browser).
    const recheck = () => void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    window.addEventListener('focus', recheck);
    return () => {
      un();
      unRejected();
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
    <div className="ob-signin">
        {signedIn ? (
          <span className="ob-signin-done">Signed in — one sec…</span>
        ) : (
          <>
            <span className="ob-signin-title">First, make it yours.</span>
            <span className="ob-signin-sub">Sign in with Google to save your setup.</span>
            {/* Official "Sign in with Google" — Light theme (white) per Google's branding guidelines;
                the crisp white button + neutral stroke sits cleanly on the light card. */}
            {rejected ? <InlineNotice>{rejected}</InlineNotice> : null}
            <button
              type="button"
              className="google-signin-btn"
              onClick={() => {
                setRejected(null);
                void startGoogleAuth();
              }}
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
  );
}
