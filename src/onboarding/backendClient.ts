import type { MeResponse } from '@kairo/shared';
import { getKairoBackendUrl } from './config';
import { getBackendJwt } from './authClient';

/**
 * Speak an onboarding line that has no baked audio. Returns base64 WAV, or null if unavailable.
 *
 * Uses the ordinary authenticated `/v1/tts`. The unauthenticated `/v1/onboarding/tts` it used to
 * call no longer exists — onboarding now happens after sign-in, so there is nothing left that
 * needs a route without a user behind it.
 */
export async function onboardingTts(text: string): Promise<string | null> {
  try {
    const backendUrl = await getKairoBackendUrl();
    const jwt = await getBackendJwt();
    if (!jwt) return null;
    const res = await fetch(`${backendUrl}/v1/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
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

/**
 * "Talk to me" practice: send what the user said, get Kairo's dynamic spoken reply.
 *
 * Goes through the authenticated chat route with the persona built here, because the
 * unauthenticated `/v1/onboarding/chat` that used to own this prompt is gone.
 */
export async function onboardingChat(transcript: string, name: string): Promise<string> {
  try {
    const backendUrl = await getKairoBackendUrl();
    const jwt = await getBackendJwt();
    if (!jwt) return '';
    const persona =
      `You are Kairo, a warm, upbeat screen-native AI assistant. This is the user's first-ever ` +
      `chat with you during onboarding${name ? `, and their name is ${name}` : ''}. ` +
      'Reply naturally and conversationally to what they said, in ONE or at most TWO short spoken ' +
      'sentences. Sound friendly and human, never robotic. Do not use emojis, markdown, or lists — ' +
      'this will be read aloud. Keep it brief.';
    const res = await fetch(`${backendUrl}/v1/llm/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [
          { role: 'system', content: persona },
          { role: 'user', content: transcript },
        ],
        max_tokens: 90,
        temperature: 0.7,
        reasoning: { enabled: false },
        provider: { sort: 'throughput' },
      }),
    });
    if (!res.ok) return '';
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = json?.choices?.[0]?.message?.content;
    return typeof reply === 'string' ? reply.trim() : '';
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
    const backendUrl = await getKairoBackendUrl();
    const res = await fetch(`${backendUrl}/v1/onboarding`, {
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
    const backendUrl = await getKairoBackendUrl();
    const res = await fetch(`${backendUrl}/v1/me`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}
