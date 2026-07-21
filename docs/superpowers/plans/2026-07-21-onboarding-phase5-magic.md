# Onboarding Phase 5 — The Magic (Act 4: Point + Circle on the real screen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn onboarding Act 4 into the peak of the flow — the pet flies across the user's REAL desktop and points (Act 4a), then describes anything they circle (Act 4b) — and make those demo turns run PRE-sign-in without ever hitting the backend paywall or auth wall.

**Architecture:** The point/circle practice already runs the real pipeline through `demoController.ts`. The Rust turn commands (`transcribe_audio`, `run_gate_turn`, `run_tutor_turn`, `synthesize_speech_stream`) proxy through the authed, credit-metered Fastify backend (`proxy.rs::authed_post` → JWT → `NoAuth` when signed out). Because Act 4 happens BEFORE sign-in (Act 5), those calls would fail with `NoAuth` (proxy on / prod) — so the centerpiece of this phase is an **exemption**: when an onboarding practice turn owns push-to-talk (`ONBOARDING_PTT` is set), the Rust proxy transparently reroutes to a new family of **unauthenticated, unmetered, IP-rate-limited** `/v1/onboarding/*` sibling routes. On top of that, we add the peak celebration (`cursor:celebrate` + the `arrive` sound), seeded-prompt rotation with always-present targets, and retry-on-empty.

**Tech Stack:** Rust (Tauri commands + `reqwest` proxy client), TypeScript/React (onboarding + demo controller), Fastify (Node) backend routes, Vitest (frontend + server tests), `klog!`/`klog()` structured logging (mandatory — never `println!`/`console.*`).

---

## Background — the exact paywall/auth path (read before Task 1 & 2)

This is why the exemption is the highest-risk item. Verified against the current code:

- **All product provider routes are authed + credit-gated:** `/v1/stt`, `/v1/tts/stream` (`server/src/proxy/speech.ts`), `/v1/llm/chat`, `/v1/vision/tutor`, `/v1/vision/point` (`server/src/proxy/llm.ts`) all run `preHandler: [requireAuth, requireCredits]`. No JWT ⇒ **401**; out of budget ⇒ **402**.
- **The Rust turn commands proxy through those routes when the backend proxy is on:**
  - `transcribe_audio` → `proxy_post_multipart(app, "/v1/stt", …)` (`src-tauri/src/speech.rs:195`).
  - `run_gate_turn` → `openrouter_text_chat` → `proxy_post_json(app, "/v1/llm/chat", …)` (`src-tauri/src/tutor.rs:561`).
  - `run_tutor_turn` → `vision_tutor` → `proxy_post_json(app, "/v1/vision/tutor", …)` (`src-tauri/src/proxy.rs:186`, called from `src-tauri/src/grounding/vision.rs:33`).
  - `synthesize_speech_stream` → `proxy_stream_request(app, "/v1/tts/stream", …)` (`src-tauri/src/speech.rs:440`).
  - Every one routes through `proxy.rs::authed_post` (`src-tauri/src/proxy.rs:50`), which does `fetch_jwt(app).await.ok_or(ProxyError::NoAuth)?`. **Pre-sign-in ⇒ `NoAuth` ⇒ the turn errors.**
- **`USE_BACKEND_PROXY` compiled default is `false`** (`src-tauri/src/constants.rs`). With the proxy OFF the turns go direct to the vendor (no auth, no paywall) — so the break only appears once the proxy is turned on (prod, `KAIRO_USE_BACKEND_PROXY=1`). We must fix it for the proxy-ON case.
- **The notch paywall (`upgrade.wav`) never fires during onboarding:** onboarding presses set `ONBOARDING_PTT` and the captured WAV is emitted on `onboarding:audio` (not `ptt:audio`), so `NotchApp.tsx::processCapturedAudio` (and its `checkPaywalled` guard at `src/notch/NotchApp.tsx:1180`) never runs. We keep it that way and assert it in Task 3.
- **`ONBOARDING_PTT` is a Rust `AtomicBool`** (`src-tauri/src/input.rs:37`), set true on a demo-step mount and false on unmount (`OnboardingFlow.tsx:276/322`). It stays true for the whole turn (STT → gate → vision → TTS all run before auto-advance), so it is the reliable gate for rerouting.

