# Phase E — First-Run Focus Grab

> **Status:** Ready to build. **Depends on Phase A** (always-`Regular` app) — activation is only
> reliable once the app is `Regular`. Best sequenced after A; can run in parallel with C/D/F.
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) §E (and the
> decision ledger row 3 / risk §A.7).
> **One-line goal:** on a cold first run, Kairo comes to the front so the HERO (Act 0) has the user's
> undivided attention — **without** minimizing the rest of the desktop.

---

## Goal

Competitor parity: when a brand-new user launches Kairo, the onboarding window must open **in front of**
whatever they had focused, not behind it. That's the whole ask.

The critical boundary: **focus = "come to front," not "minimize the world."** We do **not** call
`hideOtherApplications:`. Act 3 (permissions) needs System Settings visible on screen while the pet
points at the real toggle — hiding other apps would break that beat. So this phase is *only* "front the
app," never "hide others."

Honest framing: **after Phase A this phase is nearly a no-op.** The mechanism (`activate_frontmost`)
already exists and is already called twice at first-run, and there is **no `hideOtherApplications:` call
anywhere in the repo today** (verified: `grep -rn "hideOtherApplications" src-tauri/ src/` → no hits). So
Phase E is mostly **verification** that the existing double-activate reliably fronts the HERO now that the
app is `Regular`, plus a small guard/comment so a future change doesn't accidentally introduce hide-others.

---

## Current state

### The activation helper — `src-tauri/src/lib.rs:463-488`

Already exists, already does exactly the "come to front" behavior we want, and already logs its result:

```rust
/// Bring Kairo to the foreground and steal focus (macOS). Used at first-run launch so the onboarding
/// window opens IN FRONT of whatever the user had focused (a launched app should come forward), not
/// behind it. `activateIgnoringOtherApps` is the reliable way to steal focus; the modern `activate`
/// deliberately won't take focus from another app, which is exactly what we DON'T want here.
#[cfg(target_os = "macos")]
fn activate_frontmost(app: &tauri::AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut activated = false;
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
            // Modern (macOS 14+) — the documented replacement; works for the current app.
            ns_app.activate();
            // Legacy — still honored on older macOS; ignored on Sonoma+ (harmless).
            #[allow(deprecated)]
            ns_app.activateIgnoringOtherApps(true);
            activated = true;
        }
        // Also key the onboarding window itself (activation alone can leave it non-key).
        if let Some(win) = app2.get_webview_window("onboarding") {
            let _ = win.show();
            let _ = win.set_focus();
        }
        crate::klog!(app, info, activated = activated, "activate frontmost");
    });
}
```

Note it explicitly **only** activates the current app (`NSApplication.activate()` +
`activateIgnoringOtherApps(true)`) and keys the `"onboarding"` window. It touches **nothing** on other
apps — no hide, no minimize. This is the whole "front, don't hide" contract, already satisfied.

### First-run call sites (the double-activate) — `src-tauri/src/lib.rs:710-726`

```rust
// First run: show the dedicated borderless onboarding window instead of the dashboard,
// and pull the whole app to the foreground so it doesn't open behind the current window.
if need_onboarding {
    crate::onboarding::show_onboarding_window(app.handle());
    #[cfg(target_os = "macos")]
    {
        // Activate now AND again after the launch settles — macOS activation is finicky
        // during app launch (deprecated activateIgnoringOtherApps can be ignored on
        // Sonoma until the runloop is up), so re-assert on a short delay.
        activate_frontmost(app.handle());
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            activate_frontmost(&handle);
        });
    }
}
```

So at first-run it's called **twice**: immediately after `show_onboarding_window`, then again ~700ms
later on a spawned thread. The `"onboarding"` window it keys is the one that hosts `OnboardingApp`, whose
first act — after Phase C — is the **HERO** (Act 0). Fronting that window = fronting the HERO.

### The other call site (not first-run) — `src-tauri/src/lib.rs:433-436`

```rust
#[tauri::command]
fn focus_onboarding(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    activate_frontmost(&app);
    ...
}
```

Used for the OAuth hand-off (Act 5 sign-in return). Out of scope for Phase E — listed only so the reader
knows the same helper is shared, and that any change to `activate_frontmost` also affects the OAuth
return (a reason to keep the change minimal and the "front, don't hide" contract intact).

### Phase A dependency — `src-tauri/src/lib.rs:681-695`

