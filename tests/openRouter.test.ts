import { describe, expect, test } from 'vitest';
import { createOpenRouterClient } from '../src/server/providers/openRouter';

describe('createOpenRouterClient', () => {
  test('sends chat completions through OpenRouter with app headers', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Click the cube.' } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const client = createOpenRouterClient({
      apiKey: 'test-key',
      model: 'anthropic/claude-sonnet-4',
      baseUrl: 'https://openrouter.ai/api/v1',
      siteUrl: 'http://localhost:5173',
      appTitle: 'Kairo Tutor',
      fetchImpl
    });

    const result = await client.chat([
      { role: 'system', content: 'You are a screen-native tutor.' },
      { role: 'user', content: 'Help me animate the cube.' }
    ]);

    expect(result).toBe('Click the cube.');
    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'HTTP-Referer': 'http://localhost:5173',
      'X-OpenRouter-Title': 'Kairo Tutor'
    });
    expect(JSON.parse(capturedInit?.body as string)).toMatchObject({
      model: 'anthropic/claude-sonnet-4'
    });
  });
});