**Exemption design (chosen):** add unauthenticated `/v1/onboarding/{gate,vision,tts/stream}` routes (mirroring the product ones minus auth/metering, IP-rate-limited — tight on the expensive vision call), extend the existing `/v1/onboarding/stt` to forward the STT config fields, and in `proxy.rs` reroute to those siblings (no JWT) whenever `onboarding_active()`. This is server-authoritative (the onboarding routes are uncredited by construction and IP-bounded), needs **zero** change to `tutor.rs`/`speech.rs`/`vision.rs` call sites (one central `proxy_post_builder`), and works whether the proxy is on or off.

**Why not a client `onboarding:true` flag on the metered route:** the server deliberately decides onboarding server-side (`isOnboarding`) so a modified client can't dodge metering (`server/src/proxy/llm.ts:36-38`). A client flag would reopen that hole and still wouldn't solve the pre-sign-in `NoAuth`. The dedicated unauthenticated sibling routes solve both.

---

## File Structure

**Create:**
- `server/tests/onboarding-proxy.test.ts` — asserts the new onboarding proxy routes need no auth and are IP-rate-limited.
- `tests/seededPrompts.test.ts` — unit test for `pickSeededPrompt` rotation.

**Modify:**
- `server/src/onboarding/routes.ts` — add `/v1/onboarding/gate`, `/v1/onboarding/vision`, `/v1/onboarding/tts/stream`; extend `/v1/onboarding/stt` to forward `model`/`mode`/`language_code`.
- `src-tauri/src/proxy.rs` — add `onboarding_active()`, `onboarding_sibling()`, `proxy_post_builder()`; route the three proxy fns through it; skip the paywall check in `check_paywalled` when onboarding.
- `src-tauri/src/tutor.rs` — skip the gate's parallel `over_free_limit` quota check when onboarding.
- `src/onboarding/demoController.ts` — fire the peak beat (`cursor:celebrate` + `arrive`) on the point landing; return a `DemoResult` status from all three turns (retry-on-empty / no-target).
- `src/onboarding/copy.ts` — add `SEEDED_PROMPTS` + `pickSeededPrompt`; update the `learn_point` spoken line to an always-present target.
- `src/onboarding/OnboardingFlow.tsx` — consume `DemoResult` (retry vs advance), render the rotating seeded chip for all demo modes, add the retry caption.
- `src/onboarding/audio/learn_point.wav` — regenerated (new `learn_point` line).

**Read-only dependencies (already exist — do NOT modify here):**
- `cursor:celebrate` cursor beat — delivered by Phase 2 (`src/cursor/useCursorEngine.ts`). This phase only emits it.
- `playSound('arrive')` (`src/core/sound.ts`) — the `arrive` cue is already defined; we just call it.
- `GestureLayer.tsx` circle trail via `onboarding:ptt` — already wired.

---

## Task 1: Server — unauthenticated onboarding proxy routes

**Files:**
- Modify: `server/src/onboarding/routes.ts`
- Test: `server/tests/onboarding-proxy.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/tests/onboarding-proxy.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock the provider forwarder + streamer so no real upstream call happens.
vi.mock('../src/proxy/forward', () => ({
  forwardJson: vi.fn(async () => ({ status: 200, json: { ok: true } })),
}));
vi.mock('../src/proxy/stream', () => ({
  streamPassthrough: vi.fn(async (_p: string, _path: string, _body: unknown, reply: any) => {
    reply.send({ ok: true });
  }),
}));

import { buildApp } from '../src/app';
import { pool } from '../src/db/client';

const app = await buildApp();

beforeAll(async () => {
  await app.listen({ port: 8788, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('onboarding proxy routes are exempt (no auth, no credits)', () => {
  it('/v1/onboarding/gate needs no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/gate', payload: { messages: [] } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('/v1/onboarding/tts/stream needs no auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/tts/stream', payload: { text: 'hi' } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('/v1/onboarding/vision needs no auth and is IP-rate-limited (never metered)', async () => {
    // All CAP calls succeed without a JWT (proves no auth + no credit gate)...
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/v1/onboarding/vision', payload: {} });
      expect(res.statusCode).toBe(200);
    }
    // ...and the next one is rate-limited (bounds abuse of the expensive vision call).
    const over = await app.inject({ method: 'POST', url: '/v1/onboarding/vision', payload: {} });
    expect(over.statusCode).toBe(429);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @kairo/server -- onboarding-proxy`
Expected: FAIL — the three routes 404 (not yet defined), so the status assertions fail.

- [ ] **Step 3: Add the routes**

In `server/src/onboarding/routes.ts`, add the streamer import at the top (next to the existing imports):

```ts
import { streamPassthrough } from '../proxy/stream';
```

