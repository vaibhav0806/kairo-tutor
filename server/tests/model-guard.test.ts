import { describe, expect, it } from 'vitest';
import { clampAuthedChat, clampAuthedVision, MODEL_GUARD_LIMITS } from '../src/proxy/model-guard';
import { BadRequestError } from '../src/plugins/error-handler';

const CHAT_MODEL = 'openai/gpt-5.6-luna';
const VISION_MODEL = 'claude-opus-4-8';

describe('cost-per-request is clamped even for authenticated callers', () => {
  it('caps an outsized token request instead of forwarding it', () => {
    // The quota bounds how MANY turns a free user gets. Nothing bounds what ONE turn costs, and a
    // Pro subscriber has no quota at all — so the ceiling has to live here.
    expect(clampAuthedChat({ model: CHAT_MODEL, max_tokens: 100_000 }).body.max_tokens).toBe(
      MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS,
    );
    expect(
      clampAuthedVision({ model: VISION_MODEL, max_output_tokens: 999_999 }).body.max_output_tokens,
    ).toBe(MODEL_GUARD_LIMITS.MAX_VISION_TOKENS);
  });

  it('pins a nonsense token value to the ceiling rather than passing it through', () => {
    expect(clampAuthedChat({ model: CHAT_MODEL, max_tokens: -1 }).body.max_tokens).toBe(
      MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS,
    );
    expect(clampAuthedChat({ model: CHAT_MODEL, max_tokens: 'lots' }).body.max_tokens).toBe(
      MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS,
    );
  });

  it('leaves a reasonable request untouched', () => {
    const { body } = clampAuthedChat({ model: CHAT_MODEL, max_tokens: 90, temperature: 0.7 });
    expect(body.max_tokens).toBe(90);
    expect(body.temperature).toBe(0.7);
  });

  it('does not invent a ceiling the caller never asked for', () => {
    // Forcing a field the provider would have defaulted changes behaviour for legitimate callers.
    expect('max_tokens' in clampAuthedChat({ model: CHAT_MODEL }).body).toBe(false);
  });

  it('refuses a payload carrying more images than a turn can justify', () => {
    const manyImages = {
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: Array.from({ length: MODEL_GUARD_LIMITS.MAX_IMAGES + 1 }, () => ({
            type: 'image',
          })),
        },
      ],
    };
    expect(() => clampAuthedVision(manyImages)).toThrow(BadRequestError);
    expect(() => clampAuthedChat(manyImages)).toThrow(BadRequestError);
  });

  it('accepts the single screenshot the product actually sends', () => {
    const body = {
      model: VISION_MODEL,
      max_tokens: 3000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image' }] },
      ],
    };
    expect(() => clampAuthedVision(body)).not.toThrow();
  });

  it('refuses a body that is not a JSON object', () => {
    expect(() => clampAuthedChat('not a body')).toThrow(BadRequestError);
    expect(() => clampAuthedChat(null)).toThrow(BadRequestError);
    expect(() => clampAuthedVision([{ model: VISION_MODEL }])).toThrow(BadRequestError);
  });

  it('reports an unrecognised model without rejecting it', () => {
    // An installed build sends the constant it was compiled with. Refusing it would strand users
    // on a version they cannot update past, so it is reported and clamped, not blocked.
    const chat = clampAuthedChat({ model: 'openrouter/some-future-model', max_tokens: 500_000 });
    expect(chat.knownModel).toBe(false);
    expect(chat.body.model).toBe('openrouter/some-future-model');
    expect(chat.body.max_tokens).toBe(MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS);

    expect(clampAuthedChat({ model: CHAT_MODEL }).knownModel).toBe(true);
    expect(clampAuthedVision({ model: VISION_MODEL }).knownModel).toBe(true);
  });
});
