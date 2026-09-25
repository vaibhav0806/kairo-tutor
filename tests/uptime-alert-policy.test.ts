import { describe, expect, it } from 'vitest';
import { nextAlertState } from '../ops/uptime-worker/src/alert-policy';

describe('uptime alert policy', () => {
  const now = Date.UTC(2026, 8, 26);

  it('requires two consecutive failed checks and suppresses repeated emails', () => {
    const first = nextAlertState(null, true, now);
    expect(first.action).toBeNull();
    const second = nextAlertState(first.state, true, now + 5 * 60_000);
    expect(second.action).toBe('failure');
    expect(nextAlertState(second.state, true, now + 10 * 60_000).action).toBeNull();
    expect(nextAlertState(second.state, true, now + 12 * 60 * 60_000).action).toBeNull();
    expect(nextAlertState(second.state, true, now + 12 * 60 * 60_000 + 5 * 60_000).action).toBe('failure');
  });

  it('sends one recovery after an alerted outage', () => {
    const first = nextAlertState(null, true, now);
    const second = nextAlertState(first.state, true, now + 5 * 60_000);
    const recovered = nextAlertState(second.state, false, now + 10 * 60_000);
    expect(recovered.action).toBe('recovery');
    expect(nextAlertState(recovered.state, false, now + 15 * 60_000).action).toBeNull();
  });

  it('does not email for a single failed check', () => {
    const first = nextAlertState(null, true, now);
    expect(nextAlertState(first.state, false, now + 5 * 60_000).action).toBeNull();
  });
});
