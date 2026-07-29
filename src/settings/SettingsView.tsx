import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Switch } from '@base-ui/react/switch';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { hasManageableSubscription, type MeResponse } from '@kairo/shared';
import { createNativeBridge, type NativePermissionStatus, type NativePermissionKey } from '../native/nativeBridge';
import { getAuthStatus, onAuthChanged, signOut, startGoogleAuth } from '../onboarding/authClient';
import { getAccent, setAccent, DEFAULT_ACCENT } from '../core/accent';
import { klog } from '../core/logger';
import { notify, notifySaving } from '../core/notify';
import { KairoLockup } from '../components/KairoMark';
import { KButton } from '../components/KButton';
import { VoiceSettings } from './VoiceSettings';
import { SkillsDialog, type SkillInfo } from './SkillsDialog';
import { UpdateSettings } from './UpdateSettings';
import { ACCENT_PRESETS } from '../onboarding/accentPresets';
import {
  billingNotice,
  normalizeBillingReturnStatus,
  shouldContinueBillingPoll,
  type BillingReturnStatus,
} from './billingState';
import './settings.css';

const PERMISSIONS: { key: NativePermissionKey; label: string }[] = [
  { key: 'screenRecording', label: 'Screen Recording' },
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'microphone', label: 'Microphone' },
];