Today the app flips to `Accessory` on a normal launch and stays `Regular` only for setup/onboarding.
Phase A makes it **always `Regular`**, which is what makes `activate_frontmost` reliable (a `Regular` app
fronts through LaunchServices the normal way; an `Accessory` app's activation races Sonoma's cooperative
policy). Phase E rides on that — it does not itself touch the activation policy.

### No hide-others exists

```
grep -rn "hideOtherApplications\|hideOther\|hide_other" src-tauri/ src/   →   (no matches)
```

There is nothing to remove. The task is to **keep it that way**.

---

## Target behavior

- On a **cold first run** (`need_onboarding == true`), the onboarding window opens **frontmost** over
  whatever the user had focused. The HERO (Act 0) gets undivided attention.
- Achieved by the existing `activate_frontmost` double-call at `lib.rs:719-724`. With Phase A's
  always-`Regular` policy, that double-call reliably fronts the app.
- **Explicitly NO hide-others.** `activate_frontmost` must continue to only *activate this app* and *key
  its own window*. It must never call `NSApplication.hideOtherApplications:` (or `NSWorkspace`
  hide/minimize of other apps). Act 3 depends on System Settings staying visible on screen.
- After onboarding (product use), nothing changes: the daily notch flow does not relaunch the process,
  so there's no repeated fronting / Space-yank (verified as part of Phase A §A.7, referenced here).

