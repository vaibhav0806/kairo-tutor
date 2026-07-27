import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { hasManageableSubscription, type MeResponse } from '@kairo/shared';
import { createNativeBridge, type NativePermissionStatus, type NativePermissionKey } from '../native/nativeBridge';
import { getAuthStatus, onAuthChanged, signOut, startGoogleAuth } from '../onboarding/authClient';
import { getAccent, setAccent, DEFAULT_ACCENT } from '../core/accent';
import { klog } from '../core/logger';
import { KairoLockup } from '../components/KairoMark';
import { ACCENT_PRESETS } from '../onboarding/accentPresets';
import './settings.css';

type SkillInfo = { slug: string; name: string; description: string; enabled: boolean };

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
  const [actionError, setActionError] = useState('');

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

  useEffect(() => {
    void refresh();
    void loadExtras();
    const unsubs: Array<() => void> = [];
    void onAuthChanged(() => {
      void refresh();
      void loadExtras();
    }).then((u) => unsubs.push(u));
    void listen('billing:changed', () => void refresh()).then((u) => unsubs.push(u));
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
  }, [refresh, loadExtras]);

  const isPro = me?.plan === 'pro';
  const canManageSubscription = Boolean(
    isPro && me && hasManageableSubscription(me.status)
  );

  const applyAccent = async (hex: string) => {
    setAccentState(hex);
    await setAccent(hex);
  };
  const saveName = async () => {
    const trimmed = name.trim();
    await bridge.setUserName(trimmed);
    setSavedName(trimmed);
  };
  const toggleSkill = async (slug: string, enabled: boolean) => {
    setSkills((prev) => prev.map((s) => (s.slug === slug ? { ...s, enabled } : s)));
    await invoke('set_skill_enabled', { slug, enabled }).catch(() => {});
  };
  const toggleLaunch = async (enabled: boolean) => {
    setLaunch(enabled);
    await invoke('set_launch_at_login', { enabled }).catch(() => {});
  };
  const withBusy = (fn: () => Promise<void>) => async () => {
    setActionError('');
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      const message = String(error).replace(/^.*?:\s*/, '');
      setActionError(message);
      klog('settings', 'warn', 'settings action failed', { error: String(error) });
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
          <button className="s-btn s-btn-primary" onClick={() => void startGoogleAuth()}>
            Sign in with Google
          </button>
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
            <button className="s-btn s-btn-ghost" disabled={busy} onClick={withBusy(async () => {
              await signOut();
              await refresh();
            })}>
              Log out
            </button>
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
          {canManageSubscription ? (
            <button className="s-btn s-btn-ghost" disabled={busy} onClick={withBusy(() => bridge.openBillingPortal())}>
              {busy ? 'Opening…' : 'Manage subscription'}
            </button>
          ) : !isPro ? (
            <button className="s-btn s-btn-primary" disabled={busy} onClick={withBusy(() => bridge.startCheckout())}>
              Upgrade to Pro — $10/mo
            </button>
          ) : (
            <p className="settings-muted">Complimentary access · no subscription to manage</p>
          )}
          {actionError ? (
            <p className="s-action-error" role="alert">
              {actionError}
            </p>
          ) : null}
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
            <button className="s-btn s-btn-ghost" disabled={name.trim() === savedName.trim()} onClick={() => void saveName()}>
              Save
            </button>
          </div>
        </section>

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
              <button className="s-btn s-btn-ghost" onClick={() => setSkillsOpen(true)}>
                Manage
              </button>
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
                    <button
                      className="s-btn s-btn-mini"
                      onClick={async () => {
                        await bridge.openPermissionSettings(key);
                      }}
                    >
                      Grant
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* Launch at login */}
        <section className="s-section">
          <div className="settings-row s-item">
            <div className="s-item-name">Launch at login</div>
            <Toggle checked={launchAtLogin} onChange={(v) => void toggleLaunch(v)} />
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

      {skillsOpen && (
        <div className="s-modal-scrim" onClick={() => setSkillsOpen(false)}>
          <div className="s-modal" onClick={(e) => e.stopPropagation()}>
            <div className="s-modal-head">
              <span className="s-modal-title">Skills</span>
              <button className="s-btn s-btn-ghost" onClick={() => setSkillsOpen(false)}>
                Done
              </button>
            </div>
            <p className="settings-muted">Uncheck a skill to hide it from Kairo entirely.</p>
            <div className="s-modal-list">
              {skills.map((s) => (
                <label className="s-check-row" key={s.slug}>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => void toggleSkill(s.slug, e.target.checked)}
                  />
                  <span className="s-check-body">
                    <span className="s-item-name">{s.name}</span>
                    <span className="settings-muted s-check-desc">{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`s-toggle${checked ? ' s-toggle-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="s-toggle-knob" />
    </button>
  );
}
