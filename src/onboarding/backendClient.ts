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

/** Extract a clean field value ("my name is Kairo" -> "Kairo") via the fast no-reasoning model. */
export async function extractField(transcript: string, field: 'name' | 'source'): Promise<string> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, field }),
    });
    if (!res.ok) return '';
    const json = (await res.json()) as { value?: string };
    return typeof json.value === 'string' ? json.value : '';
  } catch {
    return '';
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
