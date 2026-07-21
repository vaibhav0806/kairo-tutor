import type { MeResponse } from '@kairo/shared';
import { klog } from '../core/logger';
import { getBackendJwt } from './authClient';
import { getMe } from './backendClient';
import { createNativeBridge } from '../native/nativeBridge';

/** The name to show/use: the onboarding display name, else the Google account name, else ''. */
export function pickUserName(
  me: Pick<MeResponse, 'display_name' | 'account_name'> | null
): string {
  if (!me) return '';
  return (me.display_name || me.account_name || '').trim();
}

/**
 * Pull the signed-in user's name from `/v1/me` and cache it natively so the notch reads it at
 * launch. No-op when signed out. Returns the resolved name (may be '').
 */
export async function syncUserName(): Promise<string> {
  const jwt = await getBackendJwt();
  if (!jwt) return '';
  const me = await getMe(jwt);
  const name = pickUserName(me);
  await createNativeBridge().setUserName(name);
  klog('onboarding', 'info', 'synced user name from /v1/me', { name_len: name.length });
  return name;
}
