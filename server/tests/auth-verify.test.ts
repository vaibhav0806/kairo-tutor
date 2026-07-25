import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import { buildApp } from '../src/app';
import { db, pool } from '../src/db/client';
import { env } from '../src/config/env';
import { createCachedJwks } from '../src/auth/jwks';
import { ensureUserRows } from '../src/usage/service';
import { mintCode } from '../src/auth/codes';

const uid = 'test-user-authverify';
// NOTE: no `app.listen(...)` anywhere in this file — that is the point. JWT verification must not
// need the server to be reachable over the network (it used to fetch its own /api/auth/jwks).
const app = await buildApp();

beforeAll(async () => {
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${uid}, 'Av', 'av@t.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING`);
  await ensureUserRows(uid);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM session WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM oauth_code WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM usage_counter WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM subscription WHERE user_id = ${uid}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${uid}`);
  await app.close();
  await pool.end();
});

async function freshJwt(): Promise<string> {
  const code = await mintCode(uid);
  const ex = await app.inject({ method: 'POST', url: '/auth/exchange', payload: { code } });
  const sessionToken = ex.json().sessionToken as string;
  const tok = await app.inject({
    method: 'GET',
    url: '/api/auth/token',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  return tok.json().token as string;
}

/** An Ed25519 keypair + its public JWK, matching how Better Auth signs (EdDSA). */
async function keypair(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA' };
  return { privateKey, jwk };
}

describe('requireAuth (no self-fetch to the public hostname)', () => {
  it('verifies a real JWT without any HTTP request to PUBLIC_BASE_URL', async () => {
    const publicHost = new URL(env.PUBLIC_BASE_URL).host;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const jwt = await freshJwt();
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${jwt}` } });
      expect(res.statusCode).toBe(200);

      const selfCalls = fetchSpy.mock.calls.filter(([input]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url.includes(publicHost);
      });
      expect(selfCalls).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('401s without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });

  it('401s on a malformed token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer not-a-jwt' } });
    expect(res.statusCode).toBe(401);
  });

  it('401s on a token signed by a key we do not know (forged)', async () => {
    const { privateKey } = await keypair('forged-key');
    const forged = await new SignJWT({ sub: uid })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'forged-key' })
      .setIssuer(env.PUBLIC_BASE_URL)
      .setAudience(env.PUBLIC_BASE_URL)
      .setExpirationTime('15m')
      .sign(privateKey);
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${forged}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe('createCachedJwks', () => {
  it('loads the key set once and reuses it across verifications', async () => {
    const k1 = await keypair('k1');
    const load = vi.fn(async (): Promise<JSONWebKeySet> => ({ keys: [k1.jwk] }));
    const getKey = createCachedJwks(load);

    const token = async () =>
      new SignJWT({ sub: 'u' }).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setExpirationTime('5m').sign(k1.privateKey);

    await expect(jwtVerify(await token(), getKey)).resolves.toBeTruthy();
    await expect(jwtVerify(await token(), getKey)).resolves.toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads on an unknown kid so key rotation heals without a restart', async () => {
    const k1 = await keypair('k1');
    const k2 = await keypair('k2');
    let rotated = false;
    const load = vi.fn(async (): Promise<JSONWebKeySet> => ({ keys: rotated ? [k1.jwk, k2.jwk] : [k1.jwk] }));
    const getKey = createCachedJwks(load, { refreshCooldownMs: 0 });

    // Prime the cache with the pre-rotation key set.
    const old = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setExpirationTime('5m')
      .sign(k1.privateKey);
    await expect(jwtVerify(old, getKey)).resolves.toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);

    // A token signed by the newly added key: unknown kid -> reload -> verifies.
    rotated = true;
    const fresh = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k2' })
      .setExpirationTime('5m')
      .sign(k2.privateKey);
    await expect(jwtVerify(fresh, getKey)).resolves.toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not reload again while cooling down (unknown kids cannot hammer the db)', async () => {
    const k1 = await keypair('k1');
    const unknown = await keypair('nope');
    const load = vi.fn(async (): Promise<JSONWebKeySet> => ({ keys: [k1.jwk] }));
    const getKey = createCachedJwks(load, { refreshCooldownMs: 60_000 });

    const bad = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'nope' })
      .setExpirationTime('5m')
      .sign(unknown.privateKey);
    await expect(jwtVerify(bad, getKey)).rejects.toThrow();
    await expect(jwtVerify(bad, getKey)).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired token even when the signing key is known', async () => {
    const k1 = await keypair('k1');
    const getKey = createCachedJwks(async () => ({ keys: [k1.jwk] }));
    const expired = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(k1.privateKey);
    await expect(jwtVerify(expired, getKey)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
  });
});
