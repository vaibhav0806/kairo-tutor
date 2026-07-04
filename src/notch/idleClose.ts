// Pure decision for the notch idle auto-close. Extracted so the guard logic —
// especially the native-recording guard that fixes the "listening indicator
// vanishes mid-hold" bug — is unit-tested instead of buried in a useEffect.
export type IdleCloseState = {
  answerSettled: boolean;
  isSubmitting: boolean;
  voiceCaptureState: string;
  queryLen: number;
  pointerHolding: boolean;
  recording: boolean;
  idleElapsedMs: number;
  idleThresholdMs: number;
};

export function shouldIdleClose(s: IdleCloseState): boolean {
  if (!s.answerSettled) return false;
  if (s.isSubmitting) return false;
  if (s.voiceCaptureState !== 'idle') return false;
  if (s.queryLen > 0) return false;
  if (s.recording) return false; // native ⌥⌃ hold in progress — keep the capsule up
  if (s.pointerHolding) return false;
  return s.idleElapsedMs >= s.idleThresholdMs;
}
