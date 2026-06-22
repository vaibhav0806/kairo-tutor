import { describe, expect, test } from 'vitest';
import { loadKairoEnv, loadKairoPublicEnv } from '../src/config/env';

describe('loadKairoEnv', () => {
  test('allows a full local mock configuration without vendor keys', () => {
    const env = loadKairoEnv({
      KAIRO_APP_ENV: 'development',
      KAIRO_AI_PROVIDER: 'mock',
      KAIRO_STT_PROVIDER: 'mock',
      KAIRO_TTS_PROVIDER: 'mock',
      KAIRO_DEFAULT_SKILL: 'blender',
      KAIRO_ENABLE_WEB_RESEARCH: 'false'
    });

    expect(env.aiProvider).toBe('mock');
    expect(env.defaultSkill).toBe('blender');
    expect(env.enableWebResearch).toBe(false);
  });

  test('requires an OpenRouter key only when OpenRouter is selected', () => {
    expect(() =>
      loadKairoEnv({
        KAIRO_AI_PROVIDER: 'openrouter',
        KAIRO_STT_PROVIDER: 'mock',
        KAIRO_TTS_PROVIDER: 'mock'
      })
    ).toThrow('OPENROUTER_API_KEY is required when KAIRO_AI_PROVIDER=openrouter');
  });

  test('loads OpenRouter model routing when configured', () => {
    const env = loadKairoEnv({
      KAIRO_AI_PROVIDER: 'openrouter',
      KAIRO_STT_PROVIDER: 'mock',
      KAIRO_TTS_PROVIDER: 'mock',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-4'
    });

    expect(env.aiProvider).toBe('openrouter');
    expect(env.openRouterModel).toBe('anthropic/claude-sonnet-4');
  });

  test('requires Sarvam key when Sarvam handles speech', () => {
    expect(() =>
      loadKairoEnv({
        KAIRO_AI_PROVIDER: 'mock',
        KAIRO_STT_PROVIDER: 'sarvam',
        KAIRO_TTS_PROVIDER: 'mock'
      })
    ).toThrow('SARVAM_API_KEY is required when Sarvam speech is selected');
  });

  test('requires ElevenLabs key when ElevenLabs handles speech', () => {
    expect(() =>
      loadKairoEnv({
        KAIRO_AI_PROVIDER: 'mock',
        KAIRO_STT_PROVIDER: 'mock',
        KAIRO_TTS_PROVIDER: 'elevenlabs'
      })
    ).toThrow('ELEVENLABS_API_KEY is required when ElevenLabs speech is selected');
  });

  test('loads public app configuration without requiring browser-exposed vendor keys', () => {
    const env = loadKairoPublicEnv({
      KAIRO_AI_PROVIDER: 'openrouter',
      KAIRO_STT_PROVIDER: 'sarvam',
      KAIRO_TTS_PROVIDER: 'elevenlabs'
    });

    expect(env.aiProvider).toBe('openrouter');
    expect(env.sttProvider).toBe('sarvam');
    expect(env.ttsProvider).toBe('elevenlabs');
  });
});
