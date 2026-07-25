import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { MeResponse } from '@kairo/shared';
import { createNativeBridge } from '../native/nativeBridge';
import { getAuthStatus, onAuthChanged, signOut, startGoogleAuth } from '../onboarding/authClient';
import { klog } from '../core/logger';
import './settings.css';

// Minimal account + billing settings, styled like the onboarding .ob-card (Editorial Light).
// Opened from the menu-bar tray → "Settings…". Upgrade shows ONLY for free users; Manage only Pro.
export function SettingsView() {
  const bridge = useMemo(() => createNativeBridge(), []);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const status = await getAuthStatus();
    setSignedIn(status.signed_in);
    if (status.signed_in) {
      const next = await bridge.fetchMe();
      setMe(next);
      if (next) void bridge.refreshTray(next.plan === 'pro');
    } else {
      setMe(null);
    }
    setLoading(false);
  }, [bridge]);

  useEffect(() => {
    void refresh();
    const unsubs: Array<() => void> = [];
    void onAuthChanged(() => void refresh()).then((u) => unsubs.push(u));
    void listen('billing:changed', () => void refresh()).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [refresh]);

  const isPro = me?.plan === 'pro';
  const used = me?.usage.used ?? 0;
  const limit = me?.usage.limit ?? 10;

  const handleLogout = async () => {
    setBusy(true);
    await signOut();
    await refresh();
    setBusy(false);
  };
  const handleUpgrade = async () => {
    setBusy(true);
    try {
      await bridge.startCheckout();
    } catch (error) {
      klog('notch', 'warn', 'checkout failed', { error: String(error) });
    }
    setBusy(false);
  };
  const handleManage = async () => {
    setBusy(true);
    try {
      await bridge.openBillingPortal();
    } catch (error) {
      klog('notch', 'warn', 'portal failed', { error: String(error) });
    }
    setBusy(false);
  };

  return (
    <div className="settings-scrim">
      <div className="settings-card">
        <div className="settings-brand">kairo</div>

        {loading ? (
          <p className="settings-muted">Loading…</p>
        ) : !signedIn ? (
          <>
            <h2 className="settings-title">You're signed out</h2>
            <p className="settings-muted">Sign in to use Kairo.</p>
            <button className="settings-btn settings-btn-primary" onClick={() => void startGoogleAuth()}>
              Sign in with Google
            </button>
          </>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-account">
                <div className="settings-name">
                  {me?.account_name ?? me?.display_name ?? 'Your account'}
                </div>
                <div className="settings-muted">{me?.user.email ?? ''}</div>
              </div>
              <button
                className="settings-btn settings-btn-ghost"
                disabled={busy}
                onClick={() => void handleLogout()}
              >
                Log out
              </button>
            </div>

            <div className="settings-plan">
              {isPro ? (
                <span className="settings-plan-badge settings-plan-pro">Kairo Pro · unlimited ✨</span>
              ) : (
                <span className="settings-plan-badge">
                  Free · {used} of {limit} requests used
                </span>
              )}
            </div>

            {isPro ? (
              <button
                className="settings-btn settings-btn-ghost"
                disabled={busy}
                onClick={() => void handleManage()}
              >
                Manage subscription
              </button>
            ) : (
              <button
                className="settings-btn settings-btn-primary"
                disabled={busy}
                onClick={() => void handleUpgrade()}
              >
                Upgrade to Pro — $10/mo
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
