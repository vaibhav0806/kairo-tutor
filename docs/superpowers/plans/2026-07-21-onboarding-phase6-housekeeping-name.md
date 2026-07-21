# Onboarding Phase 6 — Housekeeping + Ending (Acts 5-6) + Finalize Name-in-Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the deferred housekeeping beats of the new onboarding — Google sign-in (Act 5a, pulling the user's name + email from the Google profile, no separate name step), the "where did you hear about us" source chips (Act 5b), and a warm name-personalized ending (Act 6, `finish_onboarding`) — persisting the user's **name + chosen accent color + source** to the account, then wire the user's name **live** into every tutor/gate turn's non-cached prompt section (§12).

**Architecture:** Three concrete layers. (1) **Persistence** — extend the `/v1/onboarding` save route + `saveOnboarding` with the accent color, add a `profile.accent` column, and surface the Google account name via `/v1/me` (`account_name`). (2) **Native name cache** — a file-backed `get_user_name`/`set_user_name` pair (mirrors the existing onboarding markers) so every WebView reads the name at launch with no network. (3) **Name-in-prompt** — thread an optional `userName` from `NotchApp` through `notchTutor` → orchestrator → `run_tutor_turn`/`run_gate_turn`; `prompts.rs` owns the literal line `The user's name is {name}.`, injected into the **per-turn user message only** (never the cached system prefix), so it can't bust prompt caching. The Act 5-6 UI mounts into the Phase 3 onboarding orchestrator's temp-panel + coach-caption surfaces.

**Tech Stack:** Tauri (Rust `src-tauri/`) + React 19/Vite (`src/`) desktop app; Fastify + Neon Postgres + Drizzle + Better Auth (`server/`); vitest (frontend `tests/` node env, server `server/tests/` via `app.inject`); `cargo` for Rust; mandatory `klog!`/`klog()` logging.

---

## Dependency Assumptions (Phases 0-5 landed)

This plan **depends on Phases 0-5**. It consumes these exact contracts from earlier phases; if a symbol was renamed in the parallel refactor, adapt the reference (the behavior is what matters):

- **Phase 0 — Accent pref:** `src/core/accent.ts` exports `getAccent(): Promise<string>` returning the chosen accent hex (`#rrggbb`). Native `get_accent`/`set_accent` commands exist. Act 5 reads `getAccent()` to persist the color.
- **Phase 0 — Coach notch state:** `NotchPayload.state` accepts `'coach'`; onboarding pushes a caption via `show_notch({ state: 'coach', title, detail })`. Act 5/6 use it for spoken captions.
- **Phase 3 — Onboarding orchestrator:** the onboarding WebView is a full-screen transparent orchestrator that (a) renders a centered **temporary panel** for a beat (used by the Act 1 color wheel + Act 5 sign-in), and (b) speaks scripted lines via an existing voice mechanism (`useVoice().speak(segment, name)` in `src/onboarding/useVoice.ts`). This plan adds Act 5-6 components that mount into that temp-panel slot and advance the act sequence.
- **Phase 5 — Paywall exemption:** onboarding practice turns are already exempt from metering (`set_onboarding_ptt` / onboarding tutorial budget). Act 5-6 do not run metered turns; no change needed here.

> **If the Phase 0 name-in-prompt plumbing already exists:** §17 lists Phase 0 as adding "the name-in-prompt plumbing (input field + `prompts.rs` non-cached append)." Tasks 13-15 below add exactly that plumbing. When executing, first check whether `TutorTurnInput.user_name` / `GateInput.user_name` and `prompts::user_name_line` already exist — if they do, mark those steps done and proceed to the frontend wiring (Tasks 16-18). The steps are written to be safe either way.

---

## File Structure

**Backend (`server/`):**
- Modify `packages/shared/src/index.ts` — `OnboardingBody.accent?`, `MeResponse.account_name`.
- Modify `server/src/db/schema/app.ts` — add `accent` to the `profile` table.
- Create `server/drizzle/0004_*.sql` — generated migration for `profile.accent`.
- Modify `server/src/onboarding/service.ts` — `saveProfile` writes `accent`.
- Modify `server/src/onboarding/routes.ts` — validate + pass `accent`.
- Modify `server/src/usage/service.ts` — `readMe` selects `u.name`.
- Modify `server/src/usage/routes.ts` — `/v1/me` returns `account_name`.
- Modify `server/tests/onboarding.test.ts`, `server/tests/me.test.ts` — cover accent + account_name.

**Native (`src-tauri/`):**
- Modify `src-tauri/src/onboarding.rs` — `set_user_name`/`get_user_name` commands.
- Modify `src-tauri/src/lib.rs` — register the two commands.
- Modify `src-tauri/src/types.rs` — `TutorTurnInput.user_name`, `GateInput.user_name`.
- Modify `src-tauri/src/prompts.rs` — `user_name_line` helper (+ Rust unit test).
- Modify `src-tauri/src/tutor.rs` — inject the name into the tutor user prompt + the gate user message; log it.

**Frontend (`src/`):**
- Modify `src/onboarding/backendClient.ts` — `saveOnboarding(accent)`, `getMe()`.
- Create `src/onboarding/userName.ts` — `syncUserName()` (fetch `/v1/me` → cache) + `cacheUserName()`.
- Modify `src/native/nativeBridge.ts` — `getUserName`/`setUserName` wrappers, `NativeGateInput.userName`, `TutorTurnInput.userName` (via orchestrator type).
- Modify `src/onboarding/copy.ts` — Act 5-6 copy segments + cache keys.
- Create `src/onboarding/acts/Act5SignIn.tsx`, `src/onboarding/acts/Act5Source.tsx` — temp-panel components.
- Modify the Phase 3 orchestrator (`src/onboarding/OnboardingFlow.tsx` or its successor) — mount Acts 5-6, persist, `finish_onboarding`.
- Modify `src/core/orchestrator.ts` — `userName` on `TutorTurnInput` + `buildTutorTurnInput`.
- Modify `src/notch/notchTutor.ts` — `userName` on `AskTutorFromNotchOptions`.
- Modify `src/notch/NotchApp.tsx` — read the cached name, pass `userName` into `runGate` + the tutor ask.
- Modify `src/App.tsx` — backfill the name cache from `/v1/me` on sign-in (returning users).
- Tests: `tests/orchestrator.test.ts`, new `tests/userName.test.ts`.

