import type { MeResponse } from '@kairo/shared';
import { KAIRO_BACKEND_URL } from './config';

/** Speak a scripted onboarding line. Returns base64 WAV audio, or null if unavailable. */
export async function onboardingTts(text: string): Promise<string | null> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { audios?: unknown[] };
    const b64 = json?.audios?.[0];
    return typeof b64 === 'string' ? b64 : null;
  } catch {
    return null;
  }
}

/** "Talk to me" practice: send what the user said, get Kairo's dynamic spoken reply. */
export async function onboardingChat(transcript: string, name: string): Promise<string> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, name }),
    });
    if (!res.ok) return '';
    const json = (await res.json()) as { reply?: string };
    return typeof json.reply === 'string' ? json.reply : '';
  } catch {
    return '';
  }
}

export async function saveOnboarding(
  jwt: string,
  displayName: string,
  source: string,
  accent = '',
): Promise<boolean> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ displayName, source, accent }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch the signed-in user's profile (name/email/usage). Null if signed out / offline. */
export async function getMe(jwt: string): Promise<MeResponse | null> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/me`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}
