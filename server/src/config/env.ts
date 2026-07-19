import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
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
  DODO_PAYMENTS_API_KEY: z.string().optional(),
  DODO_PAYMENTS_WEBHOOK_SECRET: z.string().optional(),
  DODO_ENV: z.enum(['test_mode', 'live_mode']).default('test_mode'),
  // Set once the Pro products exist in the Dodo dashboard. Until then, billing routes 503.
  DODO_PRO_MONTHLY_PRODUCT_ID: z.string().optional(),
  DODO_PRO_YEARLY_PRODUCT_ID: z.string().optional(),
});

export const env = Env.parse(process.env);
export type AppEnv = typeof env;
