import { request } from 'undici';
import type { TtsProvider, Voice } from '@kairo/shared';
import { agent } from '../lib/http';
import { providers } from '../config/providers';
import { ProviderError } from '../plugins/error-handler';
import { SARVAM_TTS_MODEL } from './config';

/**
 * The voice catalog, normalized across engines.
 *
 * The two providers are deliberately asymmetric and there is no way around it:
 *   - ElevenLabs exposes `GET /v2/voices` (search, labels, verified languages, preview audio), so
 *     its catalog is fetched live and stays current without a deploy.
 *   - Sarvam publishes NO voice-list endpoint and no per-voice metadata — the speaker list exists
 *     only in their prose docs. So its catalog is a curated table here. Keeping it server-side
 *     (rather than in the desktop's constants.rs) means revising it is a redeploy, not a new DMG
 *     for every installed user.
 */

/** Languages bulbul supports. Sarvam documents these per MODEL, not per speaker. */
const SARVAM_LANGUAGES = [
  'en-IN',
  'hi-IN',
  'bn-IN',
  'gu-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
];

/**
 * Curated bulbul:v3 shortlist. Sarvam ships 39 speakers and documents tone for essentially none of
 * them, so a raw dropdown of 39 first names is worse than a short list a human can actually audition.
 * Basis for these picks: `shubh` is Sarvam's own default and the one voice they describe
 * ("conversational / friendly") — it is also the voice Kairo already speaks with; the rest are the
 * speakers most consistently reported as clean across Hindi and Indian English. Every entry is a
 * judgement call to be re-checked by ear via the Settings preview button — revise freely.
 * `roopa` is the Hindi-leaning swap candidate if `neha` disappoints on Hinglish.
 */
const SARVAM_VOICES: Voice[] = [
  {
    id: 'shubh',
    provider: 'sarvam',
    name: 'Shubh',
    gender: 'male',
    languages: SARVAM_LANGUAGES,
    description: 'Warm and conversational. Kairo’s default teaching voice.',
  },
  {
    id: 'aditya',
    provider: 'sarvam',
    name: 'Aditya',
    gender: 'male',
    languages: SARVAM_LANGUAGES,
    description: 'Even, unhurried delivery — good for long step-by-step walkthroughs.',
  },
  {
    id: 'rahul',
    provider: 'sarvam',
    name: 'Rahul',
    gender: 'male',
    languages: SARVAM_LANGUAGES,
    description: 'Brighter and more energetic; keeps short instructions lively.',
  },
  {
    id: 'dev',
    provider: 'sarvam',
    name: 'Dev',
    gender: 'male',
    languages: SARVAM_LANGUAGES,
    description: 'Lower, steadier tone. Reads well over background app audio.',
  },
  {
    id: 'ritu',
    provider: 'sarvam',
    name: 'Ritu',
    gender: 'female',
    languages: SARVAM_LANGUAGES,
    description: 'Clear Indian English — the most neutral female option.',
  },
  {
    id: 'priya',
    provider: 'sarvam',
    name: 'Priya',
    gender: 'female',
    languages: SARVAM_LANGUAGES,
    description: 'Friendly and expressive; strong on South Indian languages.',
  },
  {
    id: 'kavya',
    provider: 'sarvam',
    name: 'Kavya',
    gender: 'female',
    languages: SARVAM_LANGUAGES,
    description: 'Calm and precise. Suits dense, technical instructions.',
  },
  {
    id: 'neha',
    provider: 'sarvam',
    name: 'Neha',
    gender: 'female',
    languages: SARVAM_LANGUAGES,
    description: 'Softer, encouraging tone for beginner-facing guidance.',
  },
];

export const SARVAM_DEFAULT_VOICE_ID = 'shubh';
export const ELEVENLABS_DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

/** Which model the curated Sarvam list is written against (guards a silent model bump). */
export const SARVAM_CATALOG_MODEL = SARVAM_TTS_MODEL;

type CacheEntry = { at: number; voices: Voice[] };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let elevenLabsCache: CacheEntry | null = null;

function labelOf(labels: Record<string, string> | undefined, key: string): string | undefined {
  const value = labels?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function genderOf(labels: Record<string, string> | undefined): Voice['gender'] {
  const raw = labelOf(labels, 'gender')?.toLowerCase();
  if (raw === 'male' || raw === 'female') return raw;
  return 'unknown';
}

type ElevenLabsVoice = {
  voice_id?: string;
  name?: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
  verified_languages?: Array<{ language?: string; locale?: string }>;
};

function normalizeElevenLabsVoice(raw: ElevenLabsVoice): Voice | null {
  if (!raw.voice_id || !raw.name) return null;
  const accent = labelOf(raw.labels, 'accent');
  const useCase = labelOf(raw.labels, 'use_case') ?? labelOf(raw.labels, 'use case');
  // ElevenLabs descriptions are free text and sometimes absent; fall back to the labels, which
  // are the part a user actually chooses on ("indian", "narration").
  const description =
    raw.description?.trim() || [accent, useCase].filter(Boolean).join(' · ') || undefined;
  const languages = (raw.verified_languages ?? [])
    .map((entry) => entry.locale || entry.language)
    .filter((value): value is string => !!value);

  return {
    id: raw.voice_id,
    provider: 'elevenlabs',
    name: raw.name,
    gender: genderOf(raw.labels),
    languages: [...new Set(languages)],
    description,
    previewUrl: raw.preview_url ?? null,
  };
}

async function fetchElevenLabsVoices(): Promise<Voice[]> {
  const p = providers.elevenlabs;
  if (!p.key) throw new ProviderError('no key configured for elevenlabs');

  let res;
  try {
    res = await request(`${p.baseUrl}/v2/voices?page_size=100`, {
      method: 'GET',
      dispatcher: agent,
      headersTimeout: p.timeoutMs,
      bodyTimeout: p.timeoutMs,
      headers: { ...p.authHeader(p.key) },
    });
  } catch (e) {
    throw new ProviderError(
      `elevenlabs voice list failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new ProviderError(`elevenlabs voice list ${res.statusCode}: ${text.slice(0, 300)}`);
  }

  let parsed: { voices?: ElevenLabsVoice[] };
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(`elevenlabs voice list returned non-JSON: ${text.slice(0, 200)}`);
  }

  return (parsed.voices ?? [])
    .map(normalizeElevenLabsVoice)
    .filter((voice): voice is Voice => voice !== null);
}

/**
 * Voices for one provider. The ElevenLabs list is cached (6h) so opening Settings does not hit
 * their API on every render; a stale cache is served if a refresh fails, because a slightly old
 * voice list beats an empty dropdown.
 */
export async function listVoices(provider: TtsProvider): Promise<Voice[]> {
  if (provider === 'sarvam') return SARVAM_VOICES;

  const now = Date.now();
  if (elevenLabsCache && now - elevenLabsCache.at < CACHE_TTL_MS) return elevenLabsCache.voices;

  try {
    const voices = await fetchElevenLabsVoices();
    elevenLabsCache = { at: now, voices };
    return voices;
  } catch (error) {
    if (elevenLabsCache) return elevenLabsCache.voices;
    throw error;
  }
}

/** True when `voiceId` is selectable for `provider`. Guards what a client may PATCH. */
export async function isKnownVoice(provider: TtsProvider, voiceId: string): Promise<boolean> {
  const voices = await listVoices(provider);
  return voices.some((voice) => voice.id === voiceId);
}

export function defaultVoiceFor(provider: TtsProvider): string {
  return provider === 'sarvam' ? SARVAM_DEFAULT_VOICE_ID : ELEVENLABS_DEFAULT_VOICE_ID;
}
