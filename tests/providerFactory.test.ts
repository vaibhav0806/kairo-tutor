import { describe, expect, test } from 'vitest';
import { loadKairoEnv } from '../src/config/env';
import { createProviderAdapters } from '../src/server/providers';

describe('createProviderAdapters', () => {
  test('uses the mock planner and mock speech adapters by default', async () => {
    const env = loadKairoEnv({
      KAIRO_AI_PROVIDER: 'mock',
      KAIRO_STT_PROVIDER: 'mock',
      KAIRO_TTS_PROVIDER: 'mock'
    });
    const adapters = createProviderAdapters({ env });

    expect(adapters.kind).toEqual({
      planner: 'mock',
      stt: 'mock',
      tts: 'mock'
    });
    await expect(adapters.stt.transcribe()).resolves.toEqual({ text: '' });
    await expect(adapters.tts.synthesize({ text: 'hello' })).resolves.toEqual({
      audioBase64: '',
      mimeType: 'audio/wav'
    });
  });

  test('requires OpenRouter secret material when OpenRouter planning is selected', () => {
    const env = loadKairoEnv(
      {
        KAIRO_AI_PROVIDER: 'openrouter',
        KAIRO_STT_PROVIDER: 'mock',
        KAIRO_TTS_PROVIDER: 'mock',
        OPENROUTER_API_KEY: 'present-for-env-validation'
      },
      { requireProviderKeys: false }
    );

    expect(() => createProviderAdapters({ env })).toThrow(
      'OPENROUTER_API_KEY is required to create the OpenRouter planner adapter'
    );
  });

  test('creates explicitly selected real provider adapters from env and secrets', () => {
    const env = loadKairoEnv(
      {
        KAIRO_AI_PROVIDER: 'openrouter',
        KAIRO_STT_PROVIDER: 'sarvam',
        KAIRO_TTS_PROVIDER: 'elevenlabs',
        OPENROUTER_API_KEY: 'openrouter-key',
        SARVAM_API_KEY: 'sarvam-key',
        ELEVENLABS_API_KEY: 'eleven-key',
        ELEVENLABS_VOICE_ID: 'voice-1'
      },
      { requireProviderKeys: false }
    );

    const adapters = createProviderAdapters({
      env,
      secrets: {
        openRouterApiKey: 'openrouter-key',
        sarvamApiKey: 'sarvam-key',
        elevenLabsApiKey: 'eleven-key'
      }
    });

    expect(adapters.kind).toEqual({
      planner: 'openrouter',
      stt: 'sarvam',
      tts: 'elevenlabs'
    });
  });
});
