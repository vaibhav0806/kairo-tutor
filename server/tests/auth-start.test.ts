import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { env } from '../src/config/env';

const app = await buildApp();
const STATE = '0123456789abcdef0123456789abcdef';

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}
const correlationCookie = (res: { headers: Record<string, unknown> }) =>
  setCookies(res).find((c) => c.startsWith('kairo_desktop_auth_state='));

describe('desktop OAuth correlation · enforced (the shipped default)', () => {
  it('enforces by default, because no build without the state was ever distributed', () => {
    expect(env.KAIRO_REQUIRE_DESKTOP_AUTH_STATE).toBe(true);
  });

  it('refuses to start sign-in without a correlation state', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/start' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'bad_request' });
    expect(correlationCookie(res)).toBeUndefined();
  });

  it('refuses a malformed correlation state rather than trusting it', async () => {
    // The state is compared against one the desktop generated, so anything not matching its
    // shape cannot possibly correlate — accepting it would only weaken the check.
    for (const bad of ['not-hex', '0123', `${STATE}extra`, 'ZZZZ56789abcdef0123456789abcdef1']) {
      const res = await app.inject({ method: 'GET', url: `/auth/start?desktop_state=${bad}` });
      expect(res.statusCode, `expected 400 for ${bad}`).toBe(400);
    }
  });

  it('correlates a valid sign-in with a short-lived, host-only cookie', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/start?desktop_state=${STATE}` });

    const cookie = correlationCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain(STATE);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(res.statusCode).not.toBe(400);
  });

  it('refuses a callback that carries no correlation cookie', async () => {
    // An unsolicited callback must be stopped BEFORE the session is consulted — this is the
    // login-CSRF the correlation exists to prevent.
    const res = await app.inject({ method: 'GET', url: '/auth/callback' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('That sign-in didn’t finish.');
  });

  it('answers a failed OAuth handoff with our page, not Better Auth’s stock error screen', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/error?error=state_mismatch' });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('That sign-in didn’t finish.');
    expect(res.body).not.toContain('state_mismatch');
    expect(res.body).not.toContain('Go Home');
  });
});

describe('desktop OAuth correlation · shim (escape hatch, off by default)', () => {
  let shimApp: Awaited<ReturnType<typeof buildApp>>;
  const previous = process.env.KAIRO_REQUIRE_DESKTOP_AUTH_STATE;

  beforeAll(async () => {
    // The flag is read once at import, so exercising the other branch needs a fresh module graph.
    process.env.KAIRO_REQUIRE_DESKTOP_AUTH_STATE = 'false';
    vi.resetModules();
    const { buildApp: build } = await import('../src/app');
    shimApp = await build();
  });

  afterAll(async () => {
    // Assigning `undefined` stores the STRING "undefined", which then fails Zod on a later
    // fresh import instead of falling back to the default. Delete it when there was no value.
    if (previous === undefined) delete process.env.KAIRO_REQUIRE_DESKTOP_AUTH_STATE;
    else process.env.KAIRO_REQUIRE_DESKTOP_AUTH_STATE = previous;
    vi.resetModules();
  });

  it('serves an un-correlated sign-in instead of locking the client out', async () => {
    const res = await shimApp.inject({ method: 'GET', url: '/auth/start' });

    expect(res.statusCode).not.toBe(400);
    expect(correlationCookie(res)).toBeUndefined();
  });

  it('lets an un-correlated callback reach the session check', async () => {
    // 401 (no session) rather than 400 (no cookie) proves the correlation gate let it through.
    const res = await shimApp.inject({ method: 'GET', url: '/auth/callback' });

    expect(res.statusCode).toBe(401);
  });

  it('still correlates a modern client while the shim is on', async () => {
    const res = await shimApp.inject({ method: 'GET', url: `/auth/start?desktop_state=${STATE}` });

    expect(correlationCookie(res)).toContain(STATE);
  });
});
