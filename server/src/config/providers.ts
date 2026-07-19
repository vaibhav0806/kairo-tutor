import { env } from './env';

type Provider = {
  baseUrl: string;
  key?: string;
  authHeader: (key: string) => Record<string, string>;
  timeoutMs: number;
};

// Server mirror of the desktop's constants.rs provider config. Base URLs + auth-header shape +
// per-provider timeouts. Keys come from server/.env and are injected here, never sent to the client.
export const providers: Record<string, Provider> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    key: env.OPENROUTER_API_KEY,
    authHeader: (k) => ({
      authorization: `Bearer ${k}`,
      'x-openrouter-title': 'Kairo Tutor',
      'http-referer': 'https://kairo.tutor',
    }),
    timeoutMs: 45_000,
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    key: env.ANTHROPIC_API_KEY,
    authHeader: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    timeoutMs: 15_000,
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    key: env.OPENAI_API_KEY,
    authHeader: (k) => ({ authorization: `Bearer ${k}` }),
    timeoutMs: 15_000,
  },
  sarvam: {
    baseUrl: 'https://api.sarvam.ai',
    key: env.SARVAM_API_KEY,
    authHeader: (k) => ({ 'api-subscription-key': k }),
    timeoutMs: 45_000,
  },
  elevenlabs: {
    baseUrl: 'https://api.elevenlabs.io',
    key: env.ELEVENLABS_API_KEY,
    authHeader: (k) => ({ 'xi-api-key': k }),
    timeoutMs: 45_000,
  },
};
