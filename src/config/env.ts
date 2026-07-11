import { z } from 'zod';

const providerSchema = z.enum(['mock', 'openrouter']);
const speechProviderSchema = z.enum(['mock', 'sarvam', 'elevenlabs']);

const rawEnvSchema = z.object({
  KAIRO_APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  KAIRO_AI_PROVIDER: providerSchema.default('openrouter'),
  KAIRO_STT_PROVIDER: speechProviderSchema.default('sarvam'),
  KAIRO_TTS_PROVIDER: speechProviderSchema.default('sarvam'),
  KAIRO_DEFAULT_SKILL: z.string().min(1).default('general'),
  KAIRO_ENABLE_WEB_RESEARCH: z.string().default('false'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('qwen/qwen3.6-flash'),
  OPENROUTER_VISION_MODEL: z.string().default('google/gemini-2.5-flash'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: z.string().url().optional(),
  OPENROUTER_APP_TITLE: z.string().default('Kairo Tutor'),
  SARVAM_API_KEY: z.string().optional(),
  SARVAM_BASE_URL: z.string().url().default('https://api.sarvam.ai'),
  SARVAM_STT_MODEL: z.string().default('saaras:v3'),
  SARVAM_STT_MODE: z.string().default('transcribe'),
  SARVAM_TTS_MODEL: z.string().default('bulbul:v3'),
  SARVAM_TTS_LANGUAGE_CODE: z.string().default('en-IN'),
  SARVAM_TTS_SPEAKER: z.string().default('shubh'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  ELEVENLABS_STT_MODEL: z.string().default('scribe_v1'),
  ELEVENLABS_TTS_MODEL: z.string().default('eleven_multilingual_v2'),
  ELEVENLABS_VOICE_ID: z.string().default('EXAVITQu4vr4xnSDxMaL'),
  // Follow-along (mirror of src-tauri/src/constants.rs). Non-secret tuning knobs;
  // no .env entry needed — a fresh clone gets the defaults below.
  FOLLOW_SETTLE_POLL_MS: z.coerce.number().default(300),
  FOLLOW_SETTLE_MAX_ITERATIONS: z.coerce.number().default(10),
  FOLLOW_SETTLE_MOVING_BITS: z.coerce.number().default(6), // >this of 256 = still moving
  FOLLOW_SAMESCREEN_BITS: z.coerce.number().default(28), // >this of 256 = different screen
  FOLLOW_CLICK_PAD_PT: z.coerce.number().default(24), // click tolerance in display points
  FOLLOW_POINTER_IDLE_FADE_MS: z.coerce.number().default(30_000),
  FOLLOW_ARMED_POLL_MS: z.coerce.number().default(800), // armed-watch re-check interval while a pointer waits
  // Dead-zone floor: min time to wait for a click's on-screen reaction to START
  // before giving up and capturing anyway. Lifts a mislabeled-too-fast `wait` bucket
  // so a slow reaction (e.g. a dialog that takes a beat to close) isn't screenshotted
  // while the OLD screen is still up. The reaction, once started, is ridden out by the
  // settle-diff loop; a click that genuinely changes nothing falls through after this.
  FOLLOW_CHANGE_WAIT_MIN_MS: z.coerce.number().default(1_500),
  // Wrong-button nudge cooldown: min gap between spoken "use the other button" hints
  // on one pending pointer, so a fumbling user isn't nagged on every click.
  FOLLOW_NUDGE_COOLDOWN_MS: z.coerce.number().default(3_500),
  WAIT_INSTANT_MS: z.coerce.number().default(75),
  WAIT_UI_SETTLE_MS: z.coerce.number().default(400),
  WAIT_PAGE_LOAD_MS: z.coerce.number().default(2_500),
  WAIT_NETWORK_MS: z.coerce.number().default(2_500)
});

export type KairoEnv = {
  appEnv: 'development' | 'test' | 'production';
  aiProvider: 'mock' | 'openrouter';
  sttProvider: 'mock' | 'sarvam' | 'elevenlabs';
  ttsProvider: 'mock' | 'sarvam' | 'elevenlabs';
  defaultSkill: string;
  enableWebResearch: boolean;
  openRouterModel: string;
  openRouterVisionModel: string;
  openRouterBaseUrl: string;
  openRouterSiteUrl?: string;
  openRouterAppTitle: string;
  sarvamBaseUrl: string;
  sarvamSttModel: string;
  sarvamSttMode: string;
  sarvamTtsModel: string;
  sarvamTtsLanguageCode: string;
  sarvamTtsSpeaker: string;
  elevenLabsBaseUrl: string;
  elevenLabsSttModel: string;
  elevenLabsTtsModel: string;
  elevenLabsVoiceId: string;
  followSettlePollMs: number;
  followSettleMaxIterations: number;
  followSettleMovingBits: number;
  followSamescreenBits: number;
  followClickPadPt: number;
  followPointerIdleFadeMs: number;
  followArmedPollMs: number;
  followChangeWaitMinMs: number;
  followNudgeCooldownMs: number;
  waitInstantMs: number;
  waitUiSettleMs: number;
  waitPageLoadMs: number;
  waitNetworkMs: number;
};

type LoadKairoEnvOptions = {
  requireProviderKeys?: boolean;
};

export function loadKairoEnv(
  source: Record<string, string | undefined>,
  options: LoadKairoEnvOptions = {}
): KairoEnv {
  const requireProviderKeys = options.requireProviderKeys ?? true;
  const parsed = rawEnvSchema.parse(source);

  if (requireProviderKeys && parsed.KAIRO_AI_PROVIDER === 'openrouter' && !parsed.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when KAIRO_AI_PROVIDER=openrouter');
  }

  if (
    requireProviderKeys &&
    (parsed.KAIRO_STT_PROVIDER === 'sarvam' || parsed.KAIRO_TTS_PROVIDER === 'sarvam') &&
    !parsed.SARVAM_API_KEY
  ) {
    throw new Error('SARVAM_API_KEY is required when Sarvam speech is selected');
  }

  if (
    requireProviderKeys &&
    (parsed.KAIRO_STT_PROVIDER === 'elevenlabs' || parsed.KAIRO_TTS_PROVIDER === 'elevenlabs') &&
    !parsed.ELEVENLABS_API_KEY
  ) {
    throw new Error('ELEVENLABS_API_KEY is required when ElevenLabs speech is selected');
  }

  return {
    appEnv: parsed.KAIRO_APP_ENV,
    aiProvider: parsed.KAIRO_AI_PROVIDER,
    sttProvider: parsed.KAIRO_STT_PROVIDER,
    ttsProvider: parsed.KAIRO_TTS_PROVIDER,
    defaultSkill: parsed.KAIRO_DEFAULT_SKILL,
    enableWebResearch: parsed.KAIRO_ENABLE_WEB_RESEARCH === 'true',
    openRouterModel: parsed.OPENROUTER_MODEL,
    openRouterVisionModel: parsed.OPENROUTER_VISION_MODEL,
    openRouterBaseUrl: parsed.OPENROUTER_BASE_URL,
    openRouterSiteUrl: parsed.OPENROUTER_SITE_URL,
    openRouterAppTitle: parsed.OPENROUTER_APP_TITLE,
    sarvamBaseUrl: parsed.SARVAM_BASE_URL,
    sarvamSttModel: parsed.SARVAM_STT_MODEL,
    sarvamSttMode: parsed.SARVAM_STT_MODE,
    sarvamTtsModel: parsed.SARVAM_TTS_MODEL,
    sarvamTtsLanguageCode: parsed.SARVAM_TTS_LANGUAGE_CODE,
    sarvamTtsSpeaker: parsed.SARVAM_TTS_SPEAKER,
    elevenLabsBaseUrl: parsed.ELEVENLABS_BASE_URL,
    elevenLabsSttModel: parsed.ELEVENLABS_STT_MODEL,
    elevenLabsTtsModel: parsed.ELEVENLABS_TTS_MODEL,
    elevenLabsVoiceId: parsed.ELEVENLABS_VOICE_ID,
    followSettlePollMs: parsed.FOLLOW_SETTLE_POLL_MS,
    followSettleMaxIterations: parsed.FOLLOW_SETTLE_MAX_ITERATIONS,
    followSettleMovingBits: parsed.FOLLOW_SETTLE_MOVING_BITS,
    followSamescreenBits: parsed.FOLLOW_SAMESCREEN_BITS,
    followClickPadPt: parsed.FOLLOW_CLICK_PAD_PT,
    followPointerIdleFadeMs: parsed.FOLLOW_POINTER_IDLE_FADE_MS,
    followArmedPollMs: parsed.FOLLOW_ARMED_POLL_MS,
    followChangeWaitMinMs: parsed.FOLLOW_CHANGE_WAIT_MIN_MS,
    followNudgeCooldownMs: parsed.FOLLOW_NUDGE_COOLDOWN_MS,
    waitInstantMs: parsed.WAIT_INSTANT_MS,
    waitUiSettleMs: parsed.WAIT_UI_SETTLE_MS,
    waitPageLoadMs: parsed.WAIT_PAGE_LOAD_MS,
    waitNetworkMs: parsed.WAIT_NETWORK_MS
  };
}

export function loadKairoPublicEnv(source: Record<string, string | undefined>): KairoEnv {
  return loadKairoEnv(source, { requireProviderKeys: false });
}

export function loadBrowserEnv(): KairoEnv {
  return loadKairoPublicEnv(import.meta.env as Record<string, string | undefined>);
}
