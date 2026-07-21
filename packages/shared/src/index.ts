// Shared contracts between the desktop app and the Fastify server.
// Source-only package (no build step); consumers (Vite, tsx, tsup, tsc) read this TS directly.

/** Header the desktop sets so the backend meters one whole ask exactly once. */
export const ASK_ID_HEADER = 'x-kairo-ask-id';

export type Plan = 'free' | 'pro';

export type SubStatus =
  | 'none'
  | 'pending'
  | 'active'
  | 'on_hold'
  | 'cancelled'
  | 'failed'
  | 'expired';

/** Response of `GET /v1/me`. `usage.remaining` is null for unlimited (pro). */
export interface MeResponse {
  user: { id: string; email: string };
  plan: Plan;
  status: SubStatus;
  usage: { used: number; limit: number; remaining: number | null };
  renews_at: string | null;
  cancel_at_period_end: boolean;
  paywalled: boolean;
  /** True once the user finishes the onboarding flow. */
  onboarded: boolean;
  display_name: string | null;
  /** The user's name from their Google profile (Better Auth `user.name`). Optional. */
  account_name?: string | null;
}

/** Body of `POST /v1/onboarding`. */
export interface OnboardingBody {
  displayName: string;
  source: string;
  /** Chosen accent color, hex `#rrggbb`. Optional; validated server-side. */
  accent?: string;
}

/** Common "where did you find us" options (the app also allows a free-text "Other"). */
export const ONBOARDING_SOURCES = [
  'Twitter / X',
  'YouTube',
  'A friend',
  'Search',
  'Reddit',
  'Other',
] as const;

/** Typed error the desktop branches on (401 / 402 / 5xx bodies share this envelope). */
export type ErrorCode =
  | 'quota_exceeded'
  | 'unauthenticated'
  | 'offline'
  | 'provider_error'
  | 'bad_request';

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  message?: string;
}
