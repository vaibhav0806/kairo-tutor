import { describe, expect, test, vi } from 'vitest';
import {
  buildNotchAskPayload,
  isNotchPromptVisible,
  submitNotchPrompt
} from '../src/notch/prompt';
import type { NotchPayload } from '../src/notch/types';

const capturedPayload: NotchPayload = {
  state: 'captured',
  title: 'Screen captured',
  detail: 'Ready for a question'
};

describe('notch prompt behavior', () => {
  test('shows the prompt only after a capture is ready', () => {
    expect(isNotchPromptVisible(capturedPayload)).toBe(true);
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
});
