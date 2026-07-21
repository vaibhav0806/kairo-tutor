import type { FastifyInstance } from 'fastify';
import type { OnboardingBody } from '@kairo/shared';
import { requireAuth } from '../plugins/auth-verify';
import { providers } from '../config/providers';
import { forwardJson } from '../proxy/forward';
import { streamPassthrough } from '../proxy/stream';
import { rateLimit } from '../lib/ratelimit';
import { saveProfile } from './service';

/** Drop the `_provider` routing hint before forwarding to the vision provider. */
function dropProviderHint(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const clone = { ...(body as Record<string, unknown>) };
    delete clone._provider;
    return clone;
  }
  return body;
}

export async function onboardingRoutes(app: FastifyInstance) {
  // Save onboarding answers (authed) — runs after Google sign-in.
  app.post<{ Body: OnboardingBody }>('/v1/onboarding', { preHandler: requireAuth }, async (req, reply) => {
    const displayName = (req.body?.displayName ?? '').trim().slice(0, 80);
    const source = (req.body?.source ?? '').trim().slice(0, 120);
    // Accent is optional; only persist a well-formed #rrggbb hex, else null.
    const rawAccent = (req.body?.accent ?? '').trim();
    const accent = /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent.toLowerCase() : null;
    if (!displayName) return reply.status(400).send({ error: 'name_required', code: 'bad_request' });
    await saveProfile(req.userId!, displayName, source, accent);
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
      pace: 1.0, // natural, to match the cached lines
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

  // Onboarding "talk to me" practice: the user says anything and Kairo replies for real.
  // Fully dynamic (never scripted) — same fast, no-reasoning Gemini as the gate, but with a
  // plain assistant persona instead of the needsScreen gate prompt. The desktop app speaks
  // the reply via Sarvam. Unauthenticated (runs mid-onboarding) + IP-rate-limited.
  app.post<{ Body: { transcript?: string; name?: string } }>('/v1/onboarding/chat', async (req, reply) => {
    if (!rateLimit(`chat:${req.ip}`, 40, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    if (!providers.openrouter.key) return reply.status(503).send({ error: 'unavailable', code: 'provider_error' });
    const transcript = (req.body?.transcript ?? '').slice(0, 400).trim();
    if (!transcript) return { reply: '' };
    const name = (req.body?.name ?? '').slice(0, 40).trim();
    const persona =
      `You are Kairo, a warm, upbeat screen-native AI assistant. This is the user's first-ever chat with you during onboarding${name ? `, and their name is ${name}` : ''}. ` +
      'Reply naturally and conversationally to what they said, in ONE or at most TWO short spoken sentences. ' +
      'Sound friendly and human, never robotic. Do not use emojis, markdown, or lists — this will be read aloud. Keep it brief.';
    const { json } = await forwardJson('openrouter', '/chat/completions', {
      model: 'google/gemini-2.5-flash-lite', // same fast model as the gate
      messages: [
        { role: 'system', content: persona },
        { role: 'user', content: transcript },
      ],
      max_tokens: 90, // one or two short sentences
      temperature: 0.7, // a little warmth, still fast
      reasoning: { enabled: false }, // no thinking — instant
      provider: { sort: 'throughput' }, // route to the fastest endpoint
    });
    const text = String((json as any)?.choices?.[0]?.message?.content ?? '').trim();
    return { reply: text };
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
    const fields = mp.fields as Record<string, { value?: string } | undefined> | undefined;
    for (const key of ['model', 'mode', 'language_code'] as const) {
      const value = fields?.[key]?.value;
      if (value) form.append(key, value);
    }
    const res = await fetch(`${p.baseUrl}/speech-to-text`, { method: 'POST', headers: { ...p.authHeader(p.key) }, body: form });
    reply.status(res.status);
    return res.status === 204 ? null : await res.json().catch(() => ({}));
  });

  // Onboarding "point" GATE — the unauthenticated, unmetered sibling of /v1/llm/chat. The demo
  // point turn runs PRE-sign-in, so it can't use the authed gate route. IP-rate-limited.
  app.post('/v1/onboarding/gate', async (req, reply) => {
    if (!rateLimit(`obgate:${req.ip}`, 40, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    const { json } = await forwardJson('openrouter', '/chat/completions', req.body);
    return json;
  });

  // Onboarding VISION (answer + box) — the unauthenticated, unmetered sibling of /v1/vision/tutor.
  // Vision is the expensive call, so this gets a TIGHT per-IP budget (the demo makes ~1-2 calls;
  // headroom left for retries). Provider routing mirrors the metered route.
  app.post('/v1/onboarding/vision', async (req, reply) => {
    if (!rateLimit(`obvis:${req.ip}`, 12, 10 * 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    const provider = (req.body as { _provider?: string })?._provider === 'anthropic' ? 'anthropic' : 'openai';
    const path = provider === 'anthropic' ? '/v1/messages' : '/v1/responses';
    const { json } = await forwardJson(provider, path, dropProviderHint(req.body));
    return json;
  });

  // Onboarding streaming TTS — the unauthenticated sibling of /v1/tts/stream (demo voice replies).
  app.post('/v1/onboarding/tts/stream', async (req, reply) => {
    if (!rateLimit(`obtts:${req.ip}`, 60, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    await streamPassthrough('sarvam', '/text-to-speech/stream', req.body, reply);
  });
}
