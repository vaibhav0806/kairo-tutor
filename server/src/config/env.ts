import 'dotenv/config';
import { z } from 'zod';
import { isTtsProvider, type TtsProvider } from '@kairo/shared';
import { assertStaticEnvironment } from './targets';

const Env = z.object({
  KAIRO_SERVER_TARGET: z.enum(['local', 'hosted']).default('local'),
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SARVAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  // Speech provider policy. The desktop never picks a vendor — it asks for /v1/stt and
  // /v1/tts/stream and the server resolves the provider, so flipping either of these is an
  // env change + restart, with no new DMG for anyone who already installed.
  KAIRO_STT_PROVIDER: z.enum(['sarvam']).default('sarvam'),
  /** Fallback TTS engine for users who have expressed no preference. */
  KAIRO_TTS_PROVIDER: z.enum(['sarvam', 'elevenlabs']).default('sarvam'),
  /** Comma-separated allowlist of engines a user may switch to in Settings. */
  KAIRO_TTS_PROVIDERS_ENABLED: z.string().default('sarvam,elevenlabs'),
  // Where the release DMG sits on the box. It is served through an email-gated route rather than
  // from a public URL, so the closed alpha actually stays closed.
  KAIRO_RELEASES_DIR: z.string().default('/srv/kairo-releases'),
  KAIRO_RELEASE_DMG_NAME: z.string().default('Kairo-Tutor-latest.dmg'),
  DODO_ENV: z.enum(['test_mode', 'live_mode']).default('test_mode'),
  // Dodo keys — SAME names as the root .env (one source of truth, no confusion). The active
  // key + webhook secret are selected by DODO_ENV (see dodoApiKey / dodoWebhookSecret below).
  DODO_KAIRO_TEST_KEY: z.string().optional(),
  DODO_KAIRO_LIVE_KEY: z.string().optional(),
  DODO_TEST_WEBHOOK_SECRET: z.string().optional(),
  DODO_LIVE_WEBHOOK_SECRET: z.string().optional(),
  // The single Pro product — its id differs between the test + live Dodo dashboards, so
  // both are held and DODO_ENV picks (keeps the test<->live flip a one-var switch).
  DODO_KAIRO_TEST_PRODUCT_ID: z.string().optional(),
  DODO_KAIRO_LIVE_PRODUCT_ID: z.string().optional(),
});

export const env = Env.parse(process.env);
assertStaticEnvironment(env);
export type AppEnv = typeof env;

// The Dodo key + webhook secret + product id in effect, chosen by DODO_ENV (test vs live).
export const dodoApiKey =
  env.DODO_ENV === 'live_mode' ? env.DODO_KAIRO_LIVE_KEY : env.DODO_KAIRO_TEST_KEY;
export const dodoWebhookSecret =
  env.DODO_ENV === 'live_mode' ? env.DODO_LIVE_WEBHOOK_SECRET : env.DODO_TEST_WEBHOOK_SECRET;
export const dodoProductId =
  env.DODO_ENV === 'live_mode' ? env.DODO_KAIRO_LIVE_PRODUCT_ID : env.DODO_KAIRO_TEST_PRODUCT_ID;

/**
 * TTS engines a user may actually choose: the configured allowlist, minus any whose key is
 * missing. A provider with no key would 502 on first use, so it never reaches the Settings UI.
 */
export const enabledTtsProviders: TtsProvider[] = (() => {
  const keyed: Record<TtsProvider, string | undefined> = {
    sarvam: env.SARVAM_API_KEY,
    elevenlabs: env.ELEVENLABS_API_KEY,
  };
  const allowed = env.KAIRO_TTS_PROVIDERS_ENABLED.split(',')
    .map((entry) => entry.trim())
    .filter(isTtsProvider);
  const usable = allowed.filter((provider) => !!keyed[provider]);
  // Never return an empty list: the default engine stays selectable so /v1/tts keeps a target
  // even in a half-configured environment (it will surface a provider_error, not a crash).
  return usable.length > 0 ? usable : [env.KAIRO_TTS_PROVIDER];
})();

/** The default engine, forced into the enabled set so a stored preference always has a fallback. */
export const defaultTtsProvider: TtsProvider = enabledTtsProviders.includes(env.KAIRO_TTS_PROVIDER)
  ? env.KAIRO_TTS_PROVIDER
  : enabledTtsProviders[0];