export function SettingsView() {
  const bridge = useMemo(() => createNativeBridge(), []);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [accent, setAccentState] = useState(DEFAULT_ACCENT);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [perms, setPerms] = useState<NativePermissionStatus | null>(null);
  const [launchAtLogin, setLaunch] = useState(false);
  const [version, setVersion] = useState('');
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [billingReturnStatus, setBillingReturnStatus] = useState<BillingReturnStatus>('unknown');

  const startWindowDrag = useCallback(() => {
    klog('settings', 'debug', 'titlebar drag started');
    void getCurrentWindow().startDragging().catch((error) => {
      klog('settings', 'warn', 'window drag failed', { error: String(error) });
    });
  }, []);

  // The main window is the big permission-recovery window; shrink it to hug the settings card.
  useEffect(() => {
    void getCurrentWindow().setSize(new LogicalSize(460, 720)).catch(() => {});
  }, []);

  const refresh = useCallback(async (): Promise<MeResponse | null> => {
    const status = await getAuthStatus();
    setSignedIn(status.signed_in);
    if (status.signed_in) {
      const next = await bridge.fetchMe();
      setMe(next);
      if (next) void bridge.refreshTray(next.plan === 'pro');
      setLoading(false);
      return next;
    } else {
      setMe(null);
    }
    setLoading(false);
    return null;
  }, [bridge]);

  const loadExtras = useCallback(async () => {
    const storedAccent = await getAccent().catch(() => DEFAULT_ACCENT);
    const curatedAccent = ACCENT_PRESETS.find(
      (preset) => preset.hex.toLowerCase() === storedAccent.toLowerCase()
    )?.hex;
    const nextAccent = curatedAccent ?? DEFAULT_ACCENT;
    setAccentState(nextAccent);
    if (!curatedAccent) {
      klog('settings', 'info', 'legacy custom accent reset to curated default');
      await setAccent(nextAccent);
    }
    const n = await bridge.getUserName().catch(() => '');
    setName(n);
    setSavedName(n);
    setSkills(await invoke<SkillInfo[]>('list_skills').catch(() => []));
    setPerms(await bridge.getPermissionStatus().catch(() => null));
    setLaunch(await invoke<boolean>('get_launch_at_login').catch(() => false));
    setVersion(await getVersion().catch(() => ''));
  }, [bridge]);

  const reconcileAndRefresh = useCallback(async () => {
    // A browser return can beat Dodo's final subscription state. Keep polling only while the
    // provider is genuinely pending or /v1/me has not caught up with the reconciled snapshot.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await bridge.syncBilling().catch((error) => {
        klog('settings', 'warn', 'billing reconciliation attempt failed', {
          attempt,
          error: String(error),
        });
        return { synced: false, status: undefined };
      });
      const next = await refresh();
      klog('settings', 'info', 'billing state refreshed', {
        attempt,
        synced: result.synced,
        plan: next?.plan ?? 'unknown',
        status: next?.status ?? 'unknown',
      });
      if (next?.plan === 'pro') setBillingReturnStatus('unknown');
      if (result.synced && !shouldContinueBillingPoll(result.status, next)) break;
      await new Promise((resolve) => window.setTimeout(resolve, attempt * 750));
    }
  }, [bridge, refresh]);

  useEffect(() => {
    void refresh();
    void loadExtras();
    const unsubs: Array<() => void> = [];
    void onAuthChanged(() => {
      void refresh();
      void loadExtras();
    }).then((u) => unsubs.push(u));
    void listen<string>('billing:changed', (event) => {
      const returnStatus = normalizeBillingReturnStatus(event.payload);
      setBillingReturnStatus(returnStatus);
      klog('settings', 'info', 'billing browser return received', { returnStatus });
      void reconcileAndRefresh();
    }).then((u) => unsubs.push(u));
    void listen('settings:open', () => {
      void refresh();
      void loadExtras();
    }).then((u) => unsubs.push(u));
    // Re-fetch whenever the window regains focus — the plan can change out-of-band (checkout in the
    // browser, a webhook landing) so the Upgrade/Manage state must never show a stale cache.
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    unsubs.push(() => window.removeEventListener('focus', onFocus));
    return () => unsubs.forEach((u) => u());
  }, [refresh, loadExtras, reconcileAndRefresh]);

  const isPro = me?.plan === 'pro';
  const isPending = me?.status === 'pending';
  const canManageSubscription = Boolean(
    isPro && me && hasManageableSubscription(me.status)
  );
  const periodLabel = me?.renews_at
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(
        new Date(me.renews_at),
      )
    : '';
  const planNotice = billingNotice(me, billingReturnStatus);

  const applyAccent = async (hex: string) => {
    setAccentState(hex);
    await setAccent(hex);
  };
  const saveName = async () => {
    const trimmed = name.trim();
    await notifySaving(bridge.setUserName(trimmed), {
      pending: 'Saving…',
      success: trimmed ? `Kairo will call you ${trimmed}` : 'Name cleared'
    });
    setSavedName(trimmed);
  };
  // Optimistic: flip the switch now, revert it if the native call fails. Both of these used to
  // swallow the error (`.catch(() => {})`), which left the UI showing a state the app was not in.
  const toggleSkill = async (slug: string, enabled: boolean) => {
    const revert = () => setSkills((prev) => prev.map((s) => (s.slug === slug ? { ...s, enabled: !enabled } : s)));
    setSkills((prev) => prev.map((s) => (s.slug === slug ? { ...s, enabled } : s)));
    try {
      await invoke('set_skill_enabled', { slug, enabled });
    } catch (error) {
      klog('settings', 'warn', 'skill toggle failed', { slug, error: String(error) });
      revert();
      notify({ tone: 'error', message: "Couldn't change that skill", detail: String(error).replace(/^.*?:\s*/, '') });
    }
  };
  const toggleLaunch = async (enabled: boolean) => {
    setLaunch(enabled);
    try {
      await invoke('set_launch_at_login', { enabled });
    } catch (error) {
      klog('settings', 'warn', 'launch-at-login toggle failed', { error: String(error) });
      setLaunch(!enabled);
      notify({ tone: 'error', message: "Couldn't change launch at login" });
    }
  };
  const withBusy = (fn: () => Promise<void>, failure: string) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      const message = String(error).replace(/^.*?:\s*/, '');
      klog('settings', 'warn', 'settings action failed', { error: String(error) });
      notify({ tone: 'error', message: failure, detail: message });
    }
    setBusy(false);
  };

  if (loading) {
    return (
      <div className="settings-scrim">
        <div className="settings-window-titlebar" onPointerDown={startWindowDrag} />
        <div className="settings-card">
          <p className="settings-muted">Loading…</p>
        </div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="settings-scrim">
        <div className="settings-window-titlebar" onPointerDown={startWindowDrag} />
        <div className="settings-card">
          <KairoLockup className="settings-brand" />
          <h2 className="settings-h2">You're signed out</h2>
          <p className="settings-muted">Sign in to use Kairo.</p>
          <KButton onClick={() => void startGoogleAuth()}>Sign in with Google</KButton>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-scrim">
      <div className="settings-window-titlebar" onPointerDown={startWindowDrag} />
      <div className="settings-card">
        <div className="settings-head">
          <KairoLockup className="settings-brand" />
          <span className="settings-title">Settings</span>
        </div>

        {/* Account */}
        <section className="s-section">
          <div className="settings-row">
            <div className="settings-account">
              <div className="settings-name">{me?.account_name ?? me?.display_name ?? 'Your account'}</div>
              <div className="settings-muted">{me?.user.email ?? ''}</div>
            </div>
            <KButton
              variant="ghost"
              busy={busy}
              onClick={withBusy(async () => {
                await signOut();
                await refresh();
              }, "Couldn't sign you out")}
            >
              Log out
            </KButton>
          </div>
        </section>

        {/* Plan */}
        <section className="s-section">
          <div className="s-label">Plan</div>
          <div className="settings-plan">
            {isPro ? (
              <span className="settings-plan-badge settings-plan-pro">Kairo Pro · unlimited</span>
            ) : (
              <span className="settings-plan-badge">
                Free · {me?.usage.used ?? 0} of {me?.usage.limit ?? 10} used
              </span>
            )}
          </div>
          {planNotice ? (
            <div className={`s-billing-notice s-billing-notice-${planNotice.tone}`} role={planNotice.tone === 'error' ? 'alert' : 'status'}>
              <strong>{planNotice.title}</strong>
              <span>{planNotice.body}</span>
            </div>
          ) : null}
          {isPro && me?.cancel_at_period_end ? (
            <p className="settings-muted">
              Cancels at the end of your billing period{periodLabel ? ` · ${periodLabel}` : ''}
            </p>
          ) : isPro && me?.status === 'on_hold' ? (
            <p className="settings-muted">Payment needs attention · update it in subscription settings</p>
          ) : null}
          {canManageSubscription ? (
            <KButton
              variant="ghost"
              busy={busy}
              onClick={withBusy(() => bridge.openBillingPortal(), "Couldn't open subscription settings")}
            >
              {busy ? 'Opening…' : 'Manage subscription'}
            </KButton>
          ) : isPending ? (
            <KButton disabled>Waiting for payment confirmation…</KButton>
          ) : !isPro ? (
            <KButton
              busy={busy}
              onClick={withBusy(() => bridge.startCheckout(), "Couldn't start checkout")}
            >
              {me?.status === 'failed' ? 'Try upgrading again — $10/mo' : 'Upgrade to Pro — $10/mo'}
            </KButton>
          ) : (
            <p className="settings-muted">Complimentary access · no subscription to manage</p>
          )}
        </section>

        {/* Display name */}
        <section className="s-section">
          <div className="s-label">Call me</div>
          <div className="settings-row">
            <input
              className="s-input"
              value={name}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveName();
              }}
            />
            <KButton
              variant="ghost"
              disabled={name.trim() === savedName.trim()}
              onClick={() => void saveName()}
            >
              Save
            </KButton>
          </div>
        </section>

        {/* Voice — engine + speaker, both stored server-side */}
        <VoiceSettings bridge={bridge} />

        {/* Accent color */}
        <section className="s-section">
          <div className="s-label">Accent color</div>
          <div className="s-swatches">
            {ACCENT_PRESETS.map(({ hex, name }) => (
              <button
                key={hex}
                className={`s-swatch${accent.toLowerCase() === hex.toLowerCase() ? ' s-swatch-active' : ''}`}
                style={{ background: hex }}
                aria-label={name}
                title={name}
                onClick={() => void applyAccent(hex)}
              />
            ))}
          </div>
        </section>

        {/* Skills — opens a scrollable modal with checkboxes */}
        {skills.length > 0 && (
          <section className="s-section">
            <div className="settings-row s-item">
              <div className="settings-account">
                <div className="s-item-name">Skills</div>
                <div className="settings-muted s-item-desc">
                  {skills.filter((s) => s.enabled).length} of {skills.length} enabled
                </div>
              </div>
              <KButton variant="ghost" onClick={() => setSkillsOpen(true)}>
                Manage
              </KButton>
            </div>
          </section>
        )}

        {/* Permissions */}
        {perms && (
          <section className="s-section">
            <div className="s-label">Permissions</div>
            {PERMISSIONS.map(({ key, label }) => {
              const granted = perms[key] === 'granted';
              return (
                <div className="settings-row s-item" key={key}>
                  <div className="s-item-name">{label}</div>
                  {granted ? (
                    <span className="s-ok">Granted</span>
                  ) : (
                    <KButton
                      variant="mini"
                      onClick={() => void bridge.openPermissionSettings(key)}
                    >
                      Grant
                    </KButton>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* Software update */}
        <UpdateSettings bridge={bridge} version={version} />

        {/* Launch at login */}
        <section className="s-section">
          <div className="settings-row s-item">
            <div className="s-item-name">Launch at login</div>
            <Toggle
              checked={launchAtLogin}
              label="Launch at login"
              onChange={(v) => void toggleLaunch(v)}
            />
          </div>
        </section>

        {/* Footer */}
        <div className="settings-foot">
          <button className="s-link" onClick={() => void invoke('open_external', { url: 'https://meetkairo.xyz' })}>
            Visit website ↗
          </button>
          {version && <span className="settings-muted">v{version}</span>}
        </div>
      </div>

      <SkillsDialog
        skills={skills}
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
        onToggle={(slug, enabled) => void toggleSkill(slug, enabled)}
      />
    </div>
  );
}

/**
 * The switch. Base UI owns the behaviour (correct switch semantics, keyboard, focus, form
 * integration); the look is ours. Geometry follows macOS — the knob stretches while pressed and
 * settles on release — and the "on" fill is the user's accent rather than the system green, so
 * Settings reads as theirs.
 */
function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <Switch.Root
      aria-label={label}
      checked={checked}
      onCheckedChange={onChange}
      className="kswitch"
    >
      <Switch.Thumb className="kswitch-knob" />
    </Switch.Root>
  );
}
