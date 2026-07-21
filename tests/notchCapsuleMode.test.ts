import { describe, expect, test } from 'vitest';
import { resolveCapsuleMode } from '../src/notch/capsuleMode';

const base = {
  state: 'idle' as const,
  layout: 'compact' as const,
  isSpeaking: false,
  isSubmitting: false,
  voiceCaptureState: 'idle' as const,
  detailHidden: false
};

describe('resolveCapsuleMode', () => {
  test('listening', () => {
    expect(resolveCapsuleMode({ ...base, state: 'listening' })).toBe('listening');
  });

  test('error when not speaking', () => {
    expect(resolveCapsuleMode({ ...base, voiceCaptureState: 'error' })).toBe('error');
  });

  test('thinking from thinking / transcribing / isSubmitting / detailHidden (not speaking)', () => {
    expect(resolveCapsuleMode({ ...base, state: 'thinking' })).toBe('thinking');
    expect(resolveCapsuleMode({ ...base, voiceCaptureState: 'transcribing' })).toBe('thinking');
    expect(resolveCapsuleMode({ ...base, isSubmitting: true })).toBe('thinking');
    expect(resolveCapsuleMode({ ...base, detailHidden: true })).toBe('thinking');
  });

  test('typing from a prompt layout (not speaking)', () => {
    expect(resolveCapsuleMode({ ...base, layout: 'prompt' })).toBe('typing');
  });

  test('speaking suppresses everything except listening → idle', () => {
    expect(resolveCapsuleMode({ ...base, state: 'thinking', isSpeaking: true })).toBe('idle');
    expect(resolveCapsuleMode({ ...base, layout: 'prompt', isSpeaking: true })).toBe('idle');
    expect(resolveCapsuleMode({ ...base, voiceCaptureState: 'error', isSpeaking: true })).toBe('idle');
  });

  test('coach wins regardless of other fields', () => {
    expect(
      resolveCapsuleMode({ ...base, state: 'coach', isSpeaking: true, layout: 'prompt' })
    ).toBe('coach');
  });
});