Add a small local helper above `export async function onboardingRoutes` (mirrors `stripMeta` in `proxy/llm.ts` — kept local so we never touch the metered route):

```ts
/** Drop the `_provider` routing hint before forwarding to the vision provider. */
function dropProviderHint(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const clone = { ...(body as Record<string, unknown>) };
    delete clone._provider;
    return clone;
  }
  return body;
}
```

Then, inside `onboardingRoutes(app)`, add these three routes (place them after the existing `/v1/onboarding/stt` handler, before the closing `}`):

```ts
  // Onboarding "point" GATE — the unauthenticated, unmetered sibling of /v1/llm/chat. The demo
  // point turn runs PRE-sign-in, so it can't use the authed gate route. IP-rate-limited.
  app.post('/v1/onboarding/gate', async (req, reply) => {
    if (!rateLimit(`obgate:${req.ip}`, 40, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    const { json } = await forwardJson('openrouter', '/chat/completions', req.body);
    return json;
  });

  // Onboarding VISION (answer + box) — the unauthenticated, unmetered sibling of /v1/vision/tutor.
  // Vision is the expensive call, so this gets a TIGHT per-IP budget (the demo makes ~1-2 calls;
  // headroom left for retries). Provider routing mirrors the metered route.
  app.post('/v1/onboarding/vision', async (req, reply) => {
    if (!rateLimit(`obvis:${req.ip}`, 12, 10 * 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    const provider = (req.body as { _provider?: string })?._provider === 'anthropic' ? 'anthropic' : 'openai';
    const path = provider === 'anthropic' ? '/v1/messages' : '/v1/responses';
    const { json } = await forwardJson(provider, path, dropProviderHint(req.body));
    return json;
  });

  // Onboarding streaming TTS — the unauthenticated sibling of /v1/tts/stream (demo voice replies).
  app.post('/v1/onboarding/tts/stream', async (req, reply) => {
    if (!rateLimit(`obtts:${req.ip}`, 60, 60_000)) return reply.status(429).send({ error: 'rate_limited', code: 'bad_request' });
    await streamPassthrough('sarvam', '/text-to-speech/stream', req.body, reply);
  });
```

- [ ] **Step 4: Extend the existing STT route to forward Sarvam config fields**

The demo point/circle STT (`transcribe_audio`) sends `model`/`mode`/`language_code` form fields; the current `/v1/onboarding/stt` only forwards the file. In `server/src/onboarding/routes.ts`, in the `/v1/onboarding/stt` handler, right after `form.append('file', new Blob([buf]), mp.filename || 'audio.wav');`, add (mirrors `/v1/stt` in `proxy/speech.ts`):

```ts
    const fields = mp.fields as Record<string, { value?: string } | undefined> | undefined;
    for (const key of ['model', 'mode', 'language_code'] as const) {
      const value = fields?.[key]?.value;
      if (value) form.append(key, value);
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @kairo/server -- onboarding-proxy`
Expected: PASS (3 tests green).

- [ ] **Step 6: Typecheck the server**

Run: `npm run typecheck -w @kairo/server`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/onboarding/routes.ts server/tests/onboarding-proxy.test.ts
git commit -m "feat(onboarding): unauthenticated proxy routes for pre-sign-in demo turns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rust — route demo turns to the onboarding siblings when ONBOARDING_PTT

**Files:**
- Modify: `src-tauri/src/proxy.rs`
- Modify: `src-tauri/src/tutor.rs:681-682`

- [ ] **Step 1: Add the onboarding-aware routing to `proxy.rs`**

At the top of `src-tauri/src/proxy.rs`, add the `Ordering` import next to the existing `use std::time::Duration;`:

```rust
use std::sync::atomic::Ordering;
```

Add these three items just after the `ASK_ID_HEADER` const (around line 18):

