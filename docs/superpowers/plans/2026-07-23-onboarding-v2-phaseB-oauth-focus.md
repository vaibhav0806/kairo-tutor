# Phase B — OAuth Focus-Return

> **Status:** Contingent on Phase A. Do **not** start until Phase A (always-`Regular` app) has shipped
> and been verified — Phase A is expected to fix this for free, so B is mostly a *re-test*, not a build.
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) → "Phase B" (§149-176)
> and decision-ledger row #5 (§29).
> **Goal (one line):** after the Google OAuth hand-off in Act 5, Kairo reliably comes to the front over
> the browser — every single time, not flakily.

---

## Goal

When the user finishes Google sign-in in the system browser, the browser redirects to
`kairo://auth-callback?code=…`. macOS delivers that deep link to Kairo, which must then **front itself
over the browser** so the user is looking at Kairo (narrating the next onboarding step), not at a
now-stale browser tab. Today this works *most* of the time but is **flaky** — occasionally sign-in
completes yet the user is left staring at the browser.

The target is **10/10 OAuth round-trips return focus to Kairo**, with a log line proving the deep link
arrived on each one.

The working hypothesis (parent spec §151-155): the flakiness is a side effect of Kairo being an
`Accessory` app that has to perform activation *gymnastics* to steal focus, and those gymnastics race
Sonoma's cooperative-activation policy. **Phase A makes Kairo always-`Regular`, which is exactly what
competitors do — and Regular URL-scheme handlers get fronted by LaunchServices the normal, reliable
way.** So Phase A likely dissolves the whole problem, and this phase is primarily: re-test, and if it's
solid, *delete* the now-redundant gymnastics.

---

## Current state

Two activation code paths fire on a successful sign-in. Understanding that both exist is the whole game
here — a fix or a simplification has to account for both.

### Path 1 — the deep-link handler (fires immediately, native)

`src-tauri/src/lib.rs:816-837` — `app.deep_link().on_open_url(...)`:
- For each `kairo://` URL it calls **`focus_onboarding_window(&handle)`** (`lib.rs:824`) **synchronously,
  first**, then extracts `code` and spawns the async `exchange_code` (`lib.rs:829-834`). So the focus
  attempt happens the instant the deep link is delivered, *before* any network round-trip.

`src-tauri/src/onboarding.rs:92-118` — `focus_onboarding_window`:
- Grabs the `"onboarding"` window (returns early if absent — this only exists during first-run).
- Queues a closure onto the main thread via **`run_on_main_thread`** (`onboarding.rs:97`). Inside it, on
  macOS:
  - **Sets `ActivationPolicy::Regular`** (`onboarding.rs:100`) — needed *today* because outside onboarding
    the app is `Accessory` and the per-act flips can toggle it. **After Phase A this is redundant** (the
    app is already Regular from launch).
  - Gets `NSApplication.sharedApplication` and calls **`ns_app.activate()`** (`onboarding.rs:108`) then
    the deprecated **`ns_app.activateIgnoringOtherApps(true)`** (`onboarding.rs:110`). This is the
    "gymnastics": activating the *app* (not just focusing the window) is what pulls Kairo in front of the
    browser on Sonoma+, and it only takes because the `kairo://` open granted transient activation rights.
  - Then `win.unminimize()` / `win.show()` / `win.set_focus()` (`onboarding.rs:113-115`) and a
    `klog!(auth, info, …)` (`onboarding.rs:116`).
- **The suspected race:** the activate is *deferred* onto the main-thread queue. If the closure runs a
  beat later than the deep-link delivery, the transient activation right granted by the URL open may have
  already lapsed → `activate()` silently does nothing.

### Path 2 — the frontend, after the code exchange (fires ~1-2s later)

- `src-tauri/src/auth.rs:85-111` — `exchange_code` posts the code to `/auth/exchange`, stores the session,
  and on success emits **`auth:changed` → true** (`auth.rs:99`).
- `src/onboarding/acts/Act5SignIn.tsx:20-47` — the act listens via `onAuthChanged` (`:24`) and sets
  `signedIn`; a second effect (`:37-47`) then runs `syncUserName()` and on resolve calls
  **`bridge.focusOnboarding()`** (`:42`), `clear()`, and `onSignedIn(name)`.
