import type { NativePermissionStatus } from '../../native/nativeBridge';

/** The Act 3 sub-steps, in dependency order (Screen Recording gates the Accessibility point). */
export type Act3SubStep = 'screen' | 'accessibility' | 'done';

/**
 * Single source of truth for where Act 3 is, derived from the LIVE permission status (not a
 * persisted marker) so it is correct across the Screen-Recording quit+reopen. Screen Recording
 * must be granted before Accessibility, so the pet can vision-point at the real toggle.
 */
export function nextPermissionStep(status: NativePermissionStatus): Act3SubStep {
  if (status.screenRecording !== 'granted') return 'screen';
  if (status.accessibility !== 'granted') return 'accessibility';
  return 'done';
}