```rust
/// True while an onboarding practice turn owns push-to-talk. Onboarding demos run PRE-sign-in
/// (value-first), so their provider calls must NEVER require a JWT or hit the credit meter — they
/// transparently route to the unauthenticated, IP-rate-limited `/v1/onboarding/*` sibling routes.
pub(crate) fn onboarding_active() -> bool {
    crate::input::ONBOARDING_PTT.load(Ordering::SeqCst)
}

/// Map an authed/metered product proxy path to its unauthenticated onboarding sibling.
fn onboarding_sibling(path: &str) -> &'static str {
    match path {
        "/v1/stt" => "/v1/onboarding/stt",
        "/v1/llm/chat" => "/v1/onboarding/gate",
        "/v1/vision/tutor" => "/v1/onboarding/vision",
        "/v1/tts/stream" => "/v1/onboarding/tts/stream",
        _ => path,
    }
}

/// Build the POST for `path`. During an onboarding practice turn, reroute to the unauthenticated
/// onboarding sibling (no JWT, no metering); otherwise a JWT-authed POST (`NoAuth` when signed out).
async fn proxy_post_builder(
    app: &AppHandle,
    path: &str,
    timeout: Duration,
) -> Result<reqwest::RequestBuilder, ProxyError> {
    if onboarding_active() {
        let sibling = onboarding_sibling(path);
        crate::klog!(app, debug, path = sibling, "onboarding turn → unauthenticated proxy route");
        let url = format!("{}{}", constants::KAIRO_BACKEND_URL, sibling);
        return Ok(shared_http_client().post(&url).timeout(timeout));
    }
    authed_post(app, path, timeout).await
}
```

- [ ] **Step 2: Route the three proxy fns through the builder**

In `src-tauri/src/proxy.rs`, change the three call sites:

`proxy_post_json` — replace `let mut request = authed_post(app, path, timeout).await?.json(body);` with:

```rust
    let mut request = proxy_post_builder(app, path, timeout).await?.json(body);
```

`proxy_post_multipart` — replace `authed_post(app, path, timeout)\n        .await?\n        .multipart(form)` with:

```rust
    let response = proxy_post_builder(app, path, timeout)
        .await?
        .multipart(form)
```

`proxy_stream_request` — replace `authed_post(app, path, timeout)\n        .await?\n        .json(body)` with:

```rust
    let response = proxy_post_builder(app, path, timeout)
        .await?
        .json(body)
```

(`vision_tutor` needs no change — it calls `proxy_post_json(app, "/v1/vision/tutor", …)`, which the builder now reroutes to `/v1/onboarding/vision`; the harmless `x-kairo-ask-id` header is ignored by the onboarding route.)

- [ ] **Step 3: Make the notch paywall check a no-op during onboarding (defense-in-depth)**

In `src-tauri/src/proxy.rs`, change `check_paywalled` so it can never report paywalled mid-onboarding:

```rust
#[tauri::command]
pub(crate) async fn check_paywalled(app: tauri::AppHandle) -> bool {
    proxy_enabled() && !onboarding_active() && over_free_limit(&app).await
}
```

- [ ] **Step 4: Skip the gate's parallel quota check when onboarding**

In `src-tauri/src/tutor.rs`, the gate runs `over_free_limit` in parallel (around line 681). Replace:

```rust
    let quota_check =
        async { crate::proxy::proxy_enabled() && crate::proxy::over_free_limit(&app_handle).await };
```

with:

```rust
    // Onboarding demo gate turns run pre-sign-in and are never metered — don't let a stray
    // /v1/me check flip them into the upgrade prompt (it would 401 and fail-open anyway).
    let quota_check = async {
        crate::proxy::proxy_enabled()
            && !crate::proxy::onboarding_active()
            && crate::proxy::over_free_limit(&app_handle).await
    };
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (no warnings about unused `onboarding_sibling`/`onboarding_active`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/proxy.rs src-tauri/src/tutor.rs
git commit -m "feat(onboarding): reroute demo turns to unauthenticated onboarding proxy when ONBOARDING_PTT

Pre-sign-in Act 4 point/circle no longer hit NoAuth/402/metering: proxy_post_builder
transparently maps /v1/stt|llm/chat|vision/tutor|tts/stream to their /v1/onboarding/*
siblings whenever a practice turn owns push-to-talk.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verify the first onboarding turn is NEVER paywalled (highest-risk gate)

This is a runtime verification of the exemption with the backend proxy ON and the user signed OUT — the exact prod-shaped scenario the redesign introduces. No unit test can cover the live pre-sign-in path, so drive it and read the logs.

**Files:** none (verification only).

- [ ] **Step 1: Start the backend and enable the proxy**

```bash
npm run server:dev   # Fastify on :8787 (leave running in its own terminal)
```

Add `KAIRO_USE_BACKEND_PROXY=1` to the repo-root `.env` (read at app launch; no rebuild needed for env, but we rebuild anyway in Step 2 for the Rust changes).

- [ ] **Step 2: Ensure signed OUT, then rebuild + launch the packaged app**

```bash
# Sign out so there is no stored session/JWT (delete the on-disk session token if present).
rm -f "$HOME/Library/Application Support/com.kairo.tutor/session.token" 2>/dev/null || true
osascript -e 'tell application "Kairo Tutor" to quit'
npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

- [ ] **Step 3: Drive the point turn and watch the log**

In a third terminal: `tail -F ~/Library/Logs/Kairo/kairo-latest.log`

In the app, advance onboarding to the **Point** practice step (`learn_point`). Hold ⌥⌃ and say “where's the wifi icon?”, then release.

- [ ] **Step 4: Assert the exemption held**

Run these greps against the log for the turn you just did:

```bash
LOG=~/Library/Logs/Kairo/kairo-latest.log
echo "--- rerouted to onboarding routes (expect 4 lines: stt, gate, vision, tts) ---"
grep "onboarding turn → unauthenticated proxy route" "$LOG" | tail -8
echo "--- must be EMPTY: NoAuth / signed out ---"
grep -i "signed out (no session token)\|NoAuth" "$LOG" | tail -5
echo "--- must be EMPTY: quota/paywall/upgrade ---"
grep -i "free request limit reached\|QuotaExceeded\|paywalled on ptt release\|upgrade" "$LOG" | tail -5
```

Expected:
- The first grep shows the reroute lines for `/v1/onboarding/stt`, `/v1/onboarding/gate`, `/v1/onboarding/vision`, and `/v1/onboarding/tts/stream`.
- The second and third greps are **empty**.
- On screen: the pet flies to the Wi‑Fi icon, the box/pointer appears, Kairo speaks the answer, and the peak celebration fires (Task 4).

- [ ] **Step 5: Repeat for the Circle step**

Advance to the **Circle** step, hold ⌥⌃, circle any icon, ask “what is this?”, release. Re-run the Step 4 greps for the new turn (STT + vision + TTS reroute lines present; no NoAuth/quota/upgrade). Circle skips the gate, so expect 3 reroute lines (stt, vision, tts), not 4.

- [ ] **Step 6: Confirm the meter was untouched (optional DB check)**

If you have `psql` access to the dev Neon DB, confirm no free credits were spent by the signed-out demo (there is no user row to charge — the routes never touch `usage_counter`). Nothing to assert if you skipped sign-in; the absence of any `usage_counter` write is guaranteed by the unauthenticated routes.

- [ ] **Step 7: Commit the verification note**

No code changed. If you keep a QA log, record the pass there; otherwise skip. (Do not commit `.env`.)

---

## Task 4: Peak beat — `cursor:celebrate` + `arrive` on the point landing

**Files:**
- Modify: `src/onboarding/demoController.ts`

- [ ] **Step 1: Import the sound cue**

In `src/onboarding/demoController.ts`, add to the imports (next to `import { klog } from '../core/logger';`):

```ts
import { playSound } from '../core/sound';
```

- [ ] **Step 2: Fire the peak on the first real point reveal**

In `runPointTurn`, the vision branch currently does:

```ts
  const result = await visionPromise;
  await playSteps(bridge, result.steps, result.revealStep, filler ? undefined : cb.onSpeaking);
  await new Promise((r) => setTimeout(r, HIGHLIGHT_DWELL_MS));
  await releaseVisualTargets(bridge);
```

Replace that block with a wrapped reveal that marks the peak the instant the first box/pointer lands — the Phase 2 `cursor:celebrate` beat + the `arrive` cue, fired once and only when there is an actual target (so a no-target answer stays quiet):

```ts
  const result = await visionPromise;
  let peaked = false;
  const revealWithPeak = async (step: TutorStep, transition?: RevealTransition) => {
    await result.revealStep(step, transition);
    if (!peaked && step.visualTargets.length > 0) {
      peaked = true;
      // THE PEAK: the pet has landed on the real target. Celebrate + the arrival cue,
      // used sparingly so it stays special (see spec §9 peak-end).
      void emit('cursor:celebrate');
      playSound('arrive');
      klog('onboarding', 'info', 'point peak', {});
    }
  };
  await playSteps(bridge, result.steps, revealWithPeak, filler ? undefined : cb.onSpeaking);
  await new Promise((r) => setTimeout(r, HIGHLIGHT_DWELL_MS));
  await releaseVisualTargets(bridge);
```

(`emit`, `TutorStep`, `RevealTransition`, `HIGHLIGHT_DWELL_MS`, and `playSteps` are all already imported/defined in this file.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/onboarding/demoController.ts
git commit -m "feat(onboarding): mark the point peak with cursor:celebrate + the arrive cue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Seeded prompts (always-present targets) + rotation + point copy

**Files:**
- Modify: `src/onboarding/copy.ts`
- Modify: `src/onboarding/OnboardingFlow.tsx`
- Test: `tests/seededPrompts.test.ts` (create)
- Regenerate: `src/onboarding/audio/learn_point.wav`

- [ ] **Step 1: Write the failing unit test**

Create `tests/seededPrompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SEEDED_PROMPTS, pickSeededPrompt } from '../src/onboarding/copy';

describe('pickSeededPrompt', () => {
  it('rotates deterministically through a mode\'s list', () => {
    const list = SEEDED_PROMPTS.point;
    expect(pickSeededPrompt('point', 0)).toBe(list[0]);
    expect(pickSeededPrompt('point', 1)).toBe(list[1 % list.length]);
    expect(pickSeededPrompt('point', list.length)).toBe(list[0]); // wraps
  });

  it('point prompts only reference always-present targets', () => {
    // Menu-bar / status-icon targets exist on every screen (no app required).
    for (const p of SEEDED_PROMPTS.point) {
      expect(/wifi|battery|apple menu/i.test(p)).toBe(true);
    }
  });

  it('never returns empty for any mode', () => {
    for (const mode of ['talk', 'point', 'circle'] as const) {
      expect(pickSeededPrompt(mode, 7).trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- seededPrompts`
Expected: FAIL — `SEEDED_PROMPTS`/`pickSeededPrompt` are not exported yet.

- [ ] **Step 3: Add the seeded prompts to `copy.ts`**

In `src/onboarding/copy.ts`, add near the bottom (after `permissionSpeech`):

```ts
/** Seeded practice prompts — 2-3 concrete phrases per mode so the mic is never blank (spec §8).
 *  Point uses ALWAYS-PRESENT targets (menu bar / status icons) so it works on any screen. */
