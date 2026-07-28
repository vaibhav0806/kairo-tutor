import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { streamTarget } from '../src/speech/synthesis';
import { defaultVoiceFor, listVoices, isKnownVoice } from '../src/speech/catalog';
import { ELEVENLABS_OUTPUT_FORMAT, ELEVENLABS_TTS_MODEL, SARVAM_TTS_MODEL } from '../src/speech/config';

const app = await buildApp();
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('speech/synthesis targets', () => {
  it('shapes a Sarvam stream request with speaker + linear16 PCM', () => {
    const target = streamTarget('hello', { provider: 'sarvam', voiceId: 'shubh' });
    expect(target.providerId).toBe('sarvam');
    expect(target.path).toBe('/text-to-speech/stream');
    expect(target.body).toMatchObject({
      text: 'hello',
      speaker: 'shubh',
      model: SARVAM_TTS_MODEL,
      output_audio_codec: 'linear16',
      speech_sample_rate: 24_000,
    });
  });

  it('shapes an ElevenLabs stream request with the voice in the path and PCM output', () => {
    const target = streamTarget('hello', { provider: 'elevenlabs', voiceId: 'abc123' });
    expect(target.providerId).toBe('elevenlabs');
    // Streaming (not the buffered endpoint) is what keeps first-audio latency comparable to Sarvam.
    expect(target.path).toBe(`/v1/text-to-speech/abc123/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`);
    expect(target.body).toMatchObject({ text: 'hello', model_id: ELEVENLABS_TTS_MODEL });
  });

  it('escapes a voice id so it cannot break out of the URL path', () => {
    const target = streamTarget('hi', { provider: 'elevenlabs', voiceId: 'a/../b' });
    expect(target.path).toContain('a%2F..%2Fb');
  });
});

describe('speech/catalog', () => {
  it('serves the curated Sarvam shortlist with the current default first', async () => {
    const voices = await listVoices('sarvam');
    expect(voices.length).toBe(8);
    expect(voices[0].id).toBe(defaultVoiceFor('sarvam'));
    expect(voices.filter((v) => v.gender === 'male')).toHaveLength(4);
    expect(voices.filter((v) => v.gender === 'female')).toHaveLength(4);
    expect(voices.every((v) => v.provider === 'sarvam' && v.languages.includes('hi-IN'))).toBe(true);
  });

  it('rejects a voice id that is not in the catalog', async () => {
    expect(await isKnownVoice('sarvam', 'shubh')).toBe(true);
    expect(await isKnownVoice('sarvam', 'not-a-speaker')).toBe(false);
  });
});

describe('speech routes require auth', () => {
  for (const [method, url] of [
    ['GET', '/v1/voices'],
    ['GET', '/v1/preferences'],
    ['PATCH', '/v1/preferences'],
    ['POST', '/v1/voices/preview'],
  ] as const) {
    it(`401s ${method} ${url} without auth`, async () => {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    });
  }
});
