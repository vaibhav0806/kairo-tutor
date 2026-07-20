import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadBrowserEnv } from './config/env';
import {
  createNativeBridge,
  type NativePermissionState,
  type NativePermissionStatus
} from './native/nativeBridge';

// The main window is normally hidden. Rust only reveals it on first run when TCC
// permissions still need granting (see lib.rs setup). So this component is purely
// the permission-recovery screen — the live tutor UI lives in the notch WebView.

function isPermissionGranted(
  status: NativePermissionStatus,
  permission: keyof NativePermissionStatus
) {
  return status[permission] === 'granted';
}

function permissionStateLabel(state: NativePermissionState) {
  if (state === 'granted') {
    return 'Granted';
  }

  if (state === 'denied') {
    return 'Needs access';
  }

  if (state === 'not_determined') {
    return 'Needs setup';
  }

  return 'Checking';
}

export function App() {
  const env = loadBrowserEnv();
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const requiredPermissions = useMemo(
    () =>
      [
        {
          key: 'accessibility' as const,
          label: 'Accessibility',
          detail: 'Lets Kairo identify the active app and focused window.'
        },
        {
          key: 'screenRecording' as const,
          label: 'Screen Recording',
          detail: 'Lets Kairo inspect the active screen before giving visual guidance.'
        },
        ...(env.sttProvider === 'sarvam'
          ? [
              {
                key: 'microphone' as const,
                label: 'Microphone',
                detail: 'Lets Kairo listen when voice input is enabled.'
              }
            ]
          : [])
      ],
    [env.sttProvider]
  );
  const [permissions, setPermissions] = useState<NativePermissionStatus>({
    screenRecording: 'unknown',
    accessibility: 'unknown',
    microphone: 'unknown'
  });
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);

  const refreshPermissionStatus = useCallback(async () => {
    setPermissions(await nativeBridge.getPermissionStatus());
  }, [nativeBridge]);

  const requestRequiredPermissions = useCallback(async () => {
    setIsRequestingPermissions(true);
    try {
      const nextPermissions = await nativeBridge.requestRequiredPermissions();
      setPermissions(nextPermissions);

      if (env.sttProvider === 'sarvam' && nextPermissions.microphone !== 'granted') {
        await nativeBridge.openPermissionSettings('microphone');
      }
    } finally {
      setIsRequestingPermissions(false);
    }
  }, [env.sttProvider, nativeBridge]);

  useEffect(() => {
    void refreshPermissionStatus();
  }, [refreshPermissionStatus]);

  const missingPermissions = requiredPermissions.filter(
    (permission) => !isPermissionGranted(permissions, permission.key)
  );

  useEffect(() => {
    if (missingPermissions.length === 0) {
      return undefined;
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshPermissionStatus();
      }
    };

    const interval = window.setInterval(() => {
      void refreshPermissionStatus();
    }, 3000);

    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [missingPermissions.length, refreshPermissionStatus]);

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Tutor status">
        <div>
          <p className="eyebrow">Kairo Tutor</p>
          <h1>Enable Kairo permissions</h1>
        </div>
        <div className="status-pill">Provider: {env.aiProvider}</div>
      </section>

      {missingPermissions.length > 0 ? (
        <section className="permission-onboarding" aria-label="Required permissions">
          <div>
            <p className="eyebrow">Setup</p>
            <h2>Enable Kairo permissions</h2>
          </div>
          <div className="permission-list">
            {requiredPermissions.map((permission) => (
              <div className="permission-item" key={permission.key}>
                <div>
                  <strong>{permission.label}</strong>
                  <span>{permission.detail}</span>
                </div>
                <span
                  className={
                    isPermissionGranted(permissions, permission.key)
                      ? 'permission-state granted'
                      : 'permission-state'
                  }
                >
                  {permissionStateLabel(permissions[permission.key])}
                </span>
              </div>
            ))}
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => void requestRequiredPermissions()}
            disabled={isRequestingPermissions}
          >
            {isRequestingPermissions ? 'Checking...' : 'Enable permissions'}
          </button>
          <p className="permission-hint">
            Already granted them in System Settings? macOS only applies Screen Recording
            and Accessibility after a restart — relaunch Kairo to detect them.
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void nativeBridge.restartApp()}
          >
            Restart Kairo
          </button>
        </section>
      ) : (
        <section className="permission-onboarding" aria-label="Setup complete">
          <div>
            <p className="eyebrow">Setup complete</p>
            <h2>Kairo is ready</h2>
          </div>
          <p className="permission-hint">
            All permissions are granted. Press ⌥⌃ to talk or tap to type — the tutor lives in
            the notch.
          </p>
        </section>
      )}
    </main>
  );
}