export const SEEDED_PROMPTS: Record<'talk' | 'point' | 'circle', string[]> = {
  talk: ["hey Kairo, what's up?", 'how are you today?', 'tell me a fun fact'],
  point: ["where's the wifi icon?", 'point at the battery', "where's the Apple menu?"],
  circle: ['circle any icon and ask what it is', 'circle something and ask about it'],
};

/** Pick one seeded prompt for a mode, rotating by `seed` (e.g. a per-mount counter). */
export function pickSeededPrompt(mode: 'talk' | 'point' | 'circle', seed: number): string {
  const list = SEEDED_PROMPTS[mode];
  return list[((seed % list.length) + list.length) % list.length];
}
```

- [ ] **Step 4: Update the `learn_point` spoken line to an always-present target**

In `src/onboarding/copy.ts`, replace the `learn_point` step's `speech` text (keep `cacheKey: 'learn_point'` and the title `'I point, you act'`):

```ts
      {
        cacheKey: 'learn_point',
        text: () =>
          "Now the fun part. Hold Option and Control together, and ask me to point something out on your screen — like the wifi icon, or the Apple menu. Watch me find it.",
      },
```

- [ ] **Step 5: Render the rotating seeded chip for all demo modes**

In `src/onboarding/OnboardingFlow.tsx`:

Import the picker — extend the existing copy import:

```ts
import { permissionSpeech, pickSeededPrompt, STEPS, type StepId } from './copy';
```

Add a per-mount rotation seed. Next to the other refs (near `const demoDoneRef = useRef(false);`), add:

```ts
  const promptSeedRef = useRef(0);
