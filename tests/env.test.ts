import { describe, expect, test } from 'vitest';
import { loadKairoEnv } from '../src/config/env';

describe('loadKairoEnv', () => {
  test('reads the provider selection', () => {
    const env = loadKairoEnv({
      KAIRO_AI_PROVIDER: 'openrouter',
      KAIRO_STT_PROVIDER: 'sarvam',
      KAIRO_TTS_PROVIDER: 'elevenlabs'
    });

    expect(env.aiProvider).toBe('openrouter');
    expect(env.sttProvider).toBe('sarvam');
    expect(env.ttsProvider).toBe('elevenlabs');
  });

  test('defaults provider selection + follow/wait tuning', () => {
    const env = loadKairoEnv({});

    expect(env.aiProvider).toBe('openrouter');
    expect(env.sttProvider).toBe('sarvam');
    expect(env.ttsProvider).toBe('sarvam');
    expect(env.followClickPadPt).toBe(24);
    expect(env.followNudgeCooldownMs).toBe(3_500);
    expect(env.waitPageLoadMs).toBe(3_000);
  });

  test('coerces numeric tuning overrides from strings', () => {
    const env = loadKairoEnv({ FOLLOW_CLICK_PAD_PT: '40', WAIT_INSTANT_MS: '250' });

    expect(env.followClickPadPt).toBe(40);
    expect(env.waitInstantMs).toBe(250);
  });
});
