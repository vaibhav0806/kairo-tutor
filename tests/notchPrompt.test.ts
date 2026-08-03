import { afterEach, describe, expect, it, test, vi } from 'vitest';
import {
  buildNotchAskPayload,
  getNotchInteractionState,
  isNotchDismissKey,
  isNotchPromptVisible,
  submitNotchPrompt,
  waitForNotchPaint
} from '../src/notch/prompt';
import type { NotchPayload } from '../src/notch/types';

const capturedPayload: NotchPayload = {
  state: 'captured',
  layout: 'prompt',
  title: 'Screen captured',
  detail: 'Ready for a question'
};

describe('notch prompt behavior', () => {
  test('shows the prompt after capture and after an answer', () => {
    expect(isNotchPromptVisible(capturedPayload)).toBe(true);
    expect(isNotchPromptVisible({ ...capturedPayload, state: 'showing_step' })).toBe(true);
    expect(isNotchPromptVisible({ ...capturedPayload, state: 'listening' })).toBe(false);
    expect(isNotchPromptVisible({ ...capturedPayload, state: 'thinking' })).toBe(false);
  });

  test('normalizes prompt submissions before sending them to the app shell', async () => {
    const emitAsk = vi.fn(async () => undefined);

    await submitNotchPrompt('  What should I click next?  ', emitAsk);

    expect(emitAsk).toHaveBeenCalledWith(buildNotchAskPayload('What should I click next?'));
  });

  test('ignores empty prompt submissions', async () => {
    const emitAsk = vi.fn(async () => undefined);

    await submitNotchPrompt('   ', emitAsk);

    expect(emitAsk).not.toHaveBeenCalled();
  });

  test('treats Escape as the notch dismiss key', () => {
    expect(isNotchDismissKey('Escape')).toBe(true);
    expect(isNotchDismissKey('Enter')).toBe(false);
  });

  test('can yield one browser frame before heavier ask work begins', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    vi.stubGlobal('requestAnimationFrame', frame);

    try {
      await waitForNotchPaint();

      expect(frame).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('keeps the prompt usable for follow-up questions after an answer', () => {
    const interaction = getNotchInteractionState({
      payload: { ...capturedPayload, state: 'showing_step', layout: 'answer' },
      voiceState: 'idle',
      isSubmitting: false
    });

    expect(interaction.promptVisible).toBe(true);
    expect(interaction.canUsePrompt).toBe(true);
    expect(interaction.canSubmitText).toBe(true);
    expect(interaction.canAnnotate).toBe(true);
    expect(interaction.promptDisabledReason).toBeNull();
  });

  test('keeps voice stop available while recording even when text input is disabled', () => {
    const interaction = getNotchInteractionState({
      payload: { ...capturedPayload, state: 'listening', layout: 'compact' },
      voiceState: 'recording',
      isSubmitting: false
    });

    expect(interaction.promptVisible).toBe(true);
    expect(interaction.canUsePrompt).toBe(false);
    expect(interaction.canUseVoice).toBe(true);
    expect(interaction.canAnnotate).toBe(false);
    expect(interaction.submitMode).toBe('voice');
  });

  test('blocks duplicate submissions while thinking', () => {
    const interaction = getNotchInteractionState({
      payload: { ...capturedPayload, state: 'thinking', layout: 'compact' },
      voiceState: 'transcribing',
      isSubmitting: true
    });

    expect(interaction.promptVisible).toBe(false);
    expect(interaction.canUsePrompt).toBe(false);
    expect(interaction.canSubmitText).toBe(false);
    expect(interaction.canUseVoice).toBe(false);
    expect(interaction.canAnnotate).toBe(false);
    expect(interaction.promptDisabledReason).toBe('busy');
  });

  test('does not offer annotation tools before a captured screen exists', () => {
    const interaction = getNotchInteractionState({
      payload: { ...capturedPayload, state: 'idle', layout: 'compact' },
      voiceState: 'idle',
      isSubmitting: false
    });

    expect(interaction.promptVisible).toBe(false);
    expect(interaction.canAnnotate).toBe(false);
  });
});

describe('waitForNotchPaint · never deadlocks a turn', () => {
  const originalRaf = globalThis.requestAnimationFrame;
  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });

  it('resolves on the deadline when the frame callback never fires', async () => {
    // WebKit suspends rAF for an occluded window. This used to hang the whole turn: the gate and
    // vision calls were never reached and nothing timed out, because no request had been made.
    globalThis.requestAnimationFrame = (() => 0) as unknown as typeof globalThis.requestAnimationFrame;

    await expect(waitForNotchPaint(20)).resolves.toBeUndefined();
  });

  it('resolves once only, even when the frame fires after the deadline', async () => {
    let frameCallback: (() => void) | null = null;
    globalThis.requestAnimationFrame = ((cb: () => void) => {
      frameCallback = cb;
      return 0;
    }) as unknown as typeof globalThis.requestAnimationFrame;

    await waitForNotchPaint(10);
    // A late frame must not throw or double-resolve.
    expect(() => frameCallback?.()).not.toThrow();
  });

  it('still returns promptly when the frame does fire', async () => {
    globalThis.requestAnimationFrame = ((cb: () => void) => {
      cb();
      return 0;
    }) as unknown as typeof globalThis.requestAnimationFrame;

    const started = Date.now();
    await waitForNotchPaint(5000);
    // Must not wait for the deadline when a real frame arrives.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
