import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { NativeBridge, NativeUpdateInfo } from '../native/nativeBridge';
import { klog } from '../core/logger';
import { notify } from '../core/notify';
import { KButton } from '../components/KButton';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; info: NativeUpdateInfo }
  | { kind: 'installing'; percent: number | null }
  | { kind: 'error'; message: string };

/**
 * Software update. The alpha ships unnotarized and installs via a quarantine command, so the
 * updater is what keeps that one-time cost from repeating on every fix: updater-installed bundles
 * are not browser-quarantined.
 */
export function UpdateSettings({ bridge, version }: { bridge: NativeBridge; version: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const check = useCallback(
    async (manual: boolean) => {
      setState({ kind: 'checking' });
      try {
        const info = await bridge.checkForUpdate();
        setState(info ? { kind: 'available', info } : { kind: 'current' });
      } catch (err) {
        // A background check that cannot reach the endpoint stays quiet; a manual one must say so,
        // otherwise the button looks broken.
        klog('settings', 'warn', 'update check failed', { error: String(err), manual });
        setState(manual ? { kind: 'error', message: "Couldn't reach the update server." } : { kind: 'idle' });
        // A manual check is an action the user just took, so it also announces itself — the row
        // text alone is easy to miss when the window is tall.
        if (manual) {
          notify({
            tone: 'error',
            message: "Couldn't reach the update server",
            detail: 'Check your connection and try again.',
            action: { label: 'Retry', onClick: () => void check(true) }
          });
        }
      }
    },
    [bridge],
  );

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    // The background poll lives in native code and fires whether or not this window is open.
    void listen<NativeUpdateInfo>('updater:available', (event) => {
      setState({ kind: 'available', info: event.payload });
    }).then((u) => unsubs.push(u));
    void listen<{ downloaded: number; total: number | null }>('updater:progress', (event) => {
      const { downloaded, total } = event.payload;
      setState({ kind: 'installing', percent: total ? Math.round((downloaded / total) * 100) : null });
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, []);

  const install = async () => {
    setState({ kind: 'installing', percent: null });
    try {
      // On success the app restarts into the new build, so nothing after this runs.
      await bridge.installUpdate();
    } catch (err) {
      klog('settings', 'warn', 'update install failed', { error: String(err) });
      const message = String(err).replace(/^.*?:\s*/, '');
      setState({ kind: 'error', message });
      notify({ tone: 'error', message: "Couldn't install the update", detail: message });
    }
  };

  const busy = state.kind === 'checking' || state.kind === 'installing';

  return (
    <section className="s-section">
      <div className="settings-row s-item">
        <div className="settings-account">
          <div className="s-item-name">Software update</div>
          <div className="settings-muted s-item-desc">
            {state.kind === 'available'
              ? `Version ${state.info.version} is ready to install.`
              : state.kind === 'installing'
                ? state.percent === null
                  ? 'Downloading…'
                  : `Downloading… ${state.percent}%`
                : state.kind === 'checking'
                  ? 'Checking…'
                  : state.kind === 'current'
                    ? "You're on the latest version."
                    : state.kind === 'error'
                      ? state.message
                      : version
                        ? `You're on v${version}.`
                        : 'Check for a newer version.'}
          </div>
        </div>
        {state.kind === 'available' ? (
          <KButton busy={busy} onClick={() => void install()}>
            Update &amp; restart
          </KButton>
        ) : (
          <KButton variant="ghost" busy={busy} onClick={() => void check(true)}>
            Check
          </KButton>
        )}
      </div>
    </section>
  );
}
