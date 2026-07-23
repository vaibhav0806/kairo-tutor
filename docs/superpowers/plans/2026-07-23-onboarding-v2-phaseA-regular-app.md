# Phase A — Regular App

> **Status:** Ready to build.
> **Parent spec:** [`2026-07-23-onboarding-ux-v2.md`](./2026-07-23-onboarding-ux-v2.md) → Phase A (§A, decision ledger #1, risks §4.1).
> **One-line goal:** Make Kairo a first-class `Regular` macOS app (Dock icon + app menu + ⌘-Tab) that still feels quiet — kill the `Accessory`↔`Regular` flip-flop, open the existing `main` window from the Dock, hide (not quit) on red-close.

---

## Goal

Move Kairo permanently off `ActivationPolicy::Accessory` onto `ActivationPolicy::Regular`. The app gains a
Dock icon, the standard macOS app menu, and a ⌘-Tab presence, while keeping every window closed by default
(the notch stays the ambient tool). The Dock icon becomes the re-entry point to a real "home" window (the
existing `main` window). We keep the menu-bar status item too — Dock **and** menu bar. Red-close hides the
window and the app keeps running; ⌘Q is the real quit. This also removes the per-act activation-policy
gymnastics that make OAuth focus-return flaky (Phase B verifies that side effect).

This plan delivers the **Regular-app shell only**. The account/settings/billing *content* that will live
inside the `main` window is explicitly out of scope (later work) — for now `main` keeps rendering today's
permission/status dashboard (`src/App.tsx`).

---

## Current state

### `LSUIElement` is NOT set (confirmed)
- `src-tauri/Info.plist` (10 lines) has only `NSAppleEventsUsageDescription` + `NSMicrophoneUsageDescription`. No `LSUIElement`.
- The built bundle confirms it: `PlistBuddy -c "Print :LSUIElement" ".../Kairo Tutor.app/Contents/Info.plist"` → `Does Not Exist`.
- So the agent/Dock behavior is **entirely code-driven** via `set_activation_policy(...)`. Phase A is a **code change only** — no `Info.plist`/`tauri.conf.json`/entitlement edits.

### The activation-policy flip-flop — `src-tauri/src/lib.rs`
`run()` spans lines **660–902**. The setup closure computes two flags and flips policy:

- `lib.rs:675-676`
  ```rust
  let show_setup = should_show_setup_window(&get_permission_status());
  let need_onboarding = !crate::onboarding::is_onboarded(app.handle());
  ```
- `lib.rs:681-695` — the flip-flop. Lines **691-693** are the branch to delete:
  ```rust
  #[cfg(target_os = "macos")]
  {
      if !show_setup && !need_onboarding {
          app.set_activation_policy(tauri::ActivationPolicy::Accessory);
      }
      klog!(app, info, setup = show_setup, onboarding = need_onboarding, "activation policy set");
  }
  ```
  The comment above it (`lib.rs:681-688`) explains the original Space-yank reason for `Accessory` — see §A.7 gotcha below; this comment gets rewritten.
- `lib.rs:696-709` — the `main` window is fetched and sized here; this is where the red-close→hide handler will be registered:
  ```rust
  if let Some(window) = app.get_webview_window("main") {
      log_window_startup(&window);
      let _ = window.set_size(LogicalSize::new(1180.0, 820.0));
      let _ = window.center();
      if show_setup && !need_onboarding {
          let _ = window.unminimize();
          let _ = window.show();
          let _ = window.set_focus();
      } else {
          let _ = window.hide();
      }
  } else {
      klog!(app, warn, "startup: main window was not created");
  }
  ```
- `lib.rs:900` — the tail: `.run(tauri::generate_context!()).expect("error while running Kairo Tutor");` — **there is no `RunEvent` closure today.** To handle Dock reopen we must convert this to `.build(...)?.run(|app_handle, event| { ... })`.

### The menu-bar tray — `src-tauri/src/lib.rs:524-567`
`create_menu_bar_tray(app: &tauri::App) -> tauri::Result<()>` builds the status item. **Keep it.** Item IDs
and their handlers (lines 538-557) are the ones we reuse for the Dock menu:
- `tray_show_notch` → `show_notch_with_payload(...)`
- `tray_replay_intro` → `crate::onboarding::replay_onboarding(app)`
- `tray_quit` → `app.exit(0)`

### Stale `Accessory` comments to rewrite
- `lib.rs:459-462` — "Kairo runs as an `Accessory` app (no Dock icon), so this is the only always-visible affordance…".
- `lib.rs:796-797` — "…since we run Dock-less (Accessory)."
- `lib.rs:814-815` — on_open_url: "…normal re-auth keeps the Accessory / no-Space-switch design and never yanks the user's focus." (Premise changes — reword.)

### The per-act policy flips — `src-tauri/src/onboarding.rs`
- `onboarding.rs:100` (inside `focus_onboarding_window`): `let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);` — redundant once always-Regular. Delete.
- `onboarding.rs:186` — doc comment on `finish_onboarding`: "…drop back to the background (Accessory)." Reword.
- `onboarding.rs:207-210` (inside `finish_onboarding`):
  ```rust
  #[cfg(target_os = "macos")]
  {
      let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
  }
  ```
  Delete the whole block.
- `onboarding.rs:226-229` (inside `replay_onboarding`):
  ```rust
  #[cfg(target_os = "macos")]
  {
      let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
  }
  ```
  Delete the whole block (already Regular).

### `main` window config — `src-tauri/tauri.conf.json:14-25`
```json
{ "label": "main", "title": "Kairo Tutor", "width": 1180, "height": 820,
  "minWidth": 920, "minHeight": 640, "resizable": true, "visible": false, "focus": false }
```
`closable` is unspecified → defaults to `true`, so the red button is enabled and its click fires
`WindowEvent::CloseRequested` (which we intercept). **No config change needed.** The notch/cursor/overlay
windows are separate always-`create:false` panels created in code — closing `main` never brings the window
count to zero, so the app never auto-exits from a `main` close even before our guard.

### `main` window renders today — `src/App.tsx` + `src/main.tsx`
- `src/main.tsx:21-30` routes by URL hash; the default (no `#/…` hash) renders `App`.
- `src/App.tsx:11-13` self-documents: *"The main window is normally hidden. Rust only reveals it on first run when TCC permissions still need granting… this component is purely the permission-recovery screen."* It stays as-is for Phase A (content redesign is later work); the Dock just `show()`s it.

### Dependencies (versions confirmed, `src-tauri/Cargo.toml` + `Cargo.lock`)
- `tauri` **2.11.3** (features `macos-private-api`, `tray-icon`).
- `objc2` **0.6.4**, `objc2-app-kit` **0.3.2** (features already include `NSApplication`, `NSResponder`, `NSWindow`, `NSRunningApplication`, `NSWorkspace`), `objc2-foundation` **0.3.2**. `activate_frontmost` (`lib.rs:467-488`) already uses `objc2::MainThreadMarker` + `objc2_app_kit::NSApplication::sharedApplication(mtm)` — the Dock-menu work mirrors this.

---

## Target behavior

- **Always `Regular`.** One explicit `set_activation_policy(Regular)` at launch; zero policy flips anywhere else. The app is Regular from launch to quit — simpler code, and the mechanism that makes OAuth focus reliable (Phase B).
- **Dock icon present**, app appears in **⌘-Tab**, standard **app menu** shows (Tauri auto-installs the default macOS menu — App/File/Edit/View/Window/Help — once Regular; the App submenu carries About / Hide / Hide Others / Quit ⌘Q for free, so **⌘Q works with no code**).
- **Left-click the Dock icon** (app running, `main` hidden or not) → `main` shows + focuses. Handled via `RunEvent::Reopen { has_visible_windows }`. **This is the must-have.**
- **Right-click the Dock icon** → a Dock context menu (*Open Kairo* / *Show Notch* / *Replay intro* / *Quit*) reusing the tray handlers. **Nice-to-have** (needs the `applicationDockMenu:` delegate via objc2); ships behind the must-have, with a documented fallback.
- **Menu-bar status item stays** (`create_menu_bar_tray`) → Dock **and** menu bar, both.
- **Red close on `main`** → window **hides**, app keeps running (menu-bar + Dock still there). Via `WindowEvent::CloseRequested` → `prevent_close()` + `hide()`.
- **⌘Q / tray "Quit Kairo"** → real quit.

---

## Implementation steps

Order matters: steps 1-4 are the must-have and can ship together; step 5 (Dock right-click menu) is an
isolated follow-up. Each step lists the exact edit and the `klog!` line(s) to add.

### Step 1 — Force `Regular` at launch (kill the flip)
**File:** `src-tauri/src/lib.rs`, replace lines **681-695**.

Delete the `if !show_setup && !need_onboarding { … Accessory }` branch and the old comment; replace with an
explicit, self-documenting Regular set:

```rust
// Kairo is now a Regular app ALWAYS: Dock icon + app menu + ⌘-Tab presence, even though it
// stays visually quiet (windows closed by default; the notch is the ambient tool). We used to
// flip to `Accessory` on a normal launch to avoid macOS yanking the user off a full-screen
// Space when a Regular app launches. We now accept that cold-launch-only Space switch (see the
// Phase A plan §A.7) in exchange for a real Dock/home window + reliable OAuth focus-return.
// Tauri defaults to Regular, but we set it explicitly so intent is obvious and logged.
#[cfg(target_os = "macos")]
{
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    klog!(app, info, setup = show_setup, onboarding = need_onboarding, policy = "regular", "activation policy: regular (always)");
}
```
Keep `show_setup` / `need_onboarding` (lines 675-676) — they are still used by the `main`-window block
(696-709) and by the `need_onboarding` onboarding-window gate (712).

### Step 2 — Remove the per-act policy flips
**File:** `src-tauri/src/onboarding.rs`.

1. **Line 100** (`focus_onboarding_window`): delete
   `let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);`. The app is already Regular;
   keep the `NSApplication.activate()` / `activateIgnoringOtherApps` dance and the existing
   `klog!(auth, info, "activated Kairo + focused onboarding window after auth callback")` (line 116).
   Add above the activate block:
   ```rust
   crate::klog!(auth, info, "focus onboarding: app already Regular, activating");
   ```
2. **Lines 207-210** (`finish_onboarding`): delete the entire
   `#[cfg(target_os = "macos")] { let _ = app.set_activation_policy(Accessory); }` block. Reword the
   function doc at line 186 from "…drop back to the background (Accessory)." to "…the app stays a Regular
   app (Dock + menu bar) after onboarding.". The existing `klog!(app, info, "onboarding finished")`
   (line 211) stays.
3. **Lines 226-229** (`replay_onboarding`): delete the entire
   `#[cfg(target_os = "macos")] { let _ = app.set_activation_policy(Regular); }` block. The existing
   `klog!(app, info, "replay intro: onboarding marker cleared + window reopened")` (line 231) stays.

After this, `set_activation_policy` appears **exactly once** in the whole crate (Step 1's line).

### Step 3 — Red-close hides `main` (keep the app alive)
**File:** `src-tauri/src/lib.rs`, inside the existing `if let Some(window) = app.get_webview_window("main")`
block (**696-709**). After `let _ = window.center();` (line 699), register a close handler:

```rust
// Red close / ⌘W on the home window HIDES it — the app keeps running (Dock + menu bar remain).
// A Regular Mac app conventionally survives its last window closing; ⌘Q (app menu) / the tray
// "Quit Kairo" item are the real quit paths. We prevent the close and hide instead of destroy so
// the window (and its WebView) is instantly re-showable from the Dock with no rebuild.
let hide_target = window.clone();
window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = hide_target.hide();
        crate::klog!(app, info, window = "main", "close requested → hidden (app stays alive)");
    }
});
```
`tauri::WindowEvent` and `CloseRequestApi::prevent_close()` are stock Tauri v2 (`CloseRequestApi` is already
re-exported by the crate). No new imports beyond `tauri::WindowEvent` (add to the `use tauri::{…}` at
`lib.rs:8` if not glob-available — currently that line imports `Emitter, LogicalSize, Manager, State`; add
`WindowEvent`).

> **Deliberately NOT** adding a blanket `RunEvent::ExitRequested → api.prevent_exit()`. Per the Tauri v2
> source, `ExitRequested { code, .. }` carries `code: None` for **user interaction** — and that bucket
> includes **both** a last-window-close **and** ⌘Q. A `if code.is_none() { prevent_exit() }` guard would
> therefore also swallow ⌘Q and make the app unquittable. The `CloseRequested → hide` above already keeps
> the app alive (the window is never destroyed), and the persistent notch/cursor/overlay panels mean the
> window count never hits zero anyway, so no exit-on-last-window path exists to guard. (Source:
> `crates/tauri/src/app.rs` @ `tauri-v2.11.3` — `RunEvent::ExitRequested` doc + `ExitRequestApi::prevent_exit`.)

### Step 4 — Dock left-click opens `main` (`RunEvent::Reopen`)
**File:** `src-tauri/src/lib.rs`, the tail at **line 900**.

`RunEvent::Reopen { has_visible_windows: bool }` is macOS-only and fires from
`applicationShouldHandleReopen` — i.e. a Dock-icon left-click (verified against
`crates/tauri/src/app.rs` @ `tauri-v2.11.3`). To receive it we must switch from `Builder::run(context)` to
`Builder::build(context)?.run(closure)` (the former is just the latter with an empty closure).

Replace:
```rust
        .run(tauri::generate_context!())
        .expect("error while running Kairo Tutor");
```
with:
```rust
        .build(tauri::generate_context!())
        .expect("error while building Kairo Tutor")
        .run(|app_handle, event| {
            // Keep app_handle referenced on non-macOS builds (the only arm below is macOS-gated).
            let _ = &app_handle;
            match event {
                // Dock-icon left-click (applicationShouldHandleReopen) → bring the home window forward.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    crate::klog!(app, info, has_visible_windows = has_visible_windows, "dock reopen → show main");
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    } else {
                        crate::klog!(app, warn, "dock reopen: main window missing");
                    }
                }
                _ => {}
            }
        });
```
Notes:
- The `#[cfg(target_os = "macos")]` sits on the **match arm** — legal in Rust — so non-macOS still compiles (the `Reopen` variant itself is macOS-only, so an ungated arm would fail to build cross-platform, per the project's cross-platform rule).
- `activate_frontmost` is intentionally **not** called here — a Reopen already implies the app is being activated by macOS; we only need to surface the window.
- We do not gate on `has_visible_windows`; we always show `main` (the user asked to open Kairo). We log the flag for debugging.

### Step 5 — Dock right-click menu (nice-to-have; separate commit)
**File:** `src-tauri/src/lib.rs` (new small `#[cfg(target_os = "macos")]` helper, called from `setup()`
after `create_menu_bar_tray`).

macOS builds the Dock context menu **only** from the `NSApplicationDelegate applicationDockMenu:` method —
there is **no** `NSApplication` property/setter for it (confirmed: Apple docs + objc2-app-kit — the dock
menu is delegate-only; `NSDockTile` does not accept a menu). Tauri/tao already installs its own
`NSApplicationDelegate`, so the objc2 approach is:

1. Build an `NSMenu` (on the main thread, via `MainThreadMarker` — mirror `activate_frontmost`) with
   `NSMenuItem`s titled **Open Kairo / Show Notch / Replay intro / Quit Kairo**.
2. Give each item a `target` + `action` (an objc2 `define_class!` handler object, or the shared app
   delegate) whose selector routes into the **same** logic as the tray handlers (`lib.rs:538-557`) — i.e.
   `main.show()+set_focus()`, `show_notch_with_payload(...)`, `crate::onboarding::replay_onboarding(app)`,
   `app.exit(0)`. Reuse those code paths so tray and Dock menus stay in lockstep (parent spec §A.6).
3. Expose the menu to macOS by adding an `applicationDockMenu:` method that returns this cached `NSMenu`.
   Since Tauri owns the delegate, this means **adding the selector to Tauri's existing delegate class at
   runtime** (objc2 `ClassBuilder`/`class_addMethod` against `NSApp.delegate()`'s class, returning the
   cached menu), or installing a thin forwarding delegate — both are fiddly and touch Tauri internals.

Because of that risk, **do not let step 5 block the phase.** Recommended sequencing:
- **Fallback (ships in the must-have):** left-click-opens-home (Step 4) + the existing menu-bar tray as the
  "options list." That already gives the user Show Notch / Replay intro / Quit off a persistent affordance.
- **Follow-up commit:** attempt the objc2 `applicationDockMenu:` hook. If it proves fragile against
  Tauri's delegate, keep the fallback permanently and note it here.

`klog!` for step 5: `klog!(app, info, "dock menu installed")` on success;
`klog!(app, warn, "dock menu unavailable: {err}")` on any objc2 failure (never panic — degrade to the
fallback). Each Dock-menu selection logs like the tray does, e.g.
`klog!(app, info, "dock menu: open kairo selected")`.

### Step 6 — Rewrite the stale `Accessory` comments
Pure comment edits (no behavior), do in the same commit as Step 1:
- `lib.rs:459-462` (`create_menu_bar_tray` doc): change to note Kairo is a **Regular** app with **both** a
  Dock icon and a menu-bar item; the tray is a quick always-visible status/quit affordance (not "the only"
  one).
- `lib.rs:796-797`: drop "since we run Dock-less (Accessory)"; the tray is a convenience alongside the Dock.
- `lib.rs:814-815` (on_open_url comment): the app is now always Regular, so re-auth focus uses the same
  Regular activation path; reword away from "Accessory / no-Space-switch design."

---

## Edge cases & gotchas

### The Space-yank (§A.7 — the original reason for `Accessory`)
A `Regular` app, **when launched**, activates — and if the user is in another app's full-screen Space,
macOS pulls them off it onto the desktop. This is exactly why `Accessory` was chosen originally
(`lib.rs:681-688`). Going always-Regular reintroduces it. **Why it's acceptable:**
- It only happens on a **cold launch**. Kairo runs persistently (login item / already open); everyday notch
  usage (⌥⌃) does **not** relaunch the process, so there is no repeated Space-yank in daily use.
- On **first run** we *want* focus grabbed (Phase E) — the yank is desirable there.
- All three benchmarked competitors (Wispr Flow, Cluely, heyclicky) are Regular and live with this.
- Daily notch show/hide can't yank the Space: the notch is a **non-activating** `NSPanel` with
  `visibleOnAllWorkspaces:true` (`tauri.conf.json:81-84`) and the process is already running, so showing it
  neither reactivates the app nor moves Spaces.

**Hard manual verification (blocks "done"):** on a full-screen-Space app (e.g. full-screen Safari), after
onboarding, press ⌥⌃ several times → the notch must appear **in place** without switching Spaces. (Clicking
the Dock icon *will* switch to `main` — that is the user explicitly asking to open Kairo, not a regression.)

### Dock-menu fallback
The Dock right-click menu (Step 5) is the one genuinely-new native surface and the only risky part
(delegate-only API, must reach into Tauri's delegate). Treat it as nice-to-have; the must-have is
left-click-opens-home. If the objc2 hook is fragile, ship the fallback (tray menu + left-click) and revisit.

### ⌘Q must stay quittable
Do **not** add a blanket `ExitRequested → prevent_exit()` (see Step 3 note): ⌘Q arrives as
`ExitRequested { code: None }`, indistinguishable from a last-window-close, so guarding on `code.is_none()`
would break quitting. The `CloseRequested → hide` approach is the correct, ⌘Q-safe mechanism. Verify ⌘Q
actually quits after the change.

### App menu
Once Regular, Tauri v2 auto-installs the default macOS menu (App/File/Edit/View/Window/Help), and the App
submenu provides Quit ⌘Q — so ⌘Q works with **no** code. Customizing copy (About Kairo / Settings…) is
deferred (parent spec §A.4). If for any reason the default menu doesn't appear on the signed build, set it
explicitly with `app.set_menu(tauri::menu::Menu::default(app.handle())?)?;` in `setup()` — but verify first;
don't add it pre-emptively.

### Signing / entitlements
No `Info.plist`, `tauri.conf.json`, or `Entitlements.plist` changes — this is a pure Rust code change, so no
new TCC prompts and no new entitlements. `codesign --verify --deep --strict` must still pass (the
`Kairo Tutor Local Dev` identity signs the same bundle shape). Verify after the build.

---

## Verification

### Automated (per `AGENTS.md`)
```bash
npm run typecheck
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --bundles app
codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/Kairo Tutor.app"
```
Watch `~/Library/Logs/Kairo/kairo-latest.log` for the new lines: `activation policy: regular (always)`,
`close requested → hidden (app stays alive)`, `dock reopen → show main`, and (if step 5) `dock menu
installed`.

### Manual (the Phase-A checklist — §A.8)
1. **Dock icon appears**; Kairo shows in **⌘-Tab**; the **app menu** is present in the menu bar.
2. **Left-click Dock** (with `main` hidden) → `main` opens + focuses; log shows `dock reopen → show main`.
3. **Right-click Dock** → the option menu (or, if deferred, confirm the fallback: tray menu + left-click open works).
4. **Red-close `main`** → window hides, **app stays alive** (Dock icon + menu-bar item still there; ⌥⌃ notch still works); log shows `close requested → hidden`.
5. **⌘Q** (and tray "Quit Kairo") → app actually quits.
6. **Full-screen-Space test (the §A.7 gotcha):** on a full-screen Space, after onboarding, repeated ⌥⌃ notch show/hide does **not** switch Spaces. (First cold launch fronting Kairo *is* expected to switch — that's the accepted cold-launch yank.)
7. **`codesign --verify --deep --strict`** passes; no new entitlements/Info.plist keys.

### Full onboarding walk
Run the reset script in `AGENTS.md` (tccutil resets + delete markers), backend up (`npm run server:dev`),
and walk onboarding end-to-end to confirm the removed onboarding policy-flips didn't regress the flow
(onboarding window still fronts; Act 3 System-Settings hand-off still works; finish + replay still behave).

---

## Commit breakdown

Small, revertible commits on `main` (do **not** batch; per `AGENTS.md`). Suggested order:

1. **`refactor(app): always run Regular — drop the Accessory flip-flop`**
   Step 1 (lib.rs:681-695 → explicit Regular + klog) + Step 2 (remove `onboarding.rs` policy flips at 100 / 207-210 / 226-229) + Step 6 (rewrite stale `Accessory` comments at lib.rs:459-462 / 796-797 / 814-815, onboarding.rs:186). Build + `cargo check`; confirm Dock icon + app menu + ⌘-Tab appear and ⌘Q quits.

2. **`feat(app): red-close hides the home window, app stays alive`**
   Step 3 (`main` `on_window_event` → `prevent_close` + `hide` + klog; add `WindowEvent` import). Verify red-close hides and the notch still works; ⌘Q still quits.

3. **`feat(app): open the home window from the Dock icon (RunEvent::Reopen)`**
   Step 4 (convert `.run(context)` → `.build(context)?.run(closure)`, handle `RunEvent::Reopen`). Verify left-click Dock shows `main`.

4. **`feat(app): Dock right-click menu (objc2 applicationDockMenu)`** — *nice-to-have, may be deferred.*
   Step 5. If the objc2 delegate hook proves fragile, drop this commit and keep the fallback (documented in §Edge cases). Verify right-click Dock shows the option menu and each item routes through the shared tray handlers.

After each commit: `npm run typecheck && npm run test && cargo check --manifest-path src-tauri/Cargo.toml`,
then `npm run tauri:build -- --bundles app` + `codesign --verify --deep --strict`.