---

## GROUP A — Persist name + accent + source; surface the Google name

### Task 1: Extend shared contracts with accent + Google account name

**Files:**
- Modify: `packages/shared/src/index.ts:19-36`

- [ ] **Step 1: Add `account_name` to `MeResponse` and `accent` to `OnboardingBody`**

In `packages/shared/src/index.ts`, update the two interfaces:

```ts
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
  /** The user's name from their Google profile (Better Auth `user.name`). */
  account_name: string | null;
}

/** Body of `POST /v1/onboarding`. */
export interface OnboardingBody {
  displayName: string;
  source: string;
  /** Chosen accent color, hex `#rrggbb`. Optional; validated server-side. */
  accent?: string;
}
```

- [ ] **Step 2: Typecheck the shared package**

Run: `npm run typecheck -w @kairo/server`
Expected: PASS (the server imports `@kairo/shared`; the new optional fields don't break existing usage).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add accent to OnboardingBody + account_name to MeResponse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add the `profile.accent` column + migration

**Files:**
- Modify: `server/src/db/schema/app.ts:78-87`
- Create: `server/drizzle/0004_*.sql` (generated)

- [ ] **Step 1: Add `accent` to the Drizzle `profile` model**

In `server/src/db/schema/app.ts`, add the column inside `profile`:

```ts
export const profile = pgTable('profile', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  source: text('source'), // "where did you find us"
  accent: text('accent'), // chosen accent color, hex #rrggbb (nullable)
  waitlisted: boolean('waitlisted').notNull().default(true),
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `server/drizzle/0004_<name>.sql` containing `ALTER TABLE "profile" ADD COLUMN "accent" text;` and an updated `server/drizzle/meta/` snapshot.

- [ ] **Step 3: Inspect the generated SQL**

Run: `cat server/drizzle/0004_*.sql`
Expected: exactly one `ALTER TABLE "profile" ADD COLUMN "accent" text;` (forward-only, additive, nullable — no data loss). Do NOT hand-edit it.

- [ ] **Step 4: Dry-run the migration on a Neon branch, then apply to dev**

Run: `npm run db:migrate`
Expected: migration `0004` applies cleanly; re-running is a no-op.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema/app.ts server/drizzle/
git commit -m "feat(db): add profile.accent column (nullable) + migration 0004

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `saveProfile` writes the accent

**Files:**
- Modify: `server/src/onboarding/service.ts:5-13`

- [ ] **Step 1: Add `accent` to `saveProfile` (COALESCE keeps a prior value on empty)**

Replace `saveProfile` in `server/src/onboarding/service.ts`:

```ts
/** Save onboarding answers + mark the flow complete (waitlisted for now). */
export async function saveProfile(
  userId: string,
  displayName: string,
  source: string,
  accent: string | null,
) {
  await db.execute(sql`
    INSERT INTO profile (user_id, display_name, source, accent, waitlisted, onboarding_completed_at)
    VALUES (${userId}, ${displayName}, ${source}, ${accent}, true, now())
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      source = EXCLUDED.source,
      accent = COALESCE(EXCLUDED.accent, profile.accent),
      onboarding_completed_at = now()`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @kairo/server`
Expected: FAIL — `saveProfile` now needs a 4th arg at its call site in `routes.ts`. Task 4 fixes the caller.

- [ ] **Step 3: Commit (with Task 4 — they compile together)**

Defer the commit to the end of Task 4.

---

### Task 4: `/v1/onboarding` validates + persists the accent

**Files:**
- Modify: `server/src/onboarding/routes.ts:11-17`

- [ ] **Step 1: Validate the accent hex and pass it to `saveProfile`**

Replace the `POST /v1/onboarding` handler body in `server/src/onboarding/routes.ts`:

```ts
  // Save onboarding answers (authed) — runs after Google sign-in.
  app.post<{ Body: OnboardingBody }>('/v1/onboarding', { preHandler: requireAuth }, async (req, reply) => {
    const displayName = (req.body?.displayName ?? '').trim().slice(0, 80);
    const source = (req.body?.source ?? '').trim().slice(0, 120);
    // Accent is optional; only persist a well-formed #rrggbb hex, else null.
    const rawAccent = (req.body?.accent ?? '').trim();
    const accent = /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent.toLowerCase() : null;
    if (!displayName) return reply.status(400).send({ error: 'name_required', code: 'bad_request' });
    await saveProfile(req.userId!, displayName, source, accent);
    return { ok: true };
  });
```

- [ ] **Step 2: Add a server test for the accent round-trip**

In `server/tests/onboarding.test.ts`, inside `describe('/v1/onboarding', …)`, add:

```ts
  it('persists a valid accent hex and ignores a malformed one', async () => {
    const jwt = await freshJwt();
    const auth = { authorization: `Bearer ${jwt}` };

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: auth,
      payload: { displayName: 'Prasad', source: 'A friend', accent: '#7C3AED' },
    });
    expect(ok.statusCode).toBe(200);

    // A malformed accent is dropped (null), not rejected — the save still succeeds.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: auth,
      payload: { displayName: 'Prasad', source: 'A friend', accent: 'purple' },
    });
    expect(bad.statusCode).toBe(200);
  });
```

- [ ] **Step 3: Run the server test suite**

Run: `npm run test -w @kairo/server`
Expected: PASS (including the new case; the earlier `saveProfile` typecheck error is now resolved).

- [ ] **Step 4: Commit**

```bash
git add server/src/onboarding/service.ts server/src/onboarding/routes.ts server/tests/onboarding.test.ts
git commit -m "feat(onboarding): persist chosen accent color on save

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `/v1/me` returns the Google account name

**Files:**
- Modify: `server/src/usage/service.ts:98-121`
- Modify: `server/src/usage/routes.ts:14-26`

- [ ] **Step 1: Select `u.name` in `readMe`**

In `server/src/usage/service.ts`, add `name` to the `MeRow` interface and the query:

```ts
export interface MeRow {
  email: string;
  name: string;
  plan: 'free' | 'pro';
  used_free: number;
  free_limit: number;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  onboarding_completed_at: string | null;
  display_name: string | null;
}

export async function readMe(userId: string): Promise<MeRow | undefined> {
  const r = await db.execute(sql`
    SELECT u.email, u.name, uc.plan, uc.used_free, uc.free_limit,
           s.status, s.current_period_end, s.cancel_at_period_end,
           p.onboarding_completed_at, p.display_name
    FROM usage_counter uc
    JOIN "user" u ON u.id = uc.user_id
    LEFT JOIN subscription s ON s.user_id = uc.user_id
    LEFT JOIN profile p ON p.user_id = uc.user_id
    WHERE uc.user_id = ${userId}`);
  return r.rows[0] as unknown as MeRow | undefined;
}
```

- [ ] **Step 2: Expose `account_name` in the `/v1/me` response**

In `server/src/usage/routes.ts`, add the field to the returned object (after `display_name`):

```ts
      onboarded: !!row.onboarding_completed_at,
      display_name: row.display_name ?? null,
      account_name: row.name ?? null,
    };