- `src/native/nativeBridge.ts:394-400` — `focusOnboarding()` invokes the **`focus_onboarding`** command.
- `src-tauri/src/lib.rs:433-439` — `focus_onboarding` calls **`activate_frontmost(&app)`**.
- `src-tauri/src/lib.rs:467-488` — `activate_frontmost` is the *same* dance as path 1 (queued
  `run_on_main_thread`, `activate()` + `activateIgnoringOtherApps(true)`, then window show/focus), minus
  the policy set.
- Immediately after `focusOnboarding()`, `onSignedIn(name)` runs
  (`OnboardingApp.tsx:108-111`) → `setObName` + **`advance()`** → `actIndex` goes SIGNIN→SOURCE. That act
  transition fires the click-through effect (`OnboardingApp.tsx:63-67`, toggles
  `set_onboarding_click_through`) and mounts a fresh `TempPanel` for Act5Source. **This is the suspected
  "took then bounced" mechanism** — a window-property change + panel mount that re-orders focus a beat
  after path 2 just grabbed it.

So on a happy sign-in: **fast native focus (path 1) → ~1-2s gap → second focus + an act advance
(path 2).** The flakiness could live in either.

---

## Track 1 — Re-test after Phase A (the expected path)

Assume Phase A fixed it. Prove that, then simplify.

### 1a. Re-test protocol
1. Ship + verify Phase A first (Regular app confirmed: Dock icon, ⌘-Tab, always-Regular policy).
2. Reset to a true first-run using the `AGENTS.md` reset script (`tccutil reset …` + delete
   `session.token`, `onboarded`, `onboarding_step`), backend running (`npm run server:dev`), tail
   `~/Library/Logs/Kairo/kairo-latest.log`.
3. Walk to Act 5, sign in via Google, observe whether Kairo fronts over the browser.
4. **Repeat the full OAuth round-trip 10 consecutive times** (sign out + re-run, or replay intro). Vary
   the default browser at least once (Safari and Chrome — see gotchas). Record pass/fail for each.

