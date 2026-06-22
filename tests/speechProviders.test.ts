import { describe, expect, test } from 'vitest';
import { createElevenLabsSpeechClient } from '../src/server/providers/elevenLabs';
import { createSarvamSpeechClient } from '../src/server/providers/sarvam';

describe('Sarvam speech provider', () => {
  test('transcribes audio through the speech-to-text endpoint', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ transcript: 'select the cube' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const client = createSarvamSpeechClient({
      apiKey: 'sarvam-key',
      baseUrl: 'https://api.sarvam.ai',
      sttModel: 'saaras:v3',
      sttMode: 'transcribe',
      ttsModel: 'bulbul:v3',
      ttsLanguageCode: 'en-IN',
      ttsSpeaker: 'shubh',
      fetchImpl
    });

    await expect(
      client.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav',
        filename: 'question.wav'
      })
    ).resolves.toEqual({ text: 'select the cube' });

    expect(capturedUrl).toBe('https://api.sarvam.ai/speech-to-text');
    expect(capturedInit?.headers).toMatchObject({ 'api-subscription-key': 'sarvam-key' });
    expect(capturedInit?.body).toBeInstanceOf(FormData);
  });

  test('synthesizes speech through the text-to-speech endpoint', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ audios: ['UklGRg=='] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const client = createSarvamSpeechClient({
      apiKey: 'sarvam-key',
      baseUrl: 'https://api.sarvam.ai',
      sttModel: 'saaras:v3',
      sttMode: 'transcribe',
      ttsModel: 'bulbul:v3',
      ttsLanguageCode: 'en-IN',
      ttsSpeaker: 'shubh',
      fetchImpl
    });

    await expect(client.synthesize({ text: 'Click the cube.' })).resolves.toEqual({
      audioBase64: 'UklGRg==',
      mimeType: 'audio/wav'
    });
    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({
      text: 'Click the cube.',
      target_language_code: 'en-IN',
      speaker: 'shubh',
      model: 'bulbul:v3'
    });
  });
});

describe('ElevenLabs speech provider', () => {
  test('transcribes audio through the ElevenLabs speech-to-text endpoint', async () => {
    let capturedUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ text: 'what should I click' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const client = createElevenLabsSpeechClient({
      apiKey: 'eleven-key',
      baseUrl: 'https://api.elevenlabs.io',
      sttModel: 'scribe_v1',
      ttsModel: 'eleven_multilingual_v2',
      voiceId: 'voice-1',
      fetchImpl
    });

    await expect(
      client.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/mpeg',
        filename: 'question.mp3'
      })
    ).resolves.toEqual({ text: 'what should I click' });
    expect(capturedUrl).toBe('https://api.elevenlabs.io/v1/speech-to-text');
  });

  test('synthesizes speech through the configured ElevenLabs voice', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    };
    const client = createElevenLabsSpeechClient({
      apiKey: 'eleven-key',
      baseUrl: 'https://api.elevenlabs.io',
      sttModel: 'scribe_v1',
      ttsModel: 'eleven_multilingual_v2',
      voiceId: 'voice-1',
      fetchImpl
    });

    const result = await client.synthesize({ text: 'Click the cube.' });

    expect(capturedUrl).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1');
    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({
      text: 'Click the cube.',
      model_id: 'eleven_multilingual_v2'
    });
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.audioBase64).toBe('UklGRg==');
  });
});