```

- [ ] **Step 3: Assert `account_name` in the me test**

In `server/tests/me.test.ts`, extend the "returns plan + usage" test:

```ts
    expect(body.user.email).toBe('me@t.dev');
    expect(body.account_name).toBe('Me'); // Better Auth user.name seeded in beforeAll
```

- [ ] **Step 4: Run the server tests**

Run: `npm run test -w @kairo/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/usage/service.ts server/src/usage/routes.ts server/tests/me.test.ts
git commit -m "feat(me): surface the Google account name as account_name

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## GROUP B — Native user-name cache

### Task 6: `set_user_name` / `get_user_name` native commands

The notch + main window read the name at launch from a file cache (mirrors the existing `onboarded` / `onboarding_step` markers in `onboarding.rs`). No network on the hot path.

**Files:**
- Modify: `src-tauri/src/onboarding.rs:16-52`
- Modify: `src-tauri/src/lib.rs:729-731`

- [ ] **Step 1: Add the marker path + two commands to `onboarding.rs`**

In `src-tauri/src/onboarding.rs`, after `onboarding_step_marker` (around line 22), add:

```rust
fn user_name_marker(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("user_name"))
}

/// Cache the user's display name (from their Google profile) so every WebView can read
/// it at launch and inject it into tutor/gate prompts — no per-turn network round-trip.
/// Written after sign-in (onboarding Act 5) and backfilled from `/v1/me` for returning
/// users. An empty name clears the cache.
#[tauri::command]
pub(crate) fn set_user_name(app: tauri::AppHandle, name: String) {
    let Some(path) = user_name_marker(&app) else {
        return;
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&path);
        crate::klog!(app, info, "user name cache cleared");
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, trimmed.as_bytes());
    crate::klog!(app, info, name_len = trimmed.len(), "user name cached");
}

/// The cached user display name (empty string if none / cleared).
#[tauri::command]
pub(crate) fn get_user_name(app: tauri::AppHandle) -> String {
    user_name_marker(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}
```

- [ ] **Step 2: Register both commands in `lib.rs`**

In `src-tauri/src/lib.rs`, in the `generate_handler!` list, after `onboarding::set_onboarding_ptt,` add:

```rust
            onboarding::set_onboarding_ptt,
            onboarding::set_user_name,
            onboarding::get_user_name,
```

