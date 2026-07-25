import type { NotchPayload } from './types';
import type { VoiceCaptureState } from './voiceRecorder';

export type NotchCapsuleMode =
  | 'listening'
  | 'thinking'
  | 'speaking'
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
  // Speaking WHILE the turn is still in flight = the gate's "let me look" filler. Kairo is
  // talking, not thinking, so show the speaking state instead of the thinking cube. Scoped to
  // `isSubmitting` so the answer narration (submit already cleared) keeps its own answer card.
  if (a.isSpeaking && a.isSubmitting) return 'speaking';
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
