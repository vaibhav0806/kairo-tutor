import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TTS_PROVIDERS, type VoicesResponse } from '@kairo/shared';
import { providers } from '../config/providers';
import { enabledTtsProviders } from '../config/env';
import { requireAuth } from '../plugins/auth-verify';
import { requireCredits } from '../plugins/require-credits';
import { rateLimit } from '../lib/ratelimit';
import { streamPassthrough } from './stream';
import {
  SARVAM_STT_LANGUAGE_CODE,
  SARVAM_STT_MODE,
  SARVAM_STT_MODEL,
} from '../speech/config';
import { listVoices } from '../speech/catalog';
import { readPreferences, writePreferences } from '../speech/preferences';
import { streamTarget, synthesizeBuffered, TTS_TEXT_LIMIT } from '../speech/synthesis';

const SpeakBody = z.object({ text: z.string().min(1).max(TTS_TEXT_LIMIT) });
const VoicesQuery = z.object({ provider: z.enum(TTS_PROVIDERS as unknown as [string, ...string[]]).optional() });
const PreferencesBody = z.object({
  ttsProvider: z.enum(TTS_PROVIDERS as unknown as [string, ...string[]]).optional(),
  ttsVoiceId: z.string().min(1).max(200).optional(),
});
const PreviewBody = z.object({
  provider: z.enum(TTS_PROVIDERS as unknown as [string, ...string[]]),
  voiceId: z.string().min(1).max(200),
});

/** One fixed line for every voice preview, so voices are compared like-for-like. */
const PREVIEW_LINE = "Hey, I'm Kairo. I'll show you exactly where to click — you stay in control.";

/** Preview audio is small, immutable per voice, and clicked repeatedly while auditioning. */
const previewCache = new Map<string, { audio_base64: string; mime_type: string }>();
const PREVIEW_CACHE_LIMIT = 64;

