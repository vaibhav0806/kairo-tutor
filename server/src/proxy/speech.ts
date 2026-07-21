import type { FastifyInstance } from 'fastify';
import { providers } from '../config/providers';
import { requireAuth } from '../plugins/auth-verify';
import { forwardJson } from './forward';
import { streamPassthrough } from './stream';

export async function speechRoutes(app: FastifyInstance) {
  // STT — forward the WAV multipart to Sarvam (global fetch handles the multipart boundary).
  app.post('/v1/stt', { preHandler: requireAuth }, async (req, reply) => {
    const p = providers.sarvam;
    if (!p.key) return reply.status(502).send({ error: 'provider_error', code: 'provider_error' });

    const mp = await req.file();
    if (!mp) return reply.status(400).send({ error: 'no_file', code: 'bad_request' });
    const buf = await mp.toBuffer();

    const form = new FormData();
    form.append('file', new Blob([buf]), mp.filename || 'audio.wav');
    // Forward the STT params the desktop sends (model / mode / language_code) so Sarvam
    // uses the same config as the direct path — without these it defaults and can
    // mis-detect the language (returning an empty/garbled transcript).
    const fields = mp.fields as Record<string, { value?: string } | undefined> | undefined;
    for (const key of ['model', 'mode', 'language_code'] as const) {
      const value = fields?.[key]?.value;
      if (value) form.append(key, value);
    }

    const res = await fetch(`${p.baseUrl}/speech-to-text`, {
      method: 'POST',
      headers: { ...p.authHeader(p.key) },
      body: form,
    });
    reply.status(res.status);
    return res.status === 204 ? null : await res.json().catch(() => ({}));
  });

  // TTS buffered (returns base64 audio JSON).
  app.post('/v1/tts', { preHandler: requireAuth }, async (req) => {
    const { json } = await forwardJson('sarvam', '/text-to-speech', req.body);
    return json;
  });

  // TTS streaming (linear16 PCM) — pipe straight through, low latency.
  app.post('/v1/tts/stream', { preHandler: requireAuth }, async (req, reply) => {
    await streamPassthrough('sarvam', '/text-to-speech/stream', req.body, reply);
  });
}
