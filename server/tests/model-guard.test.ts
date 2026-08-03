import { describe, expect, it } from 'vitest';
import {
  clampAuthedChat,
  guardOnboardingChat,
  guardOnboardingVision,
  MODEL_GUARD_LIMITS,
} from '../src/proxy/model-guard';
import { BadRequestError } from '../src/plugins/error-handler';

const GATE_MODEL = 'openai/gpt-5.6-luna';
const VISION_MODEL = 'claude-opus-4-8';

describe('unauthenticated onboarding payloads', () => {
  it('refuses a model we do not ship', () => {
    // The whole point: these routes have no user, no meter and no credit gate, so an arbitrary
    // model here is an arbitrary bill.
    expect(() => guardOnboardingChat({ model: 'some/expensive-model', messages: [] })).toThrow(
      BadRequestError,
    );
    expect(() => guardOnboardingVision({ model: 'some/expensive-model' })).toThrow(BadRequestError);
  });

  it('refuses a body that is not an object at all', () => {
    expect(() => guardOnboardingChat('not a body')).toThrow(BadRequestError);
    expect(() => guardOnboardingChat(null)).toThrow(BadRequestError);
    expect(() => guardOnboardingChat([{ model: GATE_MODEL }])).toThrow(BadRequestError);
  });

  it('clamps an outsized token request instead of forwarding it', () => {
    const guarded = guardOnboardingChat({ model: GATE_MODEL, max_tokens: 100_000 });
    expect(guarded.max_tokens).toBe(MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS);

    const vision = guardOnboardingVision({ model: VISION_MODEL, max_output_tokens: 999_999 });
    expect(vision.max_output_tokens).toBe(MODEL_GUARD_LIMITS.MAX_VISION_TOKENS);
  });

  it('pins a nonsense token value to the ceiling rather than passing it through', () => {
    expect(guardOnboardingChat({ model: GATE_MODEL, max_tokens: -1 }).max_tokens).toBe(
      MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS,
    );
    expect(guardOnboardingChat({ model: GATE_MODEL, max_tokens: 'lots' }).max_tokens).toBe(
      MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS,
    );
  });

  it('leaves a reasonable request untouched', () => {
    const guarded = guardOnboardingChat({ model: GATE_MODEL, max_tokens: 90, temperature: 0.7 });
    expect(guarded.max_tokens).toBe(90);
    expect(guarded.temperature).toBe(0.7);
  });

  it('does not invent a token ceiling the caller never asked for', () => {
    // Forcing a field the provider would have defaulted changes behaviour for legitimate callers.
    expect('max_tokens' in guardOnboardingChat({ model: GATE_MODEL })).toBe(false);
  });

  it('rejects images on the text gate and caps them on the vision route', () => {
    const oneImage = {
      model: GATE_MODEL,
      messages: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:…' }] }],
    };
    expect(() => guardOnboardingChat(oneImage)).toThrow(BadRequestError);

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
    expect(() => guardOnboardingVision(manyImages)).toThrow(BadRequestError);
  });

  it('accepts the single screenshot the product actually sends', () => {
    const body = {
      model: VISION_MODEL,
      max_tokens: 3000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image' }] },
      ],
    };
    expect(() => guardOnboardingVision(body)).not.toThrow();
  });
});

describe('authed chat clamp', () => {
  it('clamps tokens but keeps forwarding an unrecognised model', () => {
    // An installed build sends the constant it was compiled with. Refusing it would strand users
    // on a version they cannot update past, so the model is reported, not rejected.
    const { body, knownModel } = clampAuthedChat({
      model: 'openrouter/some-future-model',
      max_tokens: 500_000,
    });
    expect(knownModel).toBe(false);
    expect(body.model).toBe('openrouter/some-future-model');
    expect(body.max_tokens).toBe(MODEL_GUARD_LIMITS.MAX_CHAT_TOKENS);
  });

  it('recognises a shipped model', () => {
    expect(clampAuthedChat({ model: GATE_MODEL }).knownModel).toBe(true);
  });
});