- [ ] **Step 3: Compile-check the Rust crate**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (no warnings about unused commands — they're registered).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/onboarding.rs src-tauri/src/lib.rs
git commit -m "feat(native): file-backed user-name cache (set_user_name/get_user_name)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## GROUP C — Frontend persistence + Act 5-6 UI

### Task 7: Extend `saveOnboarding` with accent + add `getMe`

**Files:**
- Modify: `src/onboarding/backendClient.ts:66-77`

- [ ] **Step 1: Add the accent arg + a typed `/v1/me` fetch**

In `src/onboarding/backendClient.ts`, add the import at the top and replace `saveOnboarding`, adding `getMe`:

```ts
import type { MeResponse } from '@kairo/shared';
import { KAIRO_BACKEND_URL } from './config';
```

```ts
export async function saveOnboarding(
  jwt: string,
  displayName: string,
  source: string,
  accent = '',
): Promise<boolean> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ displayName, source, accent }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch the signed-in user's profile (name/email/usage). Null if signed out / offline. */
export async function getMe(jwt: string): Promise<MeResponse | null> {
  try {
    const res = await fetch(`${KAIRO_BACKEND_URL}/v1/me`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}
```

> The existing `finish()` caller in `OnboardingFlow.tsx` calls `saveOnboarding(jwt, name, source)` with 3 args — `accent` defaults to `''`, so it still compiles. Task 11 updates the live caller to pass the real accent.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/onboarding/backendClient.ts
git commit -m "feat(onboarding): saveOnboarding takes accent; add getMe(/v1/me)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Native-bridge wrappers for the name cache

**Files:**
- Modify: `src/native/nativeBridge.ts:130-193` (type) and the concrete bridge (~line 500-535)

- [ ] **Step 1: Add the two methods to the `NativeBridge` type**

In `src/native/nativeBridge.ts`, in the `NativeBridge` type (near `hideNotch()`), add:

```ts
  hideNotch(): Promise<void>;
  // The cached user display name ('' when unknown). Read at launch to inject into prompts.
  getUserName(): Promise<string>;
  // Cache the user display name (persisted natively; '' clears it).
  setUserName(name: string): Promise<void>;
```

- [ ] **Step 2: Implement them in the concrete (native) bridge**

In the object returned by `createNativeBridge` (near `async runGateTurn(...)`), add:

```ts
    async getUserName() {
      try {
        return await invoke<string>('get_user_name');
      } catch {
        return '';
      }
    },
    async setUserName(name) {
      await invoke('set_user_name', { name });
    },
```

- [ ] **Step 3: Add browser-fallback stubs**

Find the fallback bridge (the branch used when `!hasNativeBridge` / web preview — it mirrors every method) and add:

```ts
    async getUserName() {
      return '';
    },
    async setUserName() {},
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both bridge implementations satisfy `NativeBridge`).

- [ ] **Step 5: Commit**

```bash
git add src/native/nativeBridge.ts
git commit -m "feat(native-bridge): getUserName/setUserName wrappers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `syncUserName` helper (fetch `/v1/me` → cache)

Single source of truth for "pull the name from the account into the native cache," reused by Act 5 and the App.tsx backfill.

**Files:**
- Create: `src/onboarding/userName.ts`
- Test: `tests/userName.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/userName.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { pickUserName } from '../src/onboarding/userName';

describe('pickUserName', () => {
  test('prefers display_name, falls back to account_name, then empty', () => {
    expect(pickUserName({ display_name: 'Prasad', account_name: 'P. Kumar' } as any)).toBe('Prasad');
    expect(pickUserName({ display_name: null, account_name: 'P. Kumar' } as any)).toBe('P. Kumar');
    expect(pickUserName({ display_name: '', account_name: '' } as any)).toBe('');
    expect(pickUserName(null)).toBe('');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- userName`
Expected: FAIL ("Cannot find module '../src/onboarding/userName'").

- [ ] **Step 3: Implement `userName.ts`**

Create `src/onboarding/userName.ts`:

```ts
import type { MeResponse } from '@kairo/shared';
import { klog } from '../core/logger';
import { getBackendJwt } from './authClient';
import { getMe } from './backendClient';
import { createNativeBridge } from '../native/nativeBridge';

/** The name to show/use: the onboarding display name, else the Google account name, else ''. */
export function pickUserName(me: Pick<MeResponse, 'display_name' | 'account_name'> | null): string {
  if (!me) return '';
  return (me.display_name || me.account_name || '').trim();
}

/**
 * Pull the signed-in user's name from `/v1/me` and cache it natively so the notch reads it
 * at launch. No-op when signed out. Returns the resolved name (may be '').
 */
export async function syncUserName(): Promise<string> {
  const jwt = await getBackendJwt();
  if (!jwt) return '';
  const me = await getMe(jwt);
  const name = pickUserName(me);
  await createNativeBridge().setUserName(name);
  klog('onboarding', 'info', 'synced user name from /v1/me', { name_len: name.length });
  return name;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -- userName`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/userName.ts tests/userName.test.ts
git commit -m "feat(onboarding): syncUserName helper (/v1/me name -> native cache)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Act 5-6 copy segments

**Files:**
- Modify: `src/onboarding/copy.ts`

- [ ] **Step 1: Add the Act 5-6 spoken lines + cache keys**

In `src/onboarding/copy.ts`, add these exported segment arrays (used by the Act 5-6 components; the static lines get pre-generated audio via `CACHED_LINES`):

```ts
/** Act 5a — sign in (temp panel). Static line, cached. */
export const ACT5_SIGNIN: Segment[] = [
  { cacheKey: 'act5_signin', text: () => "Almost done — let's save your setup. Sign in with Google." },
];

/** Spoken once the Google name is known (dynamic — synthesized live). */
export const act5Greeting = (name: string): Segment[] =>
  name ? [{ text: () => `Nice to meet you, ${name}.` }] : [];

/** Act 5b — source chips. Static line, cached. */
export const ACT5_SOURCE: Segment[] = [
  { cacheKey: 'act5_source', text: () => "Last thing — where'd you hear about me?" },
];

/** Act 6 — warm ending. First line personalized (live), second cached. */
export const act6Ending = (name: string): Segment[] => [
  { text: () => (name ? `You're all set, ${name}.` : "You're all set.") },
  { cacheKey: 'act6_ending', text: () => "Hold Option and Control any time — I'll be right here." },
];
```

- [ ] **Step 2: Ensure the new static lines are in `CACHED_LINES`**

`CACHED_LINES` is derived from `STEPS.speech` + `PERMISSION_LINES`. The Act 5-6 segments above are NOT in `STEPS`, so add them explicitly. Update the `CACHED_LINES` export:

```ts
export const CACHED_LINES: { key: string; text: string }[] = [
  ...STEPS.flatMap((s) => s.speech)
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
  ...Object.entries(PERMISSION_LINES).map(([key, text]) => ({ key, text })),
  // Act 5-6 lines (spoken outside the STEPS wizard):
  ...[...ACT5_SIGNIN, ...ACT5_SOURCE, ...act6Ending('')]
    .filter((seg) => seg.cacheKey)
    .map((seg) => ({ key: seg.cacheKey as string, text: seg.text('') })),
];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/onboarding/copy.ts
git commit -m "feat(onboarding): Act 5-6 copy (sign-in, source, warm ending)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Act 5 temp-panel components (sign-in + source)

Two small presentational components rendered in the orchestrator's temp-panel slot. They reuse existing CSS classes (`ob-cta`, `ob-chips`, `ob-chip`, `ob-signed`, `ob-check`) already in `onboarding.css`.

**Files:**
- Create: `src/onboarding/acts/Act5SignIn.tsx`
- Create: `src/onboarding/acts/Act5Source.tsx`

