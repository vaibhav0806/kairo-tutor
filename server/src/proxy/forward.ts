import { request } from 'undici';
import { agent } from '../lib/http';
import { providers } from '../config/providers';
import { ProviderError } from '../plugins/error-handler';

/** Forward a JSON POST to `${provider}${path}` injecting the real key. Returns the parsed JSON. */
export async function forwardJson(
  providerId: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const p = providers[providerId];
  if (!p?.key) throw new ProviderError(`no key configured for ${providerId}`);

  const res = await request(`${p.baseUrl}${path}`, {
    method: 'POST',
    dispatcher: agent,
    headersTimeout: p.timeoutMs,
    bodyTimeout: p.timeoutMs,
    headers: { 'content-type': 'application/json', ...p.authHeader(p.key), ...extraHeaders },
    body: JSON.stringify(body),
  });

  const text = await res.body.text();
  if (res.statusCode >= 400) throw new ProviderError(`${providerId} ${res.statusCode}: ${text.slice(0, 200)}`);
  return { status: res.statusCode, json: text ? JSON.parse(text) : null };
}
