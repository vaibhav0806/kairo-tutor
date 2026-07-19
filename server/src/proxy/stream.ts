import { request } from 'undici';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply } from 'fastify';
import { agent } from '../lib/http';
import { providers } from '../config/providers';

/**
 * Stream an upstream chunked body straight to the client (never awaits the whole body, so first
 * bytes flush fast). If the client disconnects mid-stream (barge-in), we abort the upstream request
 * so we stop paying the provider.
 */
export async function streamPassthrough(
  providerId: string,
  path: string,
  body: unknown,
  reply: FastifyReply,
): Promise<void> {
  const p = providers[providerId];
  if (!p?.key) {
    reply.status(502).send({ error: 'provider_error', code: 'provider_error' });
    return;
  }

  const ac = new AbortController();
  const upstream = await request(`${p.baseUrl}${path}`, {
    method: 'POST',
    dispatcher: agent,
    signal: ac.signal,
    bodyTimeout: p.timeoutMs,
    headers: { 'content-type': 'application/json', ...p.authHeader(p.key) },
    body: JSON.stringify(body),
  });

  if (upstream.statusCode >= 400) {
    const text = await upstream.body.text();
    reply.status(502).send({ error: 'provider_error', code: 'provider_error', message: text.slice(0, 200) });
    return;
  }

  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'application/octet-stream' });
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) ac.abort();
  });

  try {
    await pipeline(upstream.body, reply.raw);
  } catch {
    ac.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