- [ ] **Step 1: Build the sign-in panel**

Create `src/onboarding/acts/Act5SignIn.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { klog } from '../../core/logger';
import { getAuthStatus, onAuthChanged, startGoogleAuth } from '../authClient';
import { syncUserName } from '../userName';

/**
 * Act 5a — sign in. The Google button opens the system browser; on the deep-link return the
 * orchestrator's window regains focus (already built). Once signed in we pull the user's name
 * from `/v1/me` (Google profile → account) and cache it, then hand it back via `onSignedIn`.
 */
export function Act5SignIn({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let un = () => {};
    void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    void onAuthChanged((s) => s && setSignedIn(true)).then((u) => {
      un = u;
    });
    // Belt-and-suspenders: re-check when the window regains focus (tab back from browser).
    const recheck = () => void getAuthStatus().then((s) => s.signed_in && setSignedIn(true));
    window.addEventListener('focus', recheck);
    return () => {
      un();
      window.removeEventListener('focus', recheck);
    };
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void syncUserName().then((name) => {
      klog('onboarding', 'info', 'act5 signed in', { name_len: name.length });
      onSignedIn(name);
    });
  }, [signedIn, onSignedIn]);

  if (signedIn) {
    return (
      <div className="ob-signed">
        <span className="ob-check">✓</span> signed in
      </div>
    );
  }
  return (
    <button type="button" className="ob-cta" onClick={() => void startGoogleAuth()}>
      Continue with Google
    </button>
  );
}

// ONBOARDING_SOURCES is re-exported here for co-located discovery by Act5Source.
export { ONBOARDING_SOURCES };
```

- [ ] **Step 2: Build the source panel**

Create `src/onboarding/acts/Act5Source.tsx`:

```tsx
import { useState } from 'react';
import { ONBOARDING_SOURCES } from '@kairo/shared';

/** Act 5b — "where'd you hear about me?" one-tap chip row (+ free-text "Other"). */
export function Act5Source({ onPick }: { onPick: (source: string) => void }) {
  const [other, setOther] = useState('');
  return (
    <div className="ob-field-col">
      <div className="ob-chips">
        {ONBOARDING_SOURCES.map((s) =>
          s === 'Other' ? null : (
            <button key={s} type="button" className="ob-chip" onClick={() => onPick(s)}>
              {s}
            </button>
          ),
        )}
      </div>
      <div className="ob-chips">
        <input
          className="ob-chip"
          value={other}
          placeholder="somewhere else…"
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && other.trim() && onPick(other.trim())}
        />
        <button type="button" className="ob-cta" disabled={!other.trim()} onClick={() => onPick(other.trim())}>
          Done
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/onboarding/acts/Act5SignIn.tsx src/onboarding/acts/Act5Source.tsx
git commit -m "feat(onboarding): Act 5 sign-in + source temp-panel components

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Wire Acts 5-6 into the orchestrator (persist + finish)

Mount the Act 5 components in the orchestrator's temp-panel slot, run Act 6 as a coach caption, and persist name + accent + source before `finish_onboarding`.

**Files:**
- Modify: the Phase 3 onboarding orchestrator (`src/onboarding/OnboardingFlow.tsx` or its successor) — the act sequencer + temp-panel render.

> The exact orchestrator symbols come from Phase 3. Use whatever "advance to next act" and "render temp panel" mechanism it exposes. The concrete behavior to implement:

- [ ] **Step 1: Hold the collected answers in orchestrator state**

Add state near the other orchestrator hooks:

```tsx
const [obName, setObName] = useState('');
const [obSource, setObSource] = useState('');
```

- [ ] **Step 2: Render Act 5a in the temp-panel slot**

When the current act is Act 5a, speak `ACT5_SIGNIN` (via the existing `voice.speak`) and render:

```tsx
<Act5SignIn
  onSignedIn={(name) => {
    setObName(name);
    void voice.speak(act5Greeting(name), name); // "Nice to meet you, {name}."
    advanceAct(); // → Act 5b (use the orchestrator's real advance fn)
  }}
/>
```

Import at the top: `import { Act5SignIn } from './acts/Act5SignIn';` and `import { Act5Source } from './acts/Act5Source';` and `import { ACT5_SIGNIN, ACT5_SOURCE, act5Greeting, act6Ending } from './copy';`.

- [ ] **Step 3: Render Act 5b in the temp-panel slot**

When the current act is Act 5b, speak `ACT5_SOURCE` and render:

```tsx
<Act5Source
  onPick={(source) => {
    setObSource(source);
    advanceAct(); // → Act 6
  }}