Non-goals (unchanged from parent spec):
- Not touching the activation policy (that's Phase A).
- Not changing the OAuth-return focus path (that's Phase B; it merely shares the helper).
- Not adding any "minimize everything / hide others / do-not-disturb" behavior.

---

## Implementation steps

This phase is intentionally thin. Steps 1-2 are verification; step 3 is a tiny defensive doc/log tweak.

1. **Confirm the double-activate fronts the HERO now that the app is `Regular`** (post-Phase A). No code
   change expected. Run the cold first-run walk (see Verification) with other apps open and confirm the
   HERO paints frontmost. Read the log for **two** `activate frontmost` lines (the immediate call + the
   700ms re-assert), both `activated = true`.

2. **Confirm no hide-others is present and none is introduced.** Re-run the grep
   (`grep -rn "hideOtherApplications" src-tauri/ src/` → no hits). Confirm Act 3 still shows System
   Settings alongside the pet (the window is click-through for the PERMISSIONS act, and
   `Act3Permissions` renders `null` so Settings + the OS prompt show through — see Edge cases).

3. **Small, optional hardening (recommended, ~5 lines) — make the focus grab log-verifiable and guard the
   contract.** Two micro-tweaks to `activate_frontmost` (`lib.rs:468-488`):

   a. **Extend the existing `klog!` with the real activation result** so verification is log-driven, not
      eyeball-only. Today `activated` is just "did we get a `MainThreadMarker`" (essentially always true).
      Add the app's actual foreground state right after activating:

      ```rust
      // after ns_app.activateIgnoringOtherApps(true);
      let is_active = ns_app.isActive();
      // ...
      crate::klog!(app, info, activated = activated, is_active = is_active, "activate frontmost");
      ```

      `is_active` distinguishes "activation took" from "was ignored by the launch-time runloop" — exactly
      the failure mode the 700ms re-assert exists to cover, and the thing we want to *see* in the log.
      (Keep the tag/level/message shape per the logging rules: `klog!(app, info, …fields…, "msg")`.)

   b. **Add a one-line contract comment** above the activation calls so a future edit doesn't "improve"
      focus by hiding others:

      ```rust
      // FOCUS = come to front only. NEVER hideOtherApplications: — Act 3 needs System Settings
      // visible while the pet points at the real toggle. Front this app; never minimize the world.
      ```

   These are the *only* code changes Phase E might make, and both are optional polish. If the founder
   prefers zero code churn, steps 1-2 (verification) are sufficient and Phase E ships as a pure
   confirmation with no diff. **Be honest in the commit message about which it is.**

Nothing else. Do **not** touch the 700ms delay, the double-call structure, or the activation policy.

---

## Edge cases & gotchas

1. **Act 3 must keep System Settings visible — the hard constraint.** `Act3Permissions.tsx` renders
   `null` (`src/onboarding/Act3Permissions.tsx:95`) — all guidance is the notch caption, and the OS
   permission prompt + System Settings show *through* the orchestrator window (the PERMISSIONS act is
   click-through: `INTERACTIVE[PERMISSIONS] === false` in `OnboardingApp.tsx:32`). If Phase E (or anyone)
   ever added `hideOtherApplications:`, System Settings would be hidden and the pet would point at a
   toggle the user can't see. **This is the reason "front, don't hide" is non-negotiable.**

2. **Space-yank interplay with Phase A (this is *desired* at first-run).** Phase A §A.7: an always-
   `Regular` app, on cold launch, makes macOS pull the user off any full-screen Space onto the desktop.
   For first-run onboarding that yank is **exactly what we want** — it's the mechanism that surfaces the
   HERO. So Phase E doesn't fight it; it relies on it. The mitigation to verify (that *daily* notch use,
   post-onboarding, does **not** switch Spaces) is Phase A's responsibility, not this phase's — but note
   the dependency.

3. **Launch-time activation timing — why the 700ms re-assert stays.** During app launch the deprecated
   `activateIgnoringOtherApps` can be ignored on Sonoma+ until the runloop is up, and the modern
   `activate()` won't steal focus on its own. The immediate call sometimes "doesn't take"; the delayed
   second call catches it once the runloop settles. **Keep both.** Removing the delayed re-assert is the
   most likely way to reintroduce "opened behind the browser/editor." The `is_active` log field (step 3a)
   is precisely how you'd catch a regression here — if the first line logs `is_active=false` and the
   second logs `is_active=true`, the re-assert is doing its job.

4. **Shared helper — OAuth return also uses `activate_frontmost`.** `focus_onboarding` (`lib.rs:433-436`)
   calls the same function for the Act 5 OAuth hand-off. Keep the change minimal and the "front, don't
   hide" contract intact so you don't perturb Phase B's focus-return behavior.

5. **`activate_frontmost` keys the window named `"onboarding"`.** It calls
   `get_webview_window("onboarding")` (`lib.rs:482`). That's the window hosting `OnboardingApp`; its first
   rendered act after Phase C is the HERO. If the HERO were ever moved to a different window/label, this
   lookup would need updating — but per Phase C the HERO stays inside the existing onboarding orchestrator
   window, so no change is needed.

6. **Not first-launch = no fronting (correct).** The activate calls are gated behind
   `if need_onboarding` (`lib.rs:712`). Onboarded users never get the first-run front-grab on normal
   relaunch — which is the quiet-by-default behavior we want. Don't widen this gate.

---

## Verification

Per `AGENTS.md`, do a real cold first-run walk on the packaged, signed `.app` — never a dev server.

**Static / build gate:**
```bash
grep -rn "hideOtherApplications" src-tauri/ src/     # must print nothing
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --bundles app                 # the real target
codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```

**Cold first-run focus grab (the core check):**
1. Run the reset script from `AGENTS.md` (`tccutil reset …` + delete the config markers) so it's a true
   first run. Backend up (`npm run server:dev`).
2. **Open a couple of normal apps first** (e.g. Safari + an editor), leave one focused/maximized.
3. Launch the packaged Kairo. **Expected:** the Kairo **HERO (Act 0) is frontmost** over the other apps.
4. Tail the log and confirm **two** activation lines, both fronting:
   ```bash
   tail -F ~/Library/Logs/Kairo/kairo-latest.log | grep "activate frontmost"
   # → activated=true is_active=… (immediate)  … then ~700ms later a second line
   ```
   (If you added step 3a, the second line should read `is_active=true`.)

**Act 3 still shows System Settings (the constraint):**
5. Walk to Act 3. When the OS prompt fires and you open System Settings, **confirm System Settings stays
   visible on screen** alongside the pet/notch caption — nothing hid it. The pet points at the real
   toggle with Settings clearly in view.

**Full-screen Space (shared with Phase A):**
6. On a full-screen Space with another app: first launch fronts Kairo (desired). After finishing
   onboarding, confirm daily ⌥⌃ notch use does **not** switch Spaces (this is Phase A's gate; re-confirm
   here since Phase E rides on the same launch behavior).

---

## Commit breakdown

Small and honest — likely one commit, at most two. Work on `main` (do not create a branch).

1. **`chore(onboarding): verify first-run focus grab (Phase E) — no hide-others`** — if steps 1-2 pass
   with no code change, this is a docs/verification-only commit (this plan doc + any notes). Be explicit
   in the message that Phase E is a no-op after Phase A and that `grep` confirms no `hideOtherApplications`
   exists.

2. **(optional) `feat(onboarding): log activation result + guard against hide-others in activate_frontmost`**
   — only if you take step 3: add the `is_active` field to the existing `klog!` and the one-line contract
   comment. No behavior change; just log detail + a guardrail comment.

Per `AGENTS.md`: do **not** `git commit` as part of writing this plan — these are the commits to make when
the phase is actually built. Rebuild + a fresh onboarding walk after any code change.