export async function speechRoutes(app: FastifyInstance) {
  // STT — forward the WAV multipart to the configured engine (Sarvam today; the desktop never
  // names a provider). Defaults are filled in here so an old client that omits them still gets
  // language auto-detect rather than Sarvam's own default.
  app.post('/v1/stt', { preHandler: [requireAuth, requireCredits] }, async (req, reply) => {
    const p = providers.sarvam;
    if (!p.key) return reply.status(502).send({ error: 'provider_error', code: 'provider_error' });

    const mp = await req.file();
    if (!mp) return reply.status(400).send({ error: 'no_file', code: 'bad_request' });
    const buf = await mp.toBuffer();

    const form = new FormData();
    form.append('file', new Blob([buf]), mp.filename || 'audio.wav');
    const fields = mp.fields as Record<string, { value?: string } | undefined> | undefined;
    const defaults: Record<string, string> = {
      model: SARVAM_STT_MODEL,
      mode: SARVAM_STT_MODE,
      language_code: SARVAM_STT_LANGUAGE_CODE,
    };
    for (const key of ['model', 'mode', 'language_code'] as const) {
      form.append(key, fields?.[key]?.value || defaults[key]);
    }

    const res = await fetch(`${p.baseUrl}/speech-to-text`, {
      method: 'POST',
      headers: { ...p.authHeader(p.key) },
      body: form,
    });
    reply.status(res.status);
    return res.status === 204 ? null : await res.json().catch(() => ({}));
  });

  // TTS buffered — the fallback path when streaming is unavailable. Normalized to one shape
  // regardless of engine, so the desktop holds no vendor knowledge.
  app.post('/v1/tts', { preHandler: [requireAuth, requireCredits] }, async (req, reply) => {
    const parsed = SpeakBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad_text', code: 'bad_request' });
    const prefs = await readPreferences(req.userId!);
    return await synthesizeBuffered(parsed.data.text, {
      provider: prefs.ttsProvider,
      voiceId: prefs.ttsVoiceId,
    });
  });

  // TTS streaming (raw 24kHz PCM) — pipe straight through, low latency. Both engines stream;
  // picking ElevenLabs must not silently downgrade to the buffered path.
  app.post('/v1/tts/stream', { preHandler: [requireAuth, requireCredits] }, async (req, reply) => {
    const parsed = SpeakBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad_text', code: 'bad_request' });
    const prefs = await readPreferences(req.userId!);
    const target = streamTarget(parsed.data.text, {
      provider: prefs.ttsProvider,
      voiceId: prefs.ttsVoiceId,
    });
    await streamPassthrough(target.providerId, target.path, target.body, reply);
  });

  // The voice picker's data source. Sarvam returns a curated table, ElevenLabs a live (cached)
  // fetch — same normalized shape either way.
  app.get('/v1/voices', { preHandler: requireAuth }, async (req, reply): Promise<VoicesResponse | void> => {
    const parsed = VoicesQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'bad_provider', code: 'bad_request' });
    const prefs = await readPreferences(req.userId!);
    const provider = (parsed.data.provider as VoicesResponse['provider']) ?? prefs.ttsProvider;
    if (!enabledTtsProviders.includes(provider)) {
      return reply.status(400).send({ error: 'provider_disabled', code: 'bad_request' });
    }
    return { provider, voices: await listVoices(provider) };
  });

  app.get('/v1/preferences', { preHandler: requireAuth }, async (req) => {
    return await readPreferences(req.userId!);
  });

  app.patch('/v1/preferences', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PreferencesBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad_preferences', code: 'bad_request' });

    const current = await readPreferences(req.userId!);
    const provider = (parsed.data.ttsProvider as VoicesResponse['provider']) ?? current.ttsProvider;
    if (!enabledTtsProviders.includes(provider)) {
      return reply.status(400).send({ error: 'provider_disabled', code: 'bad_request' });
    }

    // Switching engines without naming a voice lands on that engine's default rather than
    // carrying the previous engine's voice id across.
    const voices = await listVoices(provider);
    const requestedVoice = parsed.data.ttsVoiceId;
    let voiceId: string;
    if (requestedVoice) {
      if (!voices.some((voice) => voice.id === requestedVoice)) {
        return reply.status(400).send({ error: 'unknown_voice', code: 'bad_request' });
      }
      voiceId = requestedVoice;
    } else if (provider === current.ttsProvider) {
      voiceId = current.ttsVoiceId;
    } else {
      voiceId = voices[0]?.id ?? current.ttsVoiceId;
    }

    await writePreferences(req.userId!, { ttsProvider: provider, ttsVoiceId: voiceId });
    return await readPreferences(req.userId!);
  });

  // Audition a voice before committing to it. Costs a real synthesis call, so it is rate-limited
  // per user and cached — but never metered against the free-request quota (a user picking a voice
  // has not asked Kairo anything).
  app.post('/v1/voices/preview', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PreviewBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad_request', code: 'bad_request' });
    if (!rateLimit(`preview:${req.userId}`, 30, 60_000)) {
      return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    }

    const provider = parsed.data.provider as VoicesResponse['provider'];
    if (!enabledTtsProviders.includes(provider)) {
      return reply.status(400).send({ error: 'provider_disabled', code: 'bad_request' });
    }
    const voices = await listVoices(provider);
    if (!voices.some((voice) => voice.id === parsed.data.voiceId)) {
      return reply.status(400).send({ error: 'unknown_voice', code: 'bad_request' });
    }

    const cacheKey = `${provider}:${parsed.data.voiceId}`;
    const hit = previewCache.get(cacheKey);
    if (hit) return { ...hit, provider };

    const audio = await synthesizeBuffered(PREVIEW_LINE, { provider, voiceId: parsed.data.voiceId });
    if (previewCache.size >= PREVIEW_CACHE_LIMIT) {
      const oldest = previewCache.keys().next().value;
      if (oldest) previewCache.delete(oldest);
    }
    previewCache.set(cacheKey, { audio_base64: audio.audio_base64, mime_type: audio.mime_type });
    return audio;
  });
}
