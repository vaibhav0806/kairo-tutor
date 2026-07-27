import { invoke } from '@tauri-apps/api/core';
import { klog } from '../core/logger';

export const hasNativeBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const BROWSER_FALLBACK_URL = 'http://localhost:8787';
let backendUrlPromise: Promise<string> | null = null;

/** Resolve the same backend URL native auth, billing, and proxy requests use. */
export function getKairoBackendUrl(): Promise<string> {
  if (!backendUrlPromise) {
    backendUrlPromise = hasNativeBridge
      ? invoke<string>('get_backend_url')
      : Promise.resolve(BROWSER_FALLBACK_URL);
    backendUrlPromise.then(
      (url) => klog('app', 'info', 'backend target resolved', { hosted: url.startsWith('https://') }),
      (error) => klog('app', 'error', 'backend target resolution failed', { error: String(error) }),
    );
  }
  return backendUrlPromise;
}
