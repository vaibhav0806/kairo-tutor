import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { klog } from '../core/logger';
import { hasNativeBridge } from './config';

export type AuthStatus = { signed_in: boolean };

/** Opens the system browser at the backend's Google start route. */
export async function startGoogleAuth(): Promise<void> {
  if (!hasNativeBridge) {
    klog('auth', 'warn', 'startGoogleAuth: no native bridge (browser)');
    return;
  }
  await invoke('start_google_auth');
}

export async function getAuthStatus(): Promise<AuthStatus> {
  if (!hasNativeBridge) return { signed_in: false };
  try {
    return await invoke<AuthStatus>('get_auth_status');
  } catch {
    return { signed_in: false };
  }
}

/** Short-lived JWT for authed backend calls (/v1/me, /v1/onboarding). Null if signed out. */
export async function getBackendJwt(): Promise<string | null> {
  if (!hasNativeBridge) return null;
  try {
    return await invoke<string | null>('get_backend_jwt');
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  if (!hasNativeBridge) return;
  try {
    await invoke('sign_out');
  } catch {
    /* ignore */
  }
}

/** Subscribe to `auth:changed` (Rust emits it after the deep-link exchange). Returns unlisten. */
export async function onAuthChanged(cb: (signedIn: boolean) => void): Promise<() => void> {
  if (!hasNativeBridge) return () => {};
  return listen<boolean>('auth:changed', (e) => cb(!!e.payload));
}
