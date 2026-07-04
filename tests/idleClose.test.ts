import { describe, expect, it } from 'vitest';
import { shouldIdleClose } from '../src/notch/idleClose';

const base = {
  answerSettled: true,
  isSubmitting: false,
  voiceCaptureState: 'idle',
  queryLen: 0,
  pointerHolding: false,
  recording: false,
  idleElapsedMs: 5000,
  idleThresholdMs: 3000
};

describe('shouldIdleClose', () => {
  it('closes when settled, idle, and past the threshold', () => {
    expect(shouldIdleClose(base)).toBe(true);
  });

  it('never closes while a native PTT recording is in progress', () => {
    expect(shouldIdleClose({ ...base, recording: true })).toBe(false);
  });

  it('does not close before the answer settles', () => {
    expect(shouldIdleClose({ ...base, answerSettled: false })).toBe(false);
  });

  it('does not close while submitting, typing, or hovering', () => {
    expect(shouldIdleClose({ ...base, isSubmitting: true })).toBe(false);
    expect(shouldIdleClose({ ...base, queryLen: 3 })).toBe(false);
    expect(shouldIdleClose({ ...base, pointerHolding: true })).toBe(false);
    expect(shouldIdleClose({ ...base, voiceCaptureState: 'transcribing' })).toBe(false);
  });

  it('does not close before the idle threshold elapses', () => {
    expect(shouldIdleClose({ ...base, idleElapsedMs: 1000 })).toBe(false);
  });
});