/>
```

- [ ] **Step 4: Act 6 — warm ending + persist + finish**

When Act 6 begins, speak the personalized ending, persist everything, cache the name, and finish. Add this effect (fires once on entering Act 6):

```tsx
useEffect(() => {
  if (currentAct !== 'act6') return; // match the orchestrator's act id
  let cancelled = false;
  const run = async () => {
    // Push the ending caption to the real notch + speak it.
    await nativeBridge.showNotch({ state: 'coach', layout: null, title: "You're all set", detail: '' });
    void voice.speak(act6Ending(obName), obName);

    // Persist name + accent + source to the account; cache the name natively for the notch.
    const jwt = await getBackendJwt();
    const accent = await getAccent(); // Phase 0: src/core/accent.ts
    if (jwt) {
      const ok = await saveOnboarding(jwt, obName || 'there', obSource || 'unknown', accent);
      klog('onboarding', 'info', 'onboarding saved', { ok, name_len: obName.length, accent });
    }
    await nativeBridge.setUserName(obName);

    // Let the sign-off finish, then drop the app to the background (product goes live).
    await new Promise((r) => setTimeout(r, 2600));
    if (cancelled) return;
    onComplete(); // OnboardingApp.onComplete → invoke('finish_onboarding')
  };
  void run();
  return () => {
    cancelled = true;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [currentAct]);
```

Add imports: `import { getBackendJwt } from './authClient';`, `import { saveOnboarding } from './backendClient';`, `import { getAccent } from '../core/accent';`.

> `finish_onboarding` (native) already clears the resume marker + PTT ownership and drops to Accessory; it does NOT clear the `user_name` cache (Task 6), so the name survives into the live product.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Rebuild + run the packaged app, walk Acts 5-6**

Run:
```bash
osascript -e 'tell application "Kairo Tutor" to quit'; npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
Then in another terminal: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`
Expected in the log during Act 5-6: `synced user name from /v1/me`, `user name cached name_len=…`, `onboarding saved ok=true …`, then `onboarding finished`. The ending caption speaks "You're all set, {name}." and the pet retreats naturally toward the notch (no special graduation — the product's normal post-turn retreat).

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/OnboardingFlow.tsx
git commit -m "feat(onboarding): wire Acts 5-6 — sign-in, source, warm ending + persist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Regenerate the cached onboarding audio

**Files:**
- Run: `scripts/gen-onboarding-audio.ts` (reads `CACHED_LINES`)

- [ ] **Step 1: Generate audio for the new Act 5-6 cache keys**

Run: `npx tsx scripts/gen-onboarding-audio.ts`
Expected: new audio files for `act5_signin`, `act5_source`, `act6_ending` land alongside the existing cached lines. (Requires the backend running / Sarvam key — see the script header.)

- [ ] **Step 2: Commit the generated audio**

```bash
git add src/onboarding/audio 2>/dev/null || git add -A
git commit -m "chore(onboarding): pre-generate Act 5-6 cached audio

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## GROUP D — Finalize Name-in-Prompt (§12)

### Task 14: Add `user_name` to the Rust turn inputs

**Files:**
- Modify: `src-tauri/src/types.rs:191-211` (`TutorTurnInput`) and `:270-287` (`GateInput`)

- [ ] **Step 1: Add the field to `TutorTurnInput`**

In `src-tauri/src/types.rs`, add to `TutorTurnInput` (after `spoken_intro`):

```rust
    #[serde(default)]
    pub(crate) spoken_intro: Option<String>,
    // The user's display name (from their account). Injected in the NON-cached user
    // prompt section only (never the cached system prefix). Absent when signed out.
    #[serde(default)]
    pub(crate) user_name: Option<String>,
}
```

- [ ] **Step 2: Add the field to `GateInput`**

In the same file, add to `GateInput` (after `pointer_pending`):

```rust
    #[serde(default)]
    pub(crate) pointer_pending: bool,
    // The user's display name; appended to the non-cached gate user message. Absent when signed out.
    #[serde(default)]
    pub(crate) user_name: Option<String>,
}
```

- [ ] **Step 3: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (both are `#[serde(default)]`, so existing callers still deserialize).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/types.rs
git commit -m "feat(prompts): add user_name to TutorTurnInput + GateInput

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: `prompts.rs` owns the name line

**Files:**
- Modify: `src-tauri/src/prompts.rs`

- [ ] **Step 1: Write a failing Rust unit test for the helper**

At the bottom of `src-tauri/src/prompts.rs`, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_name_line_formats_the_sentence() {
        assert_eq!(user_name_line("Prasad"), "The user's name is Prasad.");
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml user_name_line_formats_the_sentence`
Expected: FAIL ("cannot find function `user_name_line`").

- [ ] **Step 3: Implement the helper**

Near the top of `src-tauri/src/prompts.rs` (after the `use` line), add:

```rust
/// The single line that teaches the model the user's name. Injected into the NON-cached
/// per-turn user section (never the cached system prefix), so it can't bust prompt caching.
pub(crate) fn user_name_line(name: &str) -> String {
    format!("The user's name is {}.", name.trim())
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml user_name_line_formats_the_sentence`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/prompts.rs
git commit -m "feat(prompts): user_name_line helper (non-cached name sentence)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Inject the name into the non-cached user content + log it

The system prompts (`build_tutor_system_prompt`, `gate_system_prompt`) — the **cached prefix** — are untouched. The name goes only into the per-turn **user** message.

**Files:**
- Modify: `src-tauri/src/tutor.rs:24-54` (`build_tutor_user_prompt`) and `:661-675` (`run_gate_turn` user message)

- [ ] **Step 1: Inject into the tutor user prompt JSON**

In `build_tutor_user_prompt` (`src-tauri/src/tutor.rs`), after the `spoken_intro` insertion block (around line 51, before `serde_json::to_string_pretty`), add:

```rust
    // The user's name (account) — non-cached per-turn user content only.
    if let Some(name) = input.user_name.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Some(object) = context.as_object_mut() {
            object.insert(
                "userContext".to_string(),
                json!(crate::prompts::user_name_line(name)),
            );
        }
        crate::klog!(tutor, debug, name_len = name.trim().len(), "user name injected into non-cached user prompt");
    }
```

- [ ] **Step 2: Append the name line to the gate user message**

In `run_gate_turn` (`src-tauri/src/tutor.rs`), just before the `let user_message = format!(...)` (around line 661), add the name line and include it in the message:

```rust
    let name_line = match input.user_name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => format!("\n{}", crate::prompts::user_name_line(n)),
        _ => String::new(),
    };
    let user_message = format!(
        "Active app: {app}\nWindow title: {title}{history_line}{pointer_line}{name_line}\nUser question (spoken): \"{}\"",
        input.user_query
    );
    if !name_line.is_empty() {
        crate::klog!(gate, debug, "user name injected into non-cached gate message");
    }
```

- [ ] **Step 3: Compile-check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tutor.rs
git commit -m "feat(prompts): inject user name into non-cached tutor + gate user content

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Thread `userName` through the frontend tutor path

**Files:**
- Modify: `src/core/orchestrator.ts:14-72` (`TutorTurnInput` + `buildTutorTurnInput`)
- Modify: `src/notch/notchTutor.ts:17-104` (`AskTutorFromNotchOptions` + pass-through)
- Test: `tests/orchestrator.test.ts`

- [ ] **Step 1: Write a failing test for the orchestrator threading**

In `tests/orchestrator.test.ts`, add a case inside `describe('tutor orchestrator', …)`:

```ts
  test('threads userName into the built input when provided', () => {
    const input = buildTutorTurnInput({
      request,
      screenCapture: null,
      skillSlug: '',
      userName: 'Prasad',
    });
    expect(input.userName).toBe('Prasad');
  });

  test('omits userName when not provided', () => {
    const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: '' });
    expect(input.userName).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- orchestrator`
Expected: FAIL (`userName` is not on the input / not accepted by `buildTutorTurnInput`).

- [ ] **Step 3: Add `userName` to the orchestrator types + builder**

In `src/core/orchestrator.ts`, add `userName?` to `TutorTurnInput`:

```ts
export type TutorTurnInput = {
  userQuery: string;
  activeApp: ActiveAppContext;
  annotations: UserAnnotation[];
  screen: TutorScreenInput;
  skillSlug: string;
  constraints: string[];
  recentContext?: string;
  spokenIntro?: string;
  // The user's display name (account). Injected into the non-cached prompt section by Rust.
  userName?: string;
};
```

Add it to `buildTutorTurnInput`'s params + output:

```ts
export function buildTutorTurnInput({
  request,
  screenCapture,
  skillSlug,
  recentContext,
  spokenIntro,
  userName,
}: {
  request: TutorRequest;
  screenCapture: NativeScreenCapture | null;
  skillSlug: string;
  recentContext?: string;
  spokenIntro?: string;
  userName?: string;
}): TutorTurnInput {
  return {
    // …unchanged fields…
    ...(recentContext && recentContext.trim() ? { recentContext } : {}),
    ...(spokenIntro && spokenIntro.trim() ? { spokenIntro } : {}),
    ...(userName && userName.trim() ? { userName } : {}),
  };
}
```

And add `userName?: string;` to `runTextTurn`'s args (in `createTutorOrchestrator`):

```ts
    runTextTurn(args: {
      request: TutorRequest;
      screenCapture: NativeScreenCapture | null;
      skillSlug: string;
      recentContext?: string;
      spokenIntro?: string;
      userName?: string;
    }) {
      return planner(buildTutorTurnInput(args));
    }
```

- [ ] **Step 4: Pass `userName` through `askTutorFromNotch`**

In `src/notch/notchTutor.ts`, add to `AskTutorFromNotchOptions`:

```ts
  // The line the gate already spoke aloud this turn — the tutor continues from it.
  spokenIntro?: string;
  // The user's display name (account); injected into the non-cached prompt section.
  userName?: string;
};
```

Destructure it in `askTutorFromNotch({ …, spokenIntro, userName })` and pass it into `orchestrator.runTextTurn`:

```ts
    const response = await orchestrator.runTextTurn({
      request: { /* …unchanged… */ },
      screenCapture,
      skillSlug,
      recentContext,
      spokenIntro,
      userName,
    });
```

- [ ] **Step 5: Run the orchestrator test to confirm it passes**

Run: `npm run test -- orchestrator`
Expected: PASS.

- [ ] **Step 6: Typecheck + full test run**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/orchestrator.ts src/notch/notchTutor.ts tests/orchestrator.test.ts
git commit -m "feat(notch): thread userName through the tutor turn path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: NotchApp reads the cached name + passes it into every turn

**Files:**
- Modify: `src/native/nativeBridge.ts:118-128` (`NativeGateInput`)
- Modify: `src/notch/NotchApp.tsx` (a name ref + mount read + the `runGate` and tutor-ask call sites)

- [ ] **Step 1: Add `userName` to `NativeGateInput`**

In `src/native/nativeBridge.ts`, add to the `NativeGateInput` type (after `pointerPending?`):

```ts
  // True when a guide pointer is on screen waiting for a click (biases needsScreen).
  pointerPending?: boolean;
  // The user's display name (account); injected into the non-cached gate user message.
  userName?: string;
};
```

- [ ] **Step 2: Add a name ref + read it on mount (and on sign-in) in NotchApp**

In `src/notch/NotchApp.tsx`, near the other refs (after `const nativeBridge = useMemo(...)`), add:

```tsx
const userNameRef = useRef('');
```

Add a mount effect that seeds the ref from the native cache and refreshes it if auth changes:

```tsx
// The user's name (from onboarding / their Google account) is cached natively; read it at
// launch so every tutor/gate turn can pass it into the non-cached prompt section. Also
// re-read when auth changes (a fresh sign-in during a live session).
useEffect(() => {
  const load = () =>
    void nativeBridge.getUserName().then((n) => {
      if (n) userNameRef.current = n;
      klog('notch', 'info', 'user name loaded', { name_len: n.length });
    });
  load();
  let un = () => {};
  void listen('auth:changed', load).then((u) => {
    un = u;
  });
  return () => un();
}, [nativeBridge]);
```

- [ ] **Step 3: Pass `userName` into the gate call**

In `runGate` (around line 508), add `userName` to the `runGateTurn` payload:

```tsx
        const raw = await nativeBridge.runGateTurn({
          userQuery: query,
          activeApp: active?.activeApp,
          bundleId: active?.bundleId ?? undefined,
          windowTitle: active?.windowTitle ?? undefined,
          history: buildGateHistory(),
          pointerPending,
          userName: userNameRef.current || undefined,
        });
