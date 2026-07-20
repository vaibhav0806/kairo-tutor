import { describe, expect, test } from 'vitest';
import {
  activationStateToNotchPayload,
  tutorResponseToNotchPayload
} from '../src/activation/activationState';

describe('activation state', () => {
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