```

In the demo-wiring effect (the `useEffect` keyed on `[step.id]` that calls `set_onboarding_ptt`), bump the seed once per mount — add near the top of that effect, right after `if (!mode) return;`:

```ts
    promptSeedRef.current += 1;
```

In `renderDemo`, replace the talk-only hint line:

```tsx
        {mode === 'talk' && <div className="ob-demo-hint">try: “hey Kairo, what’s up?”</div>}
```

with a rotating chip shown for every demo mode:

```tsx
        <div className="ob-demo-hint">try: “{pickSeededPrompt(mode, promptSeedRef.current)}”</div>
```

- [ ] **Step 6: Run the unit test + typecheck**

Run: `npm run test -- seededPrompts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Regenerate the `learn_point` cached audio**

The `learn_point` line text changed; regenerate its shipped WAV so the spoken line matches the new copy (needs `SARVAM_API_KEY` in the root `.env`). This also rewrites the other cached lines from the same `CACHED_LINES` list — that is fine (idempotent, same text).

```bash
npx tsx scripts/gen-onboarding-audio.ts
```

Expected: prints `OK learn_point (…chars)` among the lines. If `SARVAM_API_KEY` is missing, `speak()` falls back to live synthesis via `/v1/onboarding/tts`, but the shipped WAV would be stale — so regenerate before shipping.

