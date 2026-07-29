import { afterEach, describe, expect, test, vi } from 'vitest';
import { classifyTutorFailure, createTutorRuntimeErrorResponse } from '../src/core/tutorErrors';

/** The classifier reads navigator.onLine first; tests that care about the rest must pin it. */
function withOnline(online: boolean, run: () => void) {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(original ?? {}), onLine: online },
    configurable: true
  });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe('classifyTutorFailure', () => {
  test('a dropped connection wins over everything else', () => {
    withOnline(false, () => {
      expect(classifyTutorFailure(new Error('500 internal error'))).toBe('offline');
    });
  });

  test('recognises an expired session', () => {
    withOnline(true, () => {
      expect(classifyTutorFailure(new Error('request failed: 401 Unauthorized'))).toBe('signed_out');
    });
  });

  test('recognises an exhausted quota', () => {
    withOnline(true, () => {
      expect(classifyTutorFailure(new Error('429 quota exceeded'))).toBe('quota');
    });
  });

  test('recognises a backend that cannot be reached', () => {
    withOnline(true, () => {
      expect(classifyTutorFailure(new TypeError('Failed to fetch'))).toBe('unreachable');
      expect(classifyTutorFailure(new Error('502 Bad Gateway'))).toBe('unreachable');
    });
  });

  test('falls back to unknown rather than guessing', () => {
    withOnline(true, () => {
      expect(classifyTutorFailure(new Error('something odd happened'))).toBe('unknown');
    });
  });
});

describe('createTutorRuntimeErrorResponse', () => {
  test('speaks a line the user can act on, and keeps the raw cause for the logs', () => {
    withOnline(true, () => {
      const response = createTutorRuntimeErrorResponse({
        skillSlug: 'blender',
        error: new Error('request failed: 401 Unauthorized')
      });

      expect(response).toMatchObject({
        mode: 'stuck_help',
        skillSlug: 'blender',
        expectedNextState: 'tutor_failure_signed_out',
        providerMetadata: {
          confidenceState: 'low',
          warnings: ['request failed: 401 Unauthorized']
        }
      });
      expect(response.voiceText).toContain('signed out');
      // The old copy told users to "check provider configuration", which is not a thing they have.
      expect(response.screenText).not.toMatch(/provider|env/i);
    });
  });

  test('offline gets its own copy, not a generic failure', () => {
    withOnline(false, () => {
      const response = createTutorRuntimeErrorResponse({ skillSlug: 'blender', error: new Error('x') });
      expect(response.voiceText).toContain('offline');
      expect(response.expectedNextState).toBe('tutor_failure_offline');
    });
  });
});
