export interface AlertState {
  failing: boolean;
  consecutiveFailures: number;
  lastAlertAt: number | null;
}

export type AlertAction = 'failure' | 'recovery' | null;

const REMINDER_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function nextAlertState(
  previous: AlertState | null,
  hasFailures: boolean,
  now: number,
): { state: AlertState | null; action: AlertAction } {
  if (!hasFailures) {
    if (!previous?.failing) return { state: null, action: null };
    return {
      state: { failing: false, consecutiveFailures: 0, lastAlertAt: null },
      action: previous.lastAlertAt === null ? null : 'recovery',
    };
  }

  if (!previous?.failing) {
    return {
      state: { failing: true, consecutiveFailures: 1, lastAlertAt: null },
      action: null,
    };
  }

  const shouldAlert = previous.consecutiveFailures < 2 ||
    (previous.lastAlertAt !== null && now - previous.lastAlertAt >= REMINDER_INTERVAL_MS);
  if (!shouldAlert) return { state: null, action: null };

  return {
    state: {
      failing: true,
      consecutiveFailures: Math.max(2, previous.consecutiveFailures + 1),
      lastAlertAt: now,
    },
    action: 'failure',
  };
}
