import { describe, expect, it } from 'vitest';
import { hasManageableSubscription } from '@kairo/shared';

describe('hasManageableSubscription', () => {
  it('distinguishes billed Pro from complimentary and inactive access', () => {
    expect(hasManageableSubscription('active')).toBe(true);
    expect(hasManageableSubscription('on_hold')).toBe(true);
    expect(hasManageableSubscription('cancelled')).toBe(true);
    expect(hasManageableSubscription('none')).toBe(false);
    expect(hasManageableSubscription('pending')).toBe(false);
    expect(hasManageableSubscription('expired')).toBe(false);
    expect(hasManageableSubscription('failed')).toBe(false);
  });
});
