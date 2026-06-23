import { describe, expect, test } from 'vitest';
import {
  activationStateToNotchPayload,
  captureFailureToNotchPayload,
  tutorResponseToNotchPayload,
  reduceActivationState
} from '../src/activation/activationState';

describe('activation state', () => {
  test('moves through shortcut capture and tutor response states', () => {
    expect(reduceActivationState('idle', { type: 'shortcut_pressed' })).toBe('listening');
    expect(reduceActivationState('listening', { type: 'capture_complete' })).toBe('captured');
    expect(reduceActivationState('captured', { type: 'thinking_started' })).toBe('thinking');
    expect(reduceActivationState('thinking', { type: 'response_ready' })).toBe('showing_step');
    expect(reduceActivationState('showing_step', { type: 'dismissed' })).toBe('idle');
  });

  test('maps activation states to notch copy', () => {
    expect(activationStateToNotchPayload('listening')).toMatchObject({
      state: 'listening',
      layout: 'compact',
      title: 'Kairo is listening',
      detail: 'Capturing the current screen'
    });
    expect(activationStateToNotchPayload('captured')).toMatchObject({
      state: 'captured',
      layout: 'prompt'
    });
    expect(activationStateToNotchPayload('thinking')).toMatchObject({
      state: 'thinking',
      layout: 'compact',
      title: 'Kairo is thinking'
    });
  });

  test('builds a prompt-visible capture failure payload', () => {
    expect(captureFailureToNotchPayload('Screen tutoring is paused.')).toEqual({
      state: 'captured',
      layout: 'prompt',
      title: 'Capture unavailable',
      detail: 'Screen tutoring is paused.'
    });
  });

  test('maps tutor responses to visible notch answer copy', () => {
    expect(
      tutorResponseToNotchPayload({
        mode: 'stuck_help',
        skillSlug: 'browser',
        voiceText: 'You are on the OpenRouter page. Ask me what to inspect next.',
        screenText: 'You are on the OpenRouter page.',
        visualTargets: [],
        expectedNextState: 'user_clarifies_goal'
      })
    ).toEqual({
      state: 'showing_step',
      layout: 'answer',
      title: 'Kairo answered',
      detail: 'You are on the OpenRouter page.'
    });
  });

  test('extracts readable answer text from accidental provider JSON strings', () => {
    expect(
      tutorResponseToNotchPayload({
        mode: 'idle',
        skillSlug: 'general',
        voiceText:
          '{"mode":"idle","skillSlug":null,"voiceText":"Hello from voice","screenText":"Hello from screen","visualTargets":[]}',
        screenText: '',
        visualTargets: [],
        expectedNextState: 'user_asks_question'
      }).detail
    ).toBe('Hello from screen');
  });
});
