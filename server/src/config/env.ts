import 'dotenv/config';
import { z } from 'zod';
import { assertStaticEnvironment } from './targets';

const Env = z.object({
  KAIRO_SERVER_TARGET: z.enum(['local', 'hosted']).default('local'),
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  SARVAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  DODO_ENV: z.enum(['test_mode', 'live_mode']).default('test_mode'),
  // Dodo keys — SAME names as the root .env (one source of truth, no confusion). The active
  // key + webhook secret are selected by DODO_ENV (see dodoApiKey / dodoWebhookSecret below).
  DODO_KAIRO_TEST_KEY: z.string().optional(),
  DODO_KAIRO_LIVE_KEY: z.string().optional(),
  DODO_TEST_WEBHOOK_SECRET: z.string().optional(),
  DODO_LIVE_WEBHOOK_SECRET: z.string().optional(),
  // The single Pro product — its id differs between the test + live Dodo dashboards, so
  // both are held and DODO_ENV picks (keeps the test<->live flip a one-var switch).
  DODO_KAIRO_TEST_PRODUCT_ID: z.string().optional(),
  DODO_KAIRO_LIVE_PRODUCT_ID: z.string().optional(),
});

export const env = Env.parse(process.env);
assertStaticEnvironment(env);
export type AppEnv = typeof env;

// The Dodo key + webhook secret + product id in effect, chosen by DODO_ENV (test vs live).
export const dodoApiKey =
  env.DODO_ENV === 'live_mode' ? env.DODO_KAIRO_LIVE_KEY : env.DODO_KAIRO_TEST_KEY;
export const dodoWebhookSecret =
  env.DODO_ENV === 'live_mode' ? env.DODO_LIVE_WEBHOOK_SECRET : env.DODO_TEST_WEBHOOK_SECRET;
export const dodoProductId =
  env.DODO_ENV === 'live_mode' ? env.DODO_KAIRO_LIVE_PRODUCT_ID : env.DODO_KAIRO_TEST_PRODUCT_ID;
