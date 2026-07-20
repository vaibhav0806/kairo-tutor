import type { NotchPayload, NotchState } from '../notch/types';
import type { TutorResponse } from '../core/types';

export type ActivationState = NotchState;

export function activationStateToNotchPayload(state: ActivationState): NotchPayload {
  const payloads: Record<ActivationState, NotchPayload> = {
    idle: {
      state: 'idle',
      layout: 'compact',
      title: 'Kairo is ready',
      detail: 'Press the shortcut to start'
    },
    listening: {
      state: 'listening',
      layout: 'compact',
      title: 'Kairo is listening',
      detail: 'Capturing the current screen'
    },
    captured: {
      state: 'captured',
      layout: 'prompt',
      title: 'Screen captured',
      detail: 'Ready for a question'
    },
    thinking: {
      state: 'thinking',
      layout: 'compact',
      title: 'Kairo is thinking',
      detail: 'Preparing the next step'
    },
    showing_step: {
      state: 'showing_step',
      layout: 'answer',
      title: 'Step is ready',
      detail: 'Showing guidance on screen'
    }
  };

  return payloads[state];
}

function visibleResponseText(text: string) {
  const trimmedText = text.trim();
  if (!trimmedText.startsWith('{')) {
    return trimmedText;
  }

  try {
    const parsed = JSON.parse(trimmedText) as Partial<TutorResponse>;
    return (parsed.screenText || parsed.voiceText || trimmedText).trim();
  } catch {
    return trimmedText;
  }
}

export function tutorResponseToNotchPayload(response: TutorResponse): NotchPayload {
  return {
    state: 'showing_step',
    layout: 'answer',
    title: 'Kairo answered',
    detail: visibleResponseText(response.screenText || response.voiceText)
  };
}
