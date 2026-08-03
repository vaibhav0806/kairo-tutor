import { request } from 'undici';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply } from 'fastify';
import { agent } from '../lib/http';
import { providers } from '../config/providers';

/**
 * What happened to a streamed response, so a metered caller can decide whether to refund.
 *
 * The distinction matters because once bytes are on the wire the reply is hijacked and we can no
 * longer send an error envelope — the only way to report a mid-stream failure is out of band.
 */
export type StreamOutcome = {
  /** True once any byte reached the client; after this no JSON error can be sent. */
  started: boolean;
  /** True only when the upstream body was piped through to its end. */
  completed: boolean;
  /** Bytes forwarded. A completed-but-empty stream is a provider failure, not an answer. */
  bytes: number;
};

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
): Promise<StreamOutcome> {
  const p = providers[providerId];
  if (!p?.key) {
    reply.status(502).send({ error: 'provider_error', code: 'provider_error' });
    return { started: false, completed: false, bytes: 0 };
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
    // Drain rather than forward: the upstream body can echo request content, and clients get the
    // same safe envelope every other provider failure returns.
    await upstream.body.text().catch(() => '');
    reply.status(502).send({ error: 'provider_error', code: 'provider_error' });
    return { started: false, completed: false, bytes: 0 };
  }

  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'application/octet-stream' });
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) ac.abort();
  });

  let bytes = 0;
  upstream.body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });

  try {
    await pipeline(upstream.body, reply.raw);
    return { started: true, completed: true, bytes };
  } catch {
    ac.abort();
    if (!reply.raw.writableEnded) reply.raw.end();
    return { started: true, completed: false, bytes };
  }
}
