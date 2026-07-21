import type { NotchPayload } from './types';
import type { VoiceCaptureState } from './voiceRecorder';

export type NotchCapsuleMode =
  | 'listening'
  | 'thinking'
  | 'coach'
  | 'typing'
  | 'error'
  | 'idle';

// Pure mirror of NotchApp's derivation. The five existing branches are byte-identical
// to the previous inline logic; the only addition is the leading 'coach' branch, which
// renders Phase 0's onboarding caption state.
export function resolveCapsuleMode(a: {
  state: NotchPayload['state'];
  layout: NotchPayload['layout'];
  isSpeaking: boolean;
  isSubmitting: boolean;
  voiceCaptureState: VoiceCaptureState;
  detailHidden: boolean;
}): NotchCapsuleMode {
  if (a.state === 'coach') return 'coach';
  if (a.state === 'listening') return 'listening';
  if (!a.isSpeaking && a.voiceCaptureState === 'error') return 'error';
  if (
    !a.isSpeaking &&
    (a.isSubmitting ||
      a.state === 'thinking' ||
      a.voiceCaptureState === 'transcribing' ||
      a.detailHidden)
  )
    return 'thinking';
  if (!a.isSpeaking && a.layout === 'prompt') return 'typing';
  return 'idle';
}