### 1b. If solid (10/10) → simplify, don't just close it out
With the app now always-Regular, the objc2 activation dance in `focus_onboarding_window` is *likely*
redundant — LaunchServices should front the Regular handler on its own. **Verify redundancy before
deleting** (don't delete blind): temporarily comment out the objc2 block (`onboarding.rs:100-111`),
leaving only `win.unminimize()/show()/set_focus()`, rebuild, and re-run the 10× protocol.
- If still 10/10 → the dance was carrying nothing post-Phase-A. Land the simplification:
  - `focus_onboarding_window` collapses to: get window → `run_on_main_thread` → `show()` + `set_focus()`
    (+ its `klog!`). Drop the `set_activation_policy(Regular)` (Phase A owns policy) and the
    `NSApplication.activate()/activateIgnoringOtherApps` calls.
  - Consider likewise trimming `activate_frontmost` (`lib.rs:467-488`), but that helper is **also used at
    first-run launch** (`lib.rs:719-723`, Phase E) where launch-time activation genuinely needs the
    heavier hammer — so **leave `activate_frontmost` alone**; only simplify the OAuth-specific
    `focus_onboarding_window`.
- If removing the dance regresses (drops below 10/10) → the dance is still load-bearing even for a Regular
  app; **keep it**, and Phase B is "verified, no change." Document that finding inline.

Either way, Track 1 ends with a note in this doc recording the 10× result and what (if anything) was
simplified.

---

## Track 2 — Debug fallback (only if still flaky after Phase A)

If the 10× re-test still shows misses, do **not** guess-and-patch. Follow systematic-debugging:
**instrument → reproduce → read the logs → fix the actual failure mode.**

### 2a. Instrument first (no behavior change)
Add klog lines that distinguish the three possible failure modes. All under the `auth` subsystem so they
land next to the existing sign-in logs.

1. **Prove the deep link arrived** — in `on_open_url` (`lib.rs:819-824`), log at the top of the
   `kairo`-scheme branch, *before* `focus_onboarding_window`:
   ```rust
   klog!(auth, info, scheme = url.scheme(), "deep link on_open_url fired");
   ```
   If this line is missing on a failed run, the failure is the **third bug** (deep link never delivered),
   not a focus bug — a completely different investigation.

2. **"never took" vs "took then bounced"** — in `focus_onboarding_window` (`onboarding.rs`), right after
   the `activate()` / `activateIgnoringOtherApps` calls (after `onboarding.rs:110`), read and log the app's
   active state immediately:
   ```rust
   let active_now = ns_app.isActive();
   klog!(auth, info, active = active_now, "NSApp.isActive right after activate");
   ```
   Then schedule a re-read ~500ms later (can't sleep on the main thread — spawn a thread that hops back
   onto main):
   ```rust
   let app_check = app.clone();
   std::thread::spawn(move || {
       std::thread::sleep(std::time::Duration::from_millis(500));
       let _ = app_check.run_on_main_thread(move || {
           if let Some(mtm) = objc2::MainThreadMarker::new() {
               let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
               klog!(auth, info, active = ns_app.isActive(), "NSApp.isActive ~500ms after activate");
           }
       });
   });
   ```
   (Confirm the exact objc2 getter name at build — it is `isActive()` on `NSApplication` in
   `objc2_app_kit`; if the binding exposes it as a property accessor, adjust. Small build-time detail.)

Interpretation:
- `right after` = **false** → activation **never took** (transient right lapsed / deferred too late).
- `right after` = **true**, `~500ms` = **false** → it **took then bounced** (something re-stole focus in
  the gap — the path-2 act advance is the prime suspect).
- `right after` = **true**, `~500ms` = **true** → focus is fine natively; if the user still perceives the
  browser on top, look at path 2 / timing / a browser that refuses to yield.

Commit the instrumentation on its own (`main`, small commit) so the diagnostic history is revertible.

### 2b. Reproduce
Run the 10× protocol until you capture **2-3 real failures** in the log. Do not proceed on one sample —
Sonoma activation races are timing-dependent and you need to see a consistent signature.

### 2c. Branch on what the logs actually say

**If "never took"** (active=false right after activate):
- The deferred/queued activate is losing the transient activation right. Call activate **synchronously**
  in the handler when we're already on the main thread — i.e. in `focus_onboarding_window`, if
  `MainThreadMarker::new()` returns `Some` we are *already* on main, so run the activate inline instead of
  re-queuing through `run_on_main_thread` (the queue hop is what introduces the lapse). Keep the
  `run_on_main_thread` path only as the fallback for when we're off-main.
- Add a **second activate ~300ms later** (same spawn-thread-then-hop-to-main pattern as the instrument)
  to catch the case where the first fires a hair too early relative to the browser yielding.

**If "took then bounced"** (active=true right after, false ~500ms later):
- The re-steal is coming from path 2's act advance. In `Act5SignIn` (`Act5SignIn.tsx:37-47`) /
  `OnboardingApp` (`OnboardingApp.tsx:108-111`), the sequence is `focusOnboarding()` → `advance()`, and
  `advance()` flips click-through (`OnboardingApp.tsx:63-67`) + mounts Act5Source's `TempPanel`. Stop that
  from reordering focus:
  - Reassert focus **after** the advance settles (e.g. call `focusOnboarding()` once more on the next
    tick after `advance()`), or
  - Avoid the redundant path-2 activate racing path-1: since the native deep-link path already fronted the
    app, the frontend `focusOnboarding()` may be fighting itself — gate/serialize it so only one activate
    is in flight, and don't toggle click-through in a way that re-keys the window mid-front.
  - Root-cause the specific re-order (click-through toggle vs panel mount) by temporarily disabling each
    and re-running; fix the one that actually bounces.

**If the deep link never fired** (no `on_open_url` line on a failure):
- That's not a focus bug. Investigate deep-link registration / the `tauri-plugin-deep-link` single-instance
  hand-off separately (out of this phase's scope, but note it so it isn't mistaken for flaky focus).

### 2d. Clean up
Once the real fix lands and passes 10×, either remove the `~500ms`/`~300ms` diagnostic klogs or downgrade
them to `debug` level so they don't spam every future sign-in. Keep the `on_open_url fired` line at
`info` — it's cheap and permanently useful.

---

## Edge cases & gotchas

- **Third failure mode — deep link never delivered.** If macOS never routes `kairo://auth-callback` to the
  process, *neither* focus path runs **and** `exchange_code` never fires, so sign-in silently never
  completes (session file never written, `getAuthStatus` stays false). The `on_open_url fired` klog is the
  only way to tell this apart from a focus miss. Do not conflate it with flaky focus.
- **Browser variance.** Chrome, Safari, Arc, and Firefox differ in how aggressively they hold focus and how
  they hand off a custom-scheme open (some show a "Open Kairo Tutor?" confirm sheet that itself steals a
  beat of focus). Test at least Safari + Chrome in the 10× protocol; a fix that only works in one browser
  isn't done.
- **Ordering of `focus_onboarding_window` vs the async `exchange_code`.** Path 1 fronts the app
  *immediately* and synchronously on deep-link delivery (`lib.rs:824`), **before** `exchange_code` is even
  spawned (`lib.rs:829-834`). Path 2's second focus + act-advance happen only *after* the network exchange
  **and** `syncUserName` resolve — a 1-2s gap. So the app can correctly front at t=0 (path 1) and then get
  bounced at t=~1.5s by path 2's advance. When reading logs, line up `on_open_url fired` / `isActive right
  after` (path 1) against `act5 signed in` / `session stored` (path 2) to see which one is associated with
  the miss.
- **`focus_onboarding_window` is onboarding-only by design.** It early-returns if the `"onboarding"` window
  doesn't exist (`onboarding.rs:93-95`), so normal post-onboarding re-auth never steals focus. Keep that
  guard — don't "fix" focus in a way that fronts the app during everyday signed-in use.
- **Don't over-hammer.** `activateIgnoringOtherApps(true)` is deprecated and Sonoma may ignore it; piling
  on more activate calls isn't a fix if the real issue is path-2 bounce. Let the logs pick the branch.

---

## Verification

- **10/10** consecutive OAuth round-trips return focus to Kairo over the browser (Safari + Chrome both
  represented), on the packaged signed `.app` (never dev).
- The log shows `deep link on_open_url fired` on **every** round-trip (rules out the third bug).
- If Track 2 ran: the `isActive` before/after lines confirm the chosen branch actually fixed the signature
  that was failing.
- Standard gate (per `AGENTS.md`):
  ```bash
  npm run typecheck
  npm run test
  cargo check --manifest-path src-tauri/Cargo.toml
  npm run tauri:build -- --bundles app
  codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
  ```
- Then the full onboarding walk via the `AGENTS.md` reset script, backend up.

---

## Commit breakdown

Small, revertible commits on `main` (do **not** git commit as part of writing this doc — this is the
plan only).

**Track 1 (expected):**
1. `test: verify OAuth focus-return 10× after Regular-app switch` — no code; record the 10× result in this
   doc (and in the parent spec's Phase B section).
2. `refactor(auth): drop redundant objc2 activate dance from focus_onboarding_window` — only if 1b's
   commented-out re-test stayed 10/10. Collapse to `show()+set_focus()`; leave `activate_frontmost`
   (first-run launch) untouched.

**Track 2 (only if still flaky):**
1. `chore(auth): instrument OAuth focus-return (on_open_url + NSApp.isActive before/after)` — the klog
   lines from §2a, no behavior change.
2. Reproduce + read logs (no commit).
3. Fix commit, branch-dependent:
   - `fix(auth): activate synchronously on-main + second activate for OAuth focus` (the "never took"
     branch), **or**
   - `fix(onboarding): stop Act5 advance from bouncing focus after sign-in` (the "took then bounced"
     branch).
4. `chore(auth): quiet OAuth focus diagnostics to debug` — drop/downgrade the 500ms/300ms probes, keep the
   `on_open_url fired` line at info.
