import type { TutorResponse } from './types';

export function tutorErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected tutor runtime failure.';
}

/**
 * What actually went wrong, in terms a user can act on.
 *
 * Every failed turn used to speak the same line — "The AI provider is unavailable. Check provider
 * configuration before continuing." — which is a developer's sentence: it names a thing the user
 * does not have, cannot see and cannot fix. Worse, it says the same thing whether the wifi dropped,
 * the session expired, or the free quota ran out, so it never points at the one action that would
 * fix it.
 *
 * Classification is deliberately string-based over the message the transport already produced: the
 * desktop must not learn provider-specific shapes (AGENTS.md — the server owns the providers), so
 * status codes and the browser's own offline flag are all it gets to look at.
 */
export type TutorFailureKind = 'offline' | 'unreachable' | 'signed_out' | 'quota' | 'unknown';

const COPY: Record<TutorFailureKind, { voice: string; screen: string }> = {
  offline: {
    voice: "You're offline — I can't see anything until you're back online.",
    screen: 'No internet connection. Kairo needs one to look at your screen.'
  },
  unreachable: {
    voice: "I can't reach Kairo right now. Give it a moment and try again.",
    screen: "Couldn't reach Kairo's servers. This is usually brief — try again in a moment."
  },
  signed_out: {
    voice: "You've been signed out. Open Kairo's settings to sign back in.",
    screen: 'Your session expired. Sign in again from Settings to keep going.'
  },
  quota: {
    voice: "That was your last free turn. Upgrade in settings and I'll keep going.",
    screen: "You've used all your free turns. Upgrade to Pro for unlimited guidance."
  },
  unknown: {
    voice: "Something went wrong on my side. Try that again?",
    screen: "Kairo couldn't finish that one. Try again — if it keeps happening, restart Kairo."
  }
};

export function classifyTutorFailure(error: unknown): TutorFailureKind {
  // The browser's own flag first: a dropped connection is the single most likely cause, and it is
  // the one the user can actually see for themselves.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

  const message = tutorErrorMessage(error).toLowerCase();
  if (/\b(401|403|unauthor|forbidden|signed out|session)\b/.test(message)) return 'signed_out';
  if (/\b(402|429|quota|limit reached|payment required)\b/.test(message)) return 'quota';
  if (/(failed to fetch|networkerror|network error|econnrefused|enotfound|timed? ?out|dns)/.test(message)) {
    return 'unreachable';
  }
  if (/\b(500|502|503|504|bad gateway|unavailable)\b/.test(message)) return 'unreachable';
  return 'unknown';
}

export function createTutorRuntimeErrorResponse({
  skillSlug,
  error
}: {
  skillSlug: string;
  error: unknown;
}): TutorResponse {
  const kind = classifyTutorFailure(error);
  const copy = COPY[kind];
  return {
    mode: 'stuck_help',
    skillSlug,
    voiceText: copy.voice,
    screenText: copy.screen,
    visualTargets: [],
    expectedNextState: `tutor_failure_${kind}`,
    providerMetadata: {
      confidenceState: 'low',
      warnings: [tutorErrorMessage(error)]
    }
  };
}
