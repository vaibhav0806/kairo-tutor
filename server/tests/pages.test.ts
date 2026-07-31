import { describe, expect, it } from 'vitest';
import { authCallbackDeepLink, callbackPage, isDesktopAuthState } from '../src/auth/routes';
import { renderBillingReturnPage } from '../src/billing/return-page';
import { requestPath } from '../src/logging';

describe('browser handoff pages', () => {
  it('centers the billing card and treats Dodo active as success', () => {
    const html = renderBillingReturnPage('active');
    expect(html).toContain('min-height:100dvh');
    expect(html).toContain('align-items:center;justify-content:center');
    expect(html).toContain('kairo://billing-done?status=succeeded');
    expect(html).toContain('Payment received');
  });

  it('renders explicit success and recovery auth experiences', () => {
    const success = callbackPage('kairo://auth-callback?code=one-time-code');
    expect(success).toContain('You’re in. Kairo is ready.');
    expect(success).toContain('kairo://auth-callback?code=one-time-code');
    expect(success).toContain('min-height:100dvh');

    const failure = callbackPage(null);
    expect(failure).toContain('That sign-in didn’t finish.');
    expect(failure).toContain('href="/auth/start"');
    expect(failure).not.toContain('<script>');
  });

  it('preserves only a valid desktop correlation state in the auth deep link', () => {
    const state = '0123456789abcdef0123456789abcdef';
    expect(isDesktopAuthState(state)).toBe(true);
    expect(authCallbackDeepLink('one-time-code', state)).toBe(
      `kairo://auth-callback?code=one-time-code&state=${state}`,
    );
    expect(isDesktopAuthState('short')).toBe(false);
    expect(isDesktopAuthState(['0123456789abcdef0123456789abcdef'])).toBe(false);
  });

  it('removes every query string from automatic request logs', () => {
    expect(requestPath('/billing/return?status=active&email=private@example.com')).toBe('/billing/return');
    expect(requestPath('/api/auth/callback/google?code=secret&state=secret')).toBe('/api/auth/callback/google');
    expect(requestPath('/readyz')).toBe('/readyz');
  });
});