- [ ] **Step 8: Commit**

```bash
git add src/onboarding/copy.ts src/onboarding/OnboardingFlow.tsx tests/seededPrompts.test.ts src/onboarding/audio/learn_point.wav
git commit -m "feat(onboarding): rotating seeded prompts + always-present point target

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Retry-on-empty — demo turns return a status, flow retries instead of advancing

Today every practice turn auto-advances even on an empty transcript or a no-target answer. Make the turns report success so the flow can show a gentle nudge and let the user try the chord again (chord-is-the-only-Next stays intact).

**Files:**
- Modify: `src/onboarding/demoController.ts`
- Modify: `src/onboarding/OnboardingFlow.tsx`

- [ ] **Step 1: Add the `DemoResult` type and return it from all three turns**

In `src/onboarding/demoController.ts`, add near the top (after the `DemoCallbacks` type):

```ts
// Outcome of one practice turn: `ok` → advance; otherwise show a retry nudge and let the
// user hold the chord again. `reason` picks the retry caption.
export type DemoResult = { ok: boolean; reason?: 'empty' | 'no_target' };
```

`runTalkTurn` — change the signature to `Promise<DemoResult>` and replace its body's tail:

```ts
  cb.onThinking?.();
  const { text } = await bridge.transcribeAudio({ audioBase64, mimeType: WAV });
  const transcript = (text ?? '').trim();
  klog('onboarding', 'info', 'talk turn', { transcript_len: transcript.length });
  if (!transcript) return { ok: false, reason: 'empty' };
  const reply = (await onboardingChat(transcript, name)) || "I hear you! Let's keep going.";
  await speak(bridge, reply, cb.onSpeaking);
  return { ok: true };
```

`runPointTurn` — change the return type to `Promise<DemoResult>`. After `const query = …`, add an early empty-transcript retry (don't spend a vision call on silence):

```ts
  const query = (text ?? '').trim();
  if (!query) return { ok: false, reason: 'empty' };
  const active = capture.activeApp ?? (await bridge.getActiveApp());
```

In the `!needsScreen` branch, return ok (a real direct answer is a fine turn):

```ts
  if (!needsScreen) {
    await speak(bridge, filler || 'Got it!', cb.onSpeaking);
    return { ok: true };
  }
```

At the end of the vision branch (after `await releaseVisualTargets(bridge);` from Task 4), report whether we actually pointed:

```ts
  const hasTarget = result.steps.some((s) => s.visualTargets.length > 0);
  return { ok: hasTarget, reason: hasTarget ? undefined : 'no_target' };
```

`runCircleTurn` — change the return type to `Promise<DemoResult>`. The circle GESTURE carries the intent, so an empty transcript is fine; only a no-target answer retries. After `await releaseVisualTargets(bridge);`, add:

```ts
  const hasTarget = result.steps.some((s) => s.visualTargets.length > 0);
  return { ok: hasTarget, reason: hasTarget ? undefined : 'no_target' };
```

- [ ] **Step 2: Consume the result in `OnboardingFlow.tsx`**

Import the type — extend the demo-controller import:

```ts
import { runCircleTurn, runPointTurn, runTalkTurn, type DemoResult } from './demoController';
```

Add retry caption state next to the other demo state (near `const [demoDone, setDemoDone] = useState(false);`):

```ts
  const [demoRetry, setDemoRetry] = useState<null | 'empty' | 'no_target'>(null);
```

Rewrite the `runDemoTurn` `try/finally` to branch on the result:

```ts
  const runDemoTurn = useCallback(
    async (mode: DemoMode, audioBase64: string) => {
      if (demoDoneRef.current) return; // stop once the step is satisfied
      setDemoLevel(0);
      setDemoRetry(null);
      const cb = {
        onThinking: () => setDemoState('thinking'),
        onSpeaking: () => setDemoState('speaking'),
      };
      let result: DemoResult = { ok: false, reason: 'empty' };
      try {
        if (mode === 'talk') result = await runTalkTurn(nativeBridge, audioBase64, nameRef.current, cb);
        else if (mode === 'point') result = await runPointTurn(nativeBridge, audioBase64, cb);
        else result = await runCircleTurn(nativeBridge, audioBase64, gestureBufferRef.current, cb);
      } catch (error) {
        klog('onboarding', 'error', 'demo turn failed', { mode, error: String(error) });
      } finally {
        setDemoState('idle');
        if (mode !== 'talk') {
          await nativeBridge.hideOverlay();
          await showSelf();
        }
        if (result.ok) {
          demoDoneRef.current = true;
          setDemoDone(true);
          setDemoRetry(null);
          if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
          advanceTimerRef.current = setTimeout(() => go(1), 1200);
        } else {
          // Not satisfied — keep the step open so the next ⌥⌃ hold retries.
          setDemoRetry(result.reason ?? 'empty');
        }
      }
    },
    [nativeBridge, go, showSelf],
  );