```

- [ ] **Step 4: Pass `userName` into the tutor ask**

Find the `askTutorFromNotch({ … })` call in `submitQuery` (the tutor ask that follows the gate) and add `userName`:

```tsx
        userName: userNameRef.current || undefined,
```

(Add it alongside the existing options such as `query`, `nativeBridge`, `aiProvider`, `skillSlug`, `screenCapture`, `recentContext`, `spokenIntro`.)

- [ ] **Step 5: Typecheck + test**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/native/nativeBridge.ts src/notch/NotchApp.tsx
git commit -m "feat(notch): pass cached user name into gate + tutor turns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Backfill the name cache for returning users (App.tsx)

Users who signed in before this feature (or on another device) have a populated account but an empty native cache. Sync it once when the main window is signed in.

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Sync `/v1/me` → cache on sign-in in the main window**

In `src/App.tsx`, add an effect (import `syncUserName` from `./onboarding/userName` and `onAuthChanged`, `getAuthStatus` from `./onboarding/authClient`):

```tsx
// Keep the native user-name cache fresh for the notch: sync from /v1/me when signed in.
useEffect(() => {
  let un = () => {};
  const sync = (signedIn: boolean) => {
    if (signedIn) void syncUserName();
  };
  void getAuthStatus().then((s) => sync(s.signed_in));
  void onAuthChanged(sync).then((u) => {
    un = u;
  });
  return () => un();
}, []);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): backfill native user-name cache from /v1/me on sign-in

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: End-to-end verification — name reaches the prompt, does NOT bust the cache

