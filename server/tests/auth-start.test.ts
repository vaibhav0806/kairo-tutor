import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { env } from '../src/config/env';

const app = await buildApp();

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

describe('desktop OAuth correlation · rollout transition', () => {
  it('defaults to accepting a legacy sign-in so installed builds are not locked out', () => {
    // Flipping this to true is the end of the transition, not the default. An installed build
    // cannot update past a sign-in it can no longer complete.
    expect(env.KAIRO_REQUIRE_DESKTOP_AUTH_STATE).toBe(false);
  });

  it('starts sign-in without a correlation state and sets no correlation cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/start' });

    expect(res.statusCode).not.toBe(400);
    expect(setCookies(res).some((c) => c.startsWith('kairo_desktop_auth_state='))).toBe(false);
  });

  it('correlates a modern sign-in with a short-lived, host-only cookie', async () => {
    const state = '0123456789abcdef0123456789abcdef';
    const res = await app.inject({ method: 'GET', url: `/auth/start?desktop_state=${state}` });

    const cookie = setCookies(res).find((c) => c.startsWith('kairo_desktop_auth_state='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain(state);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
  });

  it('ignores a malformed correlation state rather than refusing the sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/start?desktop_state=not-hex' });

    expect(res.statusCode).not.toBe(400);
    expect(setCookies(res).some((c) => c.startsWith('kairo_desktop_auth_state='))).toBe(false);
  });

  it('answers a failed OAuth handoff with our page, not Better Auth’s stock error screen', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/error?error=state_mismatch' });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('That sign-in didn’t finish.');
    // The stock page's furniture must not reach the user.
    expect(res.body).not.toContain('state_mismatch');
    expect(res.body).not.toContain('Go Home');
  });

  it('does not refuse a legacy callback before the session check runs', async () => {
    // No correlation cookie and no session: the 401 proves the missing cookie is not what stopped
    // it, which is what a legacy build's callback looks like.
    const res = await app.inject({ method: 'GET', url: '/auth/callback' });

    expect(res.statusCode).toBe(401);
  });
});