```

Reset the retry caption when a demo step (re)mounts — in the demo-wiring effect, next to `setDemoDone(false);`, add:

```ts
    setDemoRetry(null);
```

- [ ] **Step 3: Show the retry caption in `renderDemo`**

In `renderDemo`, replace the `status` computation:

```ts
    const status =
      demoState === 'listening'
        ? 'listening…'
        : demoState === 'thinking'
          ? 'thinking…'
          : demoState === 'speaking'
            ? 'speaking…'
            : demoDone
              ? 'nice — you’ve got it!'
              : demoRetry === 'no_target'
                ? 'hmm, I couldn’t find that — try again'
                : demoRetry === 'empty'
                  ? 'didn’t quite catch that — try again'
                  : 'ready when you are';
```

- [ ] **Step 4: Typecheck + full test run**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test`
Expected: PASS (existing suite + `seededPrompts`).

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/demoController.ts src/onboarding/OnboardingFlow.tsx
git commit -m "feat(onboarding): retry-on-empty / no-target demo turns (chord stays the only Next)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full build + provider smoke + self-review

**Files:** none (verification).

- [ ] **Step 1: Rust compile + full frontend + server checks**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run test
npm run typecheck -w @kairo/server
npm run test -w @kairo/server -- onboarding-proxy
```

Expected: all green.

- [ ] **Step 2: Build the real packaged app**

```bash
osascript -e 'tell application "Kairo Tutor" to quit'
npm run tauri:build -- --bundles app && open "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

Expected: builds, signs, launches.

- [ ] **Step 3: End-to-end run of Act 4 (proxy ON, signed out)**

Re-run Task 3 Steps 1–5 end to end: with `KAIRO_USE_BACKEND_PROXY=1` and no session, drive Point then Circle and confirm (a) the pet points / describes on the real screen, (b) the peak celebration + `arrive` fire on Point, (c) the seeded chip rotates, (d) an empty hold shows the retry caption and does NOT advance, and (e) the Task 3 Step 4 greps show reroutes with no NoAuth/quota/upgrade.

- [ ] **Step 4: Provider smoke (touched provider routing)**

```bash
npm run smoke:providers
```

Expected: providers reachable (this exercises STT/gate/vision/TTS provider config paths we now also mirror in the onboarding routes).

- [ ] **Step 5: Self-review against the spec**

Re-read §4 Act 4, §7 two-mechanic ladder, §8 seeded prompts, §9 peak-end, §3B shared contracts, and risk #4 in `docs/superpowers/plans/2026-07-21-onboarding-redesign-and-modern-notch.md`. Confirm every requirement maps to a task:
  - Act 4a point + peak (`cursor:celebrate` + `arrive`, always-present target) → Tasks 4, 5.
  - Act 4b circle (gesture bypasses gate; live trail already wired) → unchanged pipeline + Task 6 no-target retry.
  - Chord-is-the-only-Next → preserved (no Continue button for `learn_point`/`circle`; retry keeps the step open).
  - Onboarding paywall/auth exemption + verification → Tasks 1, 2, 3 (the centerpiece).
  - Seeded rotation + retry-on-empty → Tasks 5, 6.

Fix any gap inline, then finish.

---

## Notes / open items (not blockers for this phase)

- **Desktop-dim lift for Act 4** (show the real screen) is Phase 3's coach-surface concern; the demo already hides the onboarding window during point/circle (`hideSelf`), so the real screen shows through. No change here.
- **`cursor:celebrate`** is a Phase-2 deliverable (`src/cursor/useCursorEngine.ts`). This phase only emits it; if Phase 2 hasn't landed yet, the emit is a harmless no-op and the `arrive` cue still plays.
- **Name-in-prompt** (spec §12) is finalized in Phase 6 — not wired here.
- **Circle marks boldness** already shipped (a recent visibility fix); nothing to do.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-onboarding-phase5-magic.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
