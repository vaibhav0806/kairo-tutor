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

/** Transcribe a spoken onboarding answer. Returns the text, or null. */
export async function onboardingStt(audio: Blob): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('file', audio, 'audio.webm');
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding/stt`, { method: 'POST', body: form });
    if (!res.ok) return null;
    const json = (await res.json()) as { transcript?: string; text?: string };
    return json?.transcript ?? json?.text ?? null;
  } catch {
    return null;
  }
}

export async function saveOnboarding(jwt: string, displayName: string, source: string): Promise<boolean> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ displayName, source }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchMe(jwt: string): Promise<MeResponse | null> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/me`, { headers: { authorization: `Bearer ${jwt}` } });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}
