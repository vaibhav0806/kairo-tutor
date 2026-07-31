# Privacy and data handling

This document describes the current repository's technical data flows. It is intended
for users, contributors, and self-hosters; it is not a substitute for a deployment
operator's legal privacy notice.

## What the desktop accesses

Kairo may access:

- microphone audio while push-to-talk recording is active;
- a screenshot of the main display when a tutoring turn needs visual context;
- the frontmost application's name, bundle identifier, and window title;
- keyboard modifier events used by the global activation shortcut;
- global click/scroll activity and pointer coordinates used to advance follow-along guidance; and
- text typed into Kairo, annotations, onboarding answers, and app preferences.

Kairo needs macOS Microphone, Screen Recording, Accessibility, and Input Monitoring
permissions for its complete interaction model. These permissions can be revoked at
any time in **System Settings → Privacy & Security**.

Screen capture is blocked for a conservative list of known sensitive applications,
and captures are discarded if the frontmost app changes during capture. This reduces
accidental disclosure but cannot identify every sensitive app or every private item
shown inside an otherwise ordinary app. The user remains responsible for what is
visible when asking a screen-aware question.

## Network data flow

By default, the desktop sends requests to the configured Kairo backend. The backend
authenticates the request and forwards only the content needed for the selected
provider operation.

| Recipient | Purpose | Content that may be sent |
| --- | --- | --- |
| Kairo backend | Authentication, proxying, usage, preferences, billing | Account/session identifiers, questions, recorded audio, screenshots, answer text, request metadata |
| Google | OAuth sign-in | Browser sign-in request and normal Google OAuth data |
| OpenRouter | Text tutoring, request routing, and fallback vision | Question/transcript, recent dialogue, active-app and window context, cached display name, system/skill prompts, and, on fallback vision paths, a resized screenshot |
| OpenAI or Anthropic | Screen-aware tutoring and pointing | Question/transcript, recent dialogue, active-app and window context, cached display name, system/skill prompts, and a resized screenshot |
| Sarvam | Speech recognition and synthesis | Recorded audio for STT; answer text and voice settings for TTS |
| ElevenLabs | Optional synthesis and voice selection | Answer text, selected voice, and voice-catalog requests |
| Dodo Payments | Checkout and subscription management | Email, Kairo user identifier, checkout identifiers, and subscription/payment events |
| PostgreSQL host | Backend database hosting (Neon for Kairo-hosted deployments) | The persisted backend records listed below |

Third-party providers process data under their own terms and privacy policies. A
self-hosted backend operator chooses its provider accounts and is responsible for its
deployment, retention, access controls, and disclosures. Disabling the backend proxy
for local debugging sends content directly from the desktop to the selected AI or
speech provider instead.

## Screen and audio handling

- Push-to-talk audio is held in memory, encoded for transport, transcribed, and then
  used as the tutoring question. The application does not intentionally save the raw
  recording as a user-accessible local file.
- For a non-paywalled voice ask, screen capture starts locally after push-to-talk is
  released, in parallel with transcription. The text gate decides whether that frame
  is transmitted; a text-only turn discards it locally. Typed and annotation-led asks
  are screen-first.
- Screen capture uses one main-display temporary PNG and attempts to remove it on every
  success or error path. The image is resized to at most 1280 px on its longest edge and
  normally sent as JPEG data for vision turns.
- The follow-along frame-change detector may capture locally for comparison without
  sending that frame to a model.
- Production distribution builds exclude Kairo's notch, cursor, and guidance UI from
  capture. User pen marks are intentionally included. Local/demo builds may include
  the rest of Kairo's UI.
- Questions that do not require visual context can be answered without sending a
  screenshot.

## Data stored on the Mac

The application stores small state files under macOS Application Support, including:

- the session bearer token (a mode-`0600` file, not macOS Keychain);
- the short-lived pending OAuth state (also mode `0600`);
- onboarding completion/resume markers;
- the cached display name and selected accent; and
- permission-history markers used by onboarding and the locally disabled-skill list.

Developer logs are written under `~/Library/Logs/Kairo/` and kept for up to seven
daily files. Full transcript, question, and answer text is disabled by default; those
fields are logged as character counts. Logs still contain timestamps, subsystem
events, provider names, durations, byte counts, dimensions, and error information.
Review and redact logs before sharing them.

Gesture-debug image capture exists for local development but is disabled by default.
When a contributor explicitly enables it in source, JPEG screenshots are written
under `~/Library/Logs/Kairo/gesture-debug/` and must be treated as sensitive.

Recent tutoring conversation context is kept in process memory for continuity and is
not intentionally persisted locally. A new app process starts with an empty history.

Contributors can deliberately enable full-text logging in source for local debugging.
Never distribute such a build and never attach an unreviewed log to a public issue.

## Data stored by the backend

The backend database stores data needed to operate accounts and subscriptions:

- Google account profile fields, sessions, OAuth account records, and one-time codes;
- invite and download-request email addresses;
- onboarding display name, referral/source answer, accent, and completion state;
- usage counters and request identifiers;
- selected speech provider and voice;
- subscription, checkout, customer, product, and verified webhook records; and
- authentication signing-key records.

The application does not intentionally persist tutoring questions, transcripts,
screenshots, audio recordings, or model answers in the backend database. They pass
through server memory to complete the request. Backend request logs include operational
metadata such as method, path, host, and remote address, but not request bodies by
design. Infrastructure and third-party services may independently retain request
metadata or content according to their configuration and policies.

## Privacy-safe contributions

- Never commit `.env` files, provider keys, tokens, production data, or real webhook
  payloads.
- Use synthetic questions, screenshots, audio, account details, and billing fixtures
  in tests and documentation.
- Do not add request-body logging. Log metadata such as byte counts and latency.
- Route transcript-like text through the repository's redaction helpers.
- Treat screenshots and audio as sensitive even when they appear harmless.

Report a privacy or security issue privately using [SECURITY.md](./SECURITY.md).
