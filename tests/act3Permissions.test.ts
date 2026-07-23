import { describe, expect, test } from 'vitest';
import { nextPermissionStep } from '../src/onboarding/acts/act3SubStep';
import type { NativePermissionStatus } from '../src/native/nativeBridge';

const status = (
  screenRecording: NativePermissionStatus['screenRecording'],
  accessibility: NativePermissionStatus['accessibility']
): NativePermissionStatus => ({ screenRecording, accessibility, microphone: 'granted' });

describe('act3 permission sub-step', () => {
  test('screen recording is primed first', () => {
    expect(nextPermissionStep(status('not_determined', 'not_determined'))).toBe('screen');
    expect(nextPermissionStep(status('denied', 'granted'))).toBe('screen');
  });

  test('accessibility only after screen recording is granted (the pet needs to see the screen)', () => {
    expect(nextPermissionStep(status('granted', 'not_determined'))).toBe('accessibility');
    expect(nextPermissionStep(status('granted', 'denied'))).toBe('accessibility');
  });

  test('both granted → done (advance to Act 4)', () => {
    expect(nextPermissionStep(status('granted', 'granted'))).toBe('done');
  });
});
