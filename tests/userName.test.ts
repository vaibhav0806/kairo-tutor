import { describe, expect, test } from 'vitest';
import { pickUserName } from '../src/onboarding/userName';

describe('pickUserName', () => {
  test('prefers display_name, falls back to account_name, then empty', () => {
    expect(pickUserName({ display_name: 'Prasad', account_name: 'P. Kumar' } as never)).toBe('Prasad');
    expect(pickUserName({ display_name: null, account_name: 'P. Kumar' } as never)).toBe('P. Kumar');
    expect(pickUserName({ display_name: '', account_name: '' } as never)).toBe('');
    expect(pickUserName(null)).toBe('');
  });
});
