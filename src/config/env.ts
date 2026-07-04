import { z } from 'zod';

const providerSchema = z.enum(['mock', 'openrouter']);
const speechProviderSchema = z.enum(['mock', 'sarvam', 'elevenlabs']);

const rawEnvSchema = z.object({
  KAIRO_APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  KAIRO_AI_PROVIDER: providerSchema.default('openrouter'),
  KAIRO_STT_PROVIDER: speechProviderSchema.default('sarvam'),
  KAIRO_TTS_PROVIDER: speechProviderSchema.default('sarvam'),
  KAIRO_DEFAULT_SKILL: z.string().min(1).default('blender'),
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
  ELEVENLABS_VOICE_ID: z.string().default('EXAVITQu4vr4xnSDxMaL')
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
    elevenLabsVoiceId: parsed.ELEVENLABS_VOICE_ID
  };
}

export function loadKairoPublicEnv(source: Record<string, string | undefined>): KairoEnv {
  return loadKairoEnv(source, { requireProviderKeys: false });
}

export function loadBrowserEnv(): KairoEnv {
  return loadKairoPublicEnv(import.meta.env as Record<string, string | undefined>);
}
