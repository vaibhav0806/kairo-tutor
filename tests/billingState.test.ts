import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@kairo/shared';
import {
  billingNotice,
  normalizeBillingReturnStatus,
  shouldContinueBillingPoll,
} from '../src/settings/billingState';

function me(status: MeResponse['status'], plan: MeResponse['plan'] = 'free'): MeResponse {
  return {
    user: { id: 'u', email: 'u@example.com' },
    plan,
    status,
    usage: { used: 0, limit: 10, remaining: plan === 'pro' ? null : 10 },
    renews_at: null,
    cancel_at_period_end: false,
    paywalled: false,
    onboarded: true,
    display_name: null,
    account_name: null,
  };
}

describe('billing return UI state', () => {
  it('normalizes only known callback statuses', () => {
    expect(normalizeBillingReturnStatus('success')).toBe('succeeded');
    expect(normalizeBillingReturnStatus('failed')).toBe('failed');
    expect(normalizeBillingReturnStatus('anything-else')).toBe('unknown');
  });

  it('shows failed, pending, and ended states instead of generic Free', () => {
    expect(billingNotice(me('failed'), 'unknown')?.title).toBe('Payment didn’t complete');
    expect(billingNotice(me('pending'), 'unknown')?.tone).toBe('progress');
    expect(billingNotice(me('expired'), 'unknown')?.title).toBe('Your Pro plan has ended');
    expect(billingNotice(me('active', 'pro'), 'failed')).toBeNull();
  });

  it('keeps polling pending or mismatched state and stops on a matching terminal state', () => {
    expect(shouldContinueBillingPoll('pending', me('pending'))).toBe(true);
    expect(shouldContinueBillingPoll('active', me('pending'))).toBe(true);
    expect(shouldContinueBillingPoll('active', me('active', 'pro'))).toBe(false);
    expect(shouldContinueBillingPoll('failed', me('failed'))).toBe(false);
  });
});
