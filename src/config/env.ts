import { z } from 'zod';

// Frontend-only, non-secret config. This holds ONLY what the WebViews actually read:
// provider *selection* (which planner/STT/TTS is active) plus the follow-along and
// wait-bucket tuning knobs the notch uses. The native side (src-tauri/src/constants.rs)
// is the single source of truth for provider MODELS, base URLs, and API keys — the
// desktop bundle never needs them. Keep the follow/wait defaults below in sync with
// constants.rs; keep the three provider selections in sync with constants.rs too.

const providerSchema = z.enum(['mock', 'openrouter']);
const speechProviderSchema = z.enum(['mock', 'sarvam', 'elevenlabs']);

const rawEnvSchema = z.object({
  KAIRO_AI_PROVIDER: providerSchema.default('openrouter'),
  KAIRO_STT_PROVIDER: speechProviderSchema.default('sarvam'),
  KAIRO_TTS_PROVIDER: speechProviderSchema.default('sarvam'),
  FOLLOW_SAMESCREEN_BITS: z.coerce.number().default(28), // >this of 256 = different screen (pointer fade-on-scroll)
  FOLLOW_CLICK_PAD_PT: z.coerce.number().default(24), // click tolerance in display points
  FOLLOW_POINTER_IDLE_FADE_MS: z.coerce.number().default(30_000),
  FOLLOW_ARMED_POLL_MS: z.coerce.number().default(800), // armed-watch re-check interval while a pointer waits
  // Wrong-button nudge cooldown: min gap between spoken "use the other button" hints
  // on one pending pointer, so a fumbling user isn't nagged on every click.
  FOLLOW_NUDGE_COOLDOWN_MS: z.coerce.number().default(3_500),
  // `wait` bucket → fixed post-click settle delay (ms) before Kairo screenshots the
  // result for the next Fable turn. A plain per-bucket sleep, generous by design.
  WAIT_INSTANT_MS: z.coerce.number().default(400),
  WAIT_UI_SETTLE_MS: z.coerce.number().default(900),
  WAIT_PAGE_LOAD_MS: z.coerce.number().default(3_000)
});

export type KairoEnv = {
  aiProvider: 'mock' | 'openrouter';
  sttProvider: 'mock' | 'sarvam' | 'elevenlabs';
  ttsProvider: 'mock' | 'sarvam' | 'elevenlabs';
  followSamescreenBits: number;
  followClickPadPt: number;
  followPointerIdleFadeMs: number;
  followArmedPollMs: number;
  followNudgeCooldownMs: number;
  waitInstantMs: number;
  waitUiSettleMs: number;
  waitPageLoadMs: number;
};

export function loadKairoEnv(source: Record<string, string | undefined>): KairoEnv {
  const parsed = rawEnvSchema.parse(source);

  return {
    aiProvider: parsed.KAIRO_AI_PROVIDER,
    sttProvider: parsed.KAIRO_STT_PROVIDER,
    ttsProvider: parsed.KAIRO_TTS_PROVIDER,
    followSamescreenBits: parsed.FOLLOW_SAMESCREEN_BITS,
    followClickPadPt: parsed.FOLLOW_CLICK_PAD_PT,
    followPointerIdleFadeMs: parsed.FOLLOW_POINTER_IDLE_FADE_MS,
    followArmedPollMs: parsed.FOLLOW_ARMED_POLL_MS,
    followNudgeCooldownMs: parsed.FOLLOW_NUDGE_COOLDOWN_MS,
    waitInstantMs: parsed.WAIT_INSTANT_MS,
    waitUiSettleMs: parsed.WAIT_UI_SETTLE_MS,
    waitPageLoadMs: parsed.WAIT_PAGE_LOAD_MS
  };
}

export function loadBrowserEnv(): KairoEnv {
  return loadKairoEnv(import.meta.env as Record<string, string | undefined>);
}
