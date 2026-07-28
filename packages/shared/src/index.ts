// Shared contracts between the desktop app and the Fastify server.
// Source-only package (no build step); consumers (Vite, tsx, tsup, tsc) read this TS directly.

/** Header the desktop sets so the backend meters one whole ask exactly once. */
export const ASK_ID_HEADER = 'x-kairo-ask-id';

export type Plan = 'free' | 'pro';

export type SubStatus =
  | 'none'
  | 'pending'
  | 'active'
  | 'on_hold'
  | 'cancelled'
  | 'failed'
  | 'expired';

/** Only these states represent a real Dodo subscription with a customer portal to open. */
export function hasManageableSubscription(status: SubStatus): boolean {
  return status === 'active' || status === 'on_hold' || status === 'cancelled';
}

/** Response of `GET /v1/me`. `usage.remaining` is null for unlimited (pro). */
export interface MeResponse {
  user: { id: string; email: string };
  plan: Plan;
  status: SubStatus;
  usage: { used: number; limit: number; remaining: number | null };
  renews_at: string | null;
  cancel_at_period_end: boolean;
  paywalled: boolean;
  /** True once the user finishes the onboarding flow. */
  onboarded: boolean;
  display_name: string | null;
  /** The user's name from their Google profile (Better Auth `user.name`). Optional. */
  account_name?: string | null;
}

/** Body of `POST /v1/onboarding`. */
export interface OnboardingBody {
  displayName: string;
  source: string;
  /** Chosen accent color, hex `#rrggbb`. Optional; validated server-side. */
  accent?: string;
}

/** Common "where did you find us" options (the app also allows a free-text "Other"). */
export const ONBOARDING_SOURCES = [
  'Twitter / X',
  'YouTube',
  'A friend',
  'Search',
  'Reddit',
  'Other',
] as const;

/** TTS engines a user can pick between. The server decides which are actually enabled. */
export type TtsProvider = 'sarvam' | 'elevenlabs';

export const TTS_PROVIDERS: readonly TtsProvider[] = ['sarvam', 'elevenlabs'] as const;

export function isTtsProvider(value: unknown): value is TtsProvider {
  return typeof value === 'string' && (TTS_PROVIDERS as readonly string[]).includes(value);
}

/**
 * One selectable voice, normalized across providers. Sarvam publishes no voice-list API and no
 * per-voice metadata, so its entries come from a curated server-side table; ElevenLabs entries are
 * fetched live from `GET /v2/voices`. The desktop cannot tell the two apart.
 */
export interface Voice {
  id: string;
  provider: TtsProvider;
  name: string;
  gender: 'male' | 'female' | 'unknown';
  /** BCP-47 codes the voice is good for, e.g. `['hi-IN', 'en-IN']`. Empty = unspecified. */
  languages: string[];
  description?: string;
  /** Sample audio to play in Settings. ElevenLabs ships one; Sarvam previews are synthesized. */
  previewUrl?: string | null;
}

/** Response of `GET /v1/voices?provider=…`. */
export interface VoicesResponse {
  provider: TtsProvider;
  voices: Voice[];
}

/** Response of `GET /v1/preferences`. `availableProviders` is server policy, not user choice. */
export interface PreferencesResponse {
  ttsProvider: TtsProvider;
  ttsVoiceId: string;
  availableProviders: TtsProvider[];
}

/** Body of `PATCH /v1/preferences`. Both fields optional; server validates the pair. */
export interface PreferencesPatch {
  ttsProvider?: TtsProvider;
  ttsVoiceId?: string;
}

/** Typed error the desktop branches on (401 / 402 / 5xx bodies share this envelope). */
export type ErrorCode =
  | 'quota_exceeded'
  | 'unauthenticated'
  | 'offline'
  | 'provider_error'
  | 'bad_request';

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  message?: string;
}
