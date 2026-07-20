import type { FastifyInstance } from 'fastify';
import type { OnboardingBody } from '@kairo/shared';
import { requireAuth } from '../plugins/auth-verify';
import { providers } from '../config/providers';
import { forwardJson } from '../proxy/forward';
import { rateLimit } from '../lib/ratelimit';
import { saveProfile } from './service';

export async function onboardingRoutes(app: FastifyInstance) {
  // Save onboarding answers (authed) — runs after Google sign-in.
  app.post<{ Body: OnboardingBody }>('/v1/onboarding', { preHandler: requireAuth }, async (req, reply) => {
    const displayName = (req.body?.displayName ?? '').trim().slice(0, 80);
    const source = (req.body?.source ?? '').trim().slice(0, 120);
    if (!displayName) return reply.status(400).send({ error: 'name_required', code: 'bad_request' });
    await saveProfile(req.userId!, displayName, source);
    return { ok: true };
  });

  // Unauthenticated onboarding voice — the flow talks to the user BEFORE they sign in.
  // IP-rate-limited to bound abuse. TTS speaks a scripted line:
  app.post<{ Body: { text?: string } }>('/v1/onboarding/tts', async (req, reply) => {
    if (!rateLimit(`tts:${req.ip}`, 40, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    if (!providers.sarvam.key) return reply.status(503).send({ error: 'tts_unavailable', code: 'provider_error' });
    const text = (req.body?.text ?? '').slice(0, 600);
    const { json } = await forwardJson('sarvam', '/text-to-speech', {
      text,
      target_language_code: 'en-IN',
      speaker: 'shubh',
      model: 'bulbul:v3',
      pace: 0.9, // match the cached lines' measured pace
      speech_sample_rate: 44100,
      encoding: 'WAV',
    });
    return json;
  });

  // Extract a clean field value from a spoken answer with a fast, no-reasoning model.
  // e.g. "hey, my name is Kairo" -> "Kairo". Same cheap Gemini as the gate; reasoning disabled.
  app.post<{ Body: { transcript?: string; field?: 'name' | 'source' } }>('/v1/onboarding/extract', async (req, reply) => {
    if (!rateLimit(`ex:${req.ip}`, 40, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    if (!providers.openrouter.key) return reply.status(503).send({ error: 'unavailable', code: 'provider_error' });
    const transcript = (req.body?.transcript ?? '').slice(0, 300).trim();
    if (!transcript) return { value: '' };
    const instruction =
      req.body?.field === 'name'
        ? "Extract ONLY the speaker's own first name from the text. Reply with just the name in normal capitalization — first letter uppercase, the rest lowercase (e.g. \"Prasad\", never \"PRASAD\"). Nothing else. If there is no name, reply with an empty string."
        : 'Extract the concise answer from the text (a few words max). Reply with just the answer.';
    const { json } = await forwardJson('openrouter', '/chat/completions', {
      model: 'google/gemini-2.5-flash-lite', // measured fastest for this tiny task
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: transcript },
      ],
      max_tokens: 10, // a first name is tiny
      temperature: 0,
      reasoning: { enabled: false }, // no thinking — instant
      provider: { sort: 'throughput' }, // route to the fastest endpoint
    });
    const value = String((json as any)?.choices?.[0]?.message?.content ?? '')
      .trim()
      .replace(/^["'.\s]+|["'.\s]+$/g, '');
    return { value };
  });

  // STT for a spoken onboarding answer (name / source).
  app.post('/v1/onboarding/stt', async (req, reply) => {
    if (!rateLimit(`stt:${req.ip}`, 40, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    const p = providers.sarvam;
    if (!p.key) return reply.status(503).send({ error: 'stt_unavailable', code: 'provider_error' });
    const mp = await req.file();
    if (!mp) return reply.status(400).send({ error: 'no_file', code: 'bad_request' });
    const buf = await mp.toBuffer();
    const form = new FormData();
    form.append('file', new Blob([buf]), mp.filename || 'audio.wav');
    const res = await fetch(`${p.baseUrl}/speech-to-text`, { method: 'POST', headers: { ...p.authHeader(p.key) }, body: form });
    reply.status(res.status);
    return res.status === 204 ? null : await res.json().catch(() => ({}));
  });
}