**Files:** none (verification only).

- [ ] **Step 1: Full local gate (frontend + native + server)**

Run:
```bash
npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml
npm run test -w @kairo/server
```
Expected: all PASS.

- [ ] **Step 2: Build + run the packaged app**

Run:
```bash
osascript -e 'tell application "Kairo Tutor" to quit'; npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

- [ ] **Step 3: Confirm the name reaches the prompt (via logs)**

With `tail -F ~/Library/Logs/Kairo/kairo-latest.log` running, sign in (so the cache is populated), then do a voice ask ("where's the wifi icon?").
Expected log lines:
- `user name loaded name_len=…` (NotchApp mount).
- On a voice turn: `user name injected into non-cached gate message` (gate) and, on the vision turn, `user name injected into non-cached user prompt name_len=…` (tutor).

- [ ] **Step 4: Confirm the cached prefix is NOT busted (code + log reasoning)**

Verify by inspection that the name appears ONLY in the per-turn **user** content and never in the system prompt:
- `gate_system_prompt` / `build_tutor_system_prompt` take no name argument (grep to confirm):

Run: `grep -n "user_name\|user_name_line" src-tauri/src/prompts.rs`
Expected: `user_name_line` is defined, but NEITHER `gate_system_prompt` nor `build_tutor_system_prompt` references it — proving the cached system prefix is byte-identical regardless of the name. The name lives only in `build_tutor_user_prompt` (user JSON) and `run_gate_turn`'s `user_message` (both non-cached, per-turn).

- [ ] **Step 5: Confirm signed-out behavior is clean**

Sign out, do a voice ask.
Expected: no "user name injected" log lines, `userName` is `undefined`, turns behave exactly as before (empty/optional name never adds a line).

- [ ] **Step 6: Final commit (if any verification tweaks were needed)**

```bash
git add -A
git commit -m "test(prompts): verify user name reaches non-cached prompt only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (task scope):**
- Act 5a — Sign in (temp panel + Google button + pull name/email from Google profile + persist name + accent): Tasks 1-5 (backend), 7-9 (frontend save + name sync), 11 (`Act5SignIn`), 12 (wire + persist). ✅
- Act 5b — Source chips (`ONBOARDING_SOURCES`): Task 11 (`Act5Source`), 12 (persist source). ✅
- Act 6 — Warm name-personalized ending + pet natural retreat + `finish_onboarding`: Tasks 10 (copy), 12 (Act 6 effect → `onComplete` → `finish_onboarding`). ✅
- Persist accent (extend `saveOnboarding` + save route): Tasks 1-4, 7, 12. ✅
- Name-in-prompt §12 (frontend reads name from `/v1/me` or cache → `userName` into every gate/tutor turn; `prompts.rs` appends the line in the non-cached section; verify via logs, no cache bust): Tasks 5, 8-9, 14-20. ✅

**2. Placeholder scan:** No "TBD"/"add appropriate handling"/etc. Every code step shows real code. The only intentional adaptation note is the Phase 3 orchestrator seam in Task 12 (`advanceAct`/`currentAct`), which is unavoidable given the hard dependency on Phase 3 — the behavior and every call it makes (`voice.speak`, `saveOnboarding`, `getAccent`, `nativeBridge.setUserName`, `showNotch({state:'coach'})`, `onComplete`) is concrete.

**3. Type consistency:**
- `saveOnboarding(jwt, displayName, source, accent = '')` — defined Task 7, called Task 12. ✅
- `MeResponse.account_name` — Task 1; consumed by `pickUserName`/`getMe` Tasks 7, 9. ✅
- `OnboardingBody.accent?` — Task 1; read by the route Task 4; sent by `saveOnboarding` Task 7. ✅
- `set_user_name`/`get_user_name` (native) ↔ `setUserName`/`getUserName` (bridge) — Tasks 6, 8; consumed Tasks 9, 12, 18, 19. ✅
- `user_name` (Rust `TutorTurnInput`/`GateInput`, Task 14) ↔ `userName` (frontend `TutorTurnInput` Task 17, `NativeGateInput` Task 18, `AskTutorFromNotchOptions` Task 17) — serde camelCase maps `userName` → `user_name`. ✅
- `user_name_line` — defined Task 15, used Tasks 16, 20. ✅
- `syncUserName`/`pickUserName` — defined Task 9, used Tasks 11, 19. ✅

**4. Ordering / runnable-at-each-step:** Group A (backend+shared) is self-contained and testable first. Group B (native) compiles independently. Group C consumes A+B. Group D's Rust plumbing (14-16) is independent of the frontend wiring (17-19); the verification (20) needs all of it. Each task commits and leaves the app buildable.
