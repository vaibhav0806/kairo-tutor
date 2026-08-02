import { describe, expect, it } from 'vitest';
import { authCallbackDeepLink, callbackPage, isDesktopAuthState } from '../src/auth/routes';
import { renderBillingReturnPage } from '../src/billing/return-page';
import { requestPath } from '../src/logging';
import {
  ProviderError,
  SAFE_PROVIDER_ERROR_MESSAGE,
  providerErrorLogFields,
} from '../src/plugins/error-handler';

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

  // Only reachable with the shim enabled (KAIRO_REQUIRE_DESKTOP_AUTH_STATE=false). Kept so the
  // escape hatch cannot rot: if it is ever needed, it must still emit a link a client can use.
  it('omits the correlated parameter for a legacy build instead of faking one', () => {
    expect(authCallbackDeepLink('one-time-code', null)).toBe(
      'kairo://auth-callback?code=one-time-code',
    );
  });

  it('removes every query string from automatic request logs', () => {
    expect(requestPath('/billing/return?status=active&email=private@example.com')).toBe('/billing/return');
    expect(requestPath('/api/auth/callback/google?code=secret&state=secret')).toBe('/api/auth/callback/google');
    expect(requestPath('/readyz')).toBe('/readyz');
  });

  it('keeps upstream provider content out of logs and client errors', () => {
    const secret = 'private transcript echoed by provider';
    const error = new ProviderError('Provider returned an error response.', {
      provider: 'openrouter',
      errorClass: 'http',
      status: 502,
      bodySnippet: secret,
    });

    expect(providerErrorLogFields(error, '/v1/llm/chat?prompt=private')).toEqual({
      provider: 'openrouter',
      errorClass: 'http',
      status: 502,
      path: '/v1/llm/chat',
      // The length is always safe — it says the upstream spoke without repeating it.
      bodyChars: secret.length,
      body: undefined,
    });
    expect(JSON.stringify(providerErrorLogFields(error))).not.toContain(secret);
    expect(SAFE_PROVIDER_ERROR_MESSAGE).not.toContain(secret);
  });
});
