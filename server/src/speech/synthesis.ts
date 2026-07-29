import { request } from 'undici';
import type { TtsProvider } from '@kairo/shared';
import { agent } from '../lib/http';
import { providers } from '../config/providers';
import { ProviderError } from '../plugins/error-handler';
import { forwardJson } from '../proxy/forward';
import {
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_TTS_MODEL,
  SARVAM_OUTPUT_CODEC,
  SARVAM_TTS_LANGUAGE_CODE,
  SARVAM_TTS_MODEL,
  TTS_SAMPLE_RATE,
} from './config';

/**
 * Vendor request shaping for text-to-speech.
 *
 * The desktop sends `{ text }` and nothing else — every vendor-specific field (speaker vs voice_id,
 * codec naming, model id, language) is composed here. That is what makes the provider switch real:
 * a user flipping engines in Settings changes which branch of this file runs, and the app is none
 * the wiser.
 */

export interface TtsTarget {
  provider: TtsProvider;
  voiceId: string;
  /** BCP-47 code. Sarvam requires one; ElevenLabs infers language from the text. */
  languageCode?: string;
}

/** Max characters accepted in one synthesis call — bounds both cost and a runaway prompt. */
export const TTS_TEXT_LIMIT = 3_000;

/**
 * The Sarvam request body, in ONE place.
 *
 * It used to be written out three times — here for streaming, again below for buffered, and a
 * third time in the onboarding route — and they had drifted: onboarding asked for 44.1kHz with an
 * explicit `pace`, everything else asked for 24kHz without one. Same speaker, same model, audibly
 * different voice, which is exactly what a user reports as "the gate sounds like someone else".
 *
 * `codec` is the only legitimate difference: `linear16` for the streaming pipe, `wav` for a
 * buffered clip. Nothing else may vary per caller.
 */
export function sarvamTtsBody(text: string, voiceId: string, codec: 'linear16' | 'wav', languageCode?: string) {
  return {
    text,
    target_language_code: languageCode ?? SARVAM_TTS_LANGUAGE_CODE,
    speaker: voiceId,
    model: SARVAM_TTS_MODEL,
    output_audio_codec: codec,
    speech_sample_rate: TTS_SAMPLE_RATE,
  };
}

/**
 * Streaming target. Both engines are asked for raw 24kHz PCM so the desktop's Web Audio scheduler
 * plays either one through the identical path — ElevenLabs is NOT a buffered-only fallback.
 */
export function streamTarget(text: string, target: TtsTarget): { providerId: string; path: string; body: unknown } {
  if (target.provider === 'elevenlabs') {
    return {
      providerId: 'elevenlabs',
      path: `/v1/text-to-speech/${encodeURIComponent(target.voiceId)}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
      body: { text, model_id: ELEVENLABS_TTS_MODEL },
    };
  }
  return {
    providerId: 'sarvam',
    path: '/text-to-speech/stream',
    body: sarvamTtsBody(text, target.voiceId, SARVAM_OUTPUT_CODEC, target.languageCode),
  };
}

export interface BufferedAudio {
  audio_base64: string;
  mime_type: string;
  provider: TtsProvider;
}

/**
 * Buffered synthesis, normalized to one response shape across engines. Sarvam answers with
 * base64-in-JSON; ElevenLabs answers with raw audio bytes. The desktop only ever sees the
 * normalized form, so its fallback path no longer needs provider knowledge.
 */
export async function synthesizeBuffered(text: string, target: TtsTarget): Promise<BufferedAudio> {
  if (target.provider === 'elevenlabs') {
    const p = providers.elevenlabs;
    if (!p.key) throw new ProviderError('no key configured for elevenlabs');

    let res;
    try {
      res = await request(`${p.baseUrl}/v1/text-to-speech/${encodeURIComponent(target.voiceId)}`, {
        method: 'POST',
        dispatcher: agent,
        headersTimeout: p.timeoutMs,
        bodyTimeout: p.timeoutMs,
        headers: { 'content-type': 'application/json', ...p.authHeader(p.key) },
        body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
      });
    } catch (e) {
      throw new ProviderError(
        `elevenlabs tts request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (res.statusCode >= 400) {
      const detail = await res.body.text();
      throw new ProviderError(`elevenlabs tts ${res.statusCode}: ${detail.slice(0, 300)}`);
    }

    const audio = Buffer.from(await res.body.arrayBuffer());
    return {
      audio_base64: audio.toString('base64'),
      mime_type: 'audio/mpeg',
      provider: 'elevenlabs',
    };
  }

  const { json } = await forwardJson(
    'sarvam',
    '/text-to-speech',
    sarvamTtsBody(text, target.voiceId, 'wav', target.languageCode),
  );

  const audios = (json as { audios?: unknown })?.audios;
  const first = Array.isArray(audios) ? audios[0] : undefined;
  if (typeof first !== 'string' || !first) {
    throw new ProviderError('sarvam tts response did not include audio');
  }
  return { audio_base64: first, mime_type: 'audio/wav', provider: 'sarvam' };
}
