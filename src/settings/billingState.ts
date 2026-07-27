import type { MeResponse, SubStatus } from '@kairo/shared';

export type BillingReturnStatus = 'succeeded' | 'failed' | 'cancelled' | 'processing' | 'unknown';

export function normalizeBillingReturnStatus(value: unknown): BillingReturnStatus {
  if (value === 'success' || value === 'succeeded') return 'succeeded';
  if (value === 'failed') return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  if (value === 'processing' || value === 'pending') return 'processing';
  return 'unknown';
}

export function shouldContinueBillingPoll(
  syncStatus: string | undefined,
  me: MeResponse | null,
): boolean {
  if (!syncStatus || syncStatus === 'pending') return true;
  return !me || me.status !== syncStatus;
}

export function billingNotice(
  me: MeResponse | null,
  returnStatus: BillingReturnStatus,
): { tone: 'progress' | 'error' | 'neutral'; title: string; body: string } | null {
  if (me?.plan === 'pro') return null;
  const status: SubStatus | BillingReturnStatus = me?.status === 'none' ? returnStatus : (me?.status ?? returnStatus);
  if (status === 'failed') {
    return {
      tone: 'error',
      title: 'Payment didn’t complete',
      body: 'Your subscription wasn’t activated. You can try the checkout again.',
    };
  }
  if (status === 'pending' || status === 'processing' || status === 'succeeded') {
    return {
      tone: 'progress',
      title: 'Confirming your payment',
      body: 'Kairo is checking the subscription directly with Dodo.',
    };
  }
  if (status === 'cancelled' || status === 'expired') {
    return {
      tone: 'neutral',
      title: 'Your Pro plan has ended',
      body: 'You’re back on the Free plan and can subscribe again at any time.',
    };
  }
  return null;
}
