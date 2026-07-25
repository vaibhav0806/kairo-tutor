import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { auth } from './better-auth';

/**
 * The public key set used to verify our own JWTs — resolved IN-PROCESS, never over HTTP.
 *
 * We sign and verify in the same service, so the keys are already reachable locally: Better Auth's
 * `getJwks` endpoint reads them straight out of the `jwks` table. Going through
 * `createRemoteJWKSet(PUBLIC_BASE_URL/api/auth/jwks)` instead made every authenticated request
 * depend on the container being able to reach its own public hostname (DNS -> CDN -> reverse proxy
 * -> back into the container). In production that hairpin hangs, jose's 5s JWKS timeout fires and
 * every request 401s. Reading the key set in-process removes that dependency entirely.
 */

/**
 * Min gap between key-set reloads triggered by an unknown `kid` (same idea as jose's remote-JWKS
 * cooldown): a stream of tokens signed by keys we don't know can't turn into a DB read per request.
 */
const REFRESH_COOLDOWN_MS = 30_000;

export interface CachedJwksOptions {
  /** Override the unknown-`kid` reload cooldown (tests use 0). */
  refreshCooldownMs?: number;
}

/**
 * Wrap a key-set loader in a cached, rotation-aware `jose` key resolver.
 *
 * The set is loaded once and kept in memory (hot path = pure in-process crypto, no I/O). If a token
 * arrives with a `kid` we don't have — i.e. the signing key rotated — we reload the set once
 * (rate-limited) and retry, so rotation heals itself without a restart and without hardcoding keys.
 */
export function createCachedJwks(
  load: () => Promise<JSONWebKeySet>,
  { refreshCooldownMs = REFRESH_COOLDOWN_MS }: CachedJwksOptions = {},
): JWTVerifyGetKey {
  let resolve: ReturnType<typeof createLocalJWKSet> | null = null;
  let loadedAt = 0;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    // Dedupe concurrent reloads — a cold start under load must not stampede the DB.
    if (!inflight) {
      inflight = (async () => {
        resolve = createLocalJWKSet(await load());
        loadedAt = Date.now();
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return async (protectedHeader, token) => {
    if (!resolve) await refresh();
    try {
      return await resolve!(protectedHeader, token);
    } catch (err) {
      const rotated = err instanceof errors.JWKSNoMatchingKey;
      if (!rotated || Date.now() - loadedAt < refreshCooldownMs) throw err;
      await refresh();
      return await resolve!(protectedHeader, token);
    }
  };
}

/** The live key set: Better Auth's own keys, read from the DB in-process. */
export const jwks: JWTVerifyGetKey = createCachedJwks(
  async () => (await auth.api.getJwks()) as JSONWebKeySet,
);
