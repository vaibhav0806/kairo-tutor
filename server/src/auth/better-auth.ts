import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt, bearer } from 'better-auth/plugins';
import { db } from '../db/client';
import { env } from '../config/env';
import { ensureUserRows } from '../usage/service';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  baseURL: env.PUBLIC_BASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  // The desktop finishes OAuth in the system browser and gets a one-time code back over kairo://.
  trustedOrigins: ['kairo://'],
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  plugins: [
    // Short-lived JWT the proxy verifies statelessly via JWKS (no DB on the hot path).
    jwt({
      jwt: {
        issuer: env.PUBLIC_BASE_URL,
        audience: env.PUBLIC_BASE_URL,
        expirationTime: '15m',
        definePayload: ({ user }) => ({ sub: user.id, email: user.email }),
      },
    }),
    // Lets Better Auth's own endpoints accept our session token as a bearer header (desktop client).
    bearer(),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureUserRows(user.id);
        },
      },
    },
  },
});
