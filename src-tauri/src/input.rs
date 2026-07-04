//! Global input watchers: the context-reset poll + scroll/click tap that clear
//! stale guidance when the user moves on, and the ⌥⌃ push-to-talk tap.

use crate::audio::send_audio_command;
use crate::constants;
use crate::panels::{listening_notch_payload, show_notch_with_payload, typing_notch_payload};
use crate::platform::{frontmost_bundle_id, frontmost_window_title};
use crate::{AudioCommand, ContextWatch, NotchState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// Keep classify_press + PttOutcome (used by ptt_commit). Threshold now from constants.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PttOutcome {
    Tap,
    Hold,
}

pub(crate) fn classify_press(held: Duration, tap_max_ms: u64) -> PttOutcome {
    if held < Duration::from_millis(tap_max_ms) {
        PttOutcome::Tap
    } else {
        PttOutcome::Hold
    }
}

const KAIRO_BUNDLE_ID: &str = "com.kairo.tutor";
// Ignore activity for the first moment after arming so the reveal itself (or the
// click/key that triggered the ask) never counts as "the user moved on".
const CONTEXT_SETTLE_MS: u64 = 500;

// True only when armed AND past the settle window — the single gate every watcher
// checks before firing.
fn context_watch_settled(watch: &ContextWatch) -> bool {
    if !watch.armed.load(Ordering::SeqCst) {
        return false;
    }
    watch
        .armed_at
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|at| at.elapsed() >= Duration::from_millis(CONTEXT_SETTLE_MS))
        .unwrap_or(false)
}

// Disarm and tell the notch exactly once per armed session. `swap` makes it
// one-shot even if the poll and the input tap fire in the same instant.
fn fire_context_reset(app: &tauri::AppHandle, watch: &ContextWatch, reason: &str) {
    if watch.armed.swap(false, Ordering::SeqCst) {
        let _ = app.emit("context:changed", reason.to_string());
    }
}

// Low-frequency poll (only costs anything while armed) that catches app switches
// and tab/page changes: the frontmost bundle id changing, or the front window
// title changing within the same app. Covers keyboard-driven switches (Cmd+Tab,
// Cmd+number) that the input tap deliberately doesn't listen for.
pub(crate) fn spawn_context_poll(app: &tauri::AppHandle, watch: ContextWatch) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(450));
        if !context_watch_settled(&watch) {
            continue;
        }
        let Some((base_bundle, base_title)) =
            watch.baseline.lock().ok().and_then(|guard| guard.clone())
        else {
            continue;
        };
        let cur_bundle = frontmost_bundle_id().unwrap_or_default();
        // Our own non-activating panels shouldn't take frontmost, but never let
        // Kairo's own UI count as the user switching away.
        if cur_bundle == KAIRO_BUNDLE_ID {
            continue;
        }
        let switched_app =
            !base_bundle.is_empty() && !cur_bundle.is_empty() && cur_bundle != base_bundle;
        if switched_app {
            fire_context_reset(&app, &watch, "app-switch");
            continue;
        }
        let cur_title = frontmost_window_title().unwrap_or_default();
        let changed_title =
            !base_title.is_empty() && !cur_title.is_empty() && cur_title != base_title;
        if changed_title {
            fire_context_reset(&app, &watch, "window-change");
        }
    });
}

// Listen-only global event tap for scroll + mouse-down (NOT mouse-moved, so
// moving toward the target is never a reset, and NOT keyDown, so this needs only
// the Accessibility grant Kairo already has — no Input Monitoring prompt). If the
// tap can't be created it degrades gracefully; the poll above still covers
// app/tab switches.
pub(crate) fn spawn_context_input_tap(app: &tauri::AppHandle, watch: ContextWatch) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult,
    };

    let app = app.clone();
    std::thread::spawn(move || {
        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![
                CGEventType::ScrollWheel,
                CGEventType::LeftMouseDown,
                CGEventType::RightMouseDown,
                CGEventType::OtherMouseDown,
            ],
            move |_proxy, _event_type, _event| {
                if context_watch_settled(&watch) {
                    fire_context_reset(&app, &watch, "input");
                }
                // Listen-only: never modify the event stream, always keep the event.
                CallbackResult::Keep
            },
        );
        let Ok(tap) = tap else {
            crate::klog!(input, warn, "event tap unavailable; scroll/click reset disabled (app/tab switch reset still works)");
            return;
        };
        // Standard CGEventTap → CFRunLoop wiring. run_current() blocks this
        // dedicated thread for the process lifetime, keeping the tap alive.
        unsafe {
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                crate::klog!(input, error, "failed to create event-tap runloop source");
                return;
            };
            CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
            tap.enable();
            CFRunLoop::run_current();
        }
    });
}

// Raw chord edges forwarded from the event tap to the controller.
enum PttEvent {
    Down(Instant),
    Up(Instant),
}
// A controller wakeup: either an edge, or a timer deadline elapsed.
enum Wake {
    Event(PttEvent),
    Timeout,
}

// The PTT state machine. `promoted` = the "listening" UI has been shown (hold confirmed).
#[derive(Debug)]
enum PttState {
    Idle,
    Recording {
        started: Instant,
        promoted: bool,
    },
    Releasing {
        started: Instant,
        released: Instant,
        promoted: bool,
    },
}

// Side effect the controller must perform after a transition. Pure state logic
// decides the action; the controller executes it. Kept separate so the transition
// table is unit-testable without a running app/mic.
#[derive(Debug, PartialEq)]
enum PttAction {
    None,
    StartCapture,
    Promote,
    Commit { held: Duration },
}

// PURE transition. Exactly one StartCapture (Idle+Down) and one Commit (release
// settle OR max-record) per logical press — a stream can never leak or double-send.
// A re-Down while Releasing (key bounce) resumes the SAME recording (no new Start).
fn ptt_transition(state: PttState, wake: Wake) -> (PttState, PttAction) {
    match (state, wake) {
        (PttState::Idle, Wake::Event(PttEvent::Down(t))) => (
            PttState::Recording {
                started: t,
                promoted: false,
            },
            PttAction::StartCapture,
        ),
        (PttState::Idle, _) => (PttState::Idle, PttAction::None),

        // promote at the tap/hold threshold (only if still held, not yet released)
        (
            PttState::Recording {
                started,
                promoted: false,
            },
            Wake::Timeout,
        ) => (
            PttState::Recording {
                started,
                promoted: true,
            },
            PttAction::Promote,
        ),
        // runaway guard: a hold longer than PTT_MAX_RECORD_MS is auto-sent
        (
            PttState::Recording {
                started,
                promoted: true,
            },
            Wake::Timeout,
        ) => (
            PttState::Idle,
            PttAction::Commit {
                held: started.elapsed(),
            },
        ),
        (PttState::Recording { started, promoted }, Wake::Event(PttEvent::Up(t))) => (
            PttState::Releasing {
                started,
                released: t,
                promoted,
            },
            PttAction::None,
        ),
        (PttState::Recording { started, promoted }, Wake::Event(PttEvent::Down(_))) => (
            PttState::Recording { started, promoted },
            PttAction::None,
        ),

        // key-bounce: re-down within the settle window resumes the same recording
        (
            PttState::Releasing {
                started, promoted, ..
            },
            Wake::Event(PttEvent::Down(_)),
        ) => (
            PttState::Recording { started, promoted },
            PttAction::None,
        ),
        (
            PttState::Releasing {
                started,
                released,
                promoted,
            },
            Wake::Event(PttEvent::Up(_)),
        ) => (
            PttState::Releasing {
                started,
                released,
                promoted,
            },
            PttAction::None,
        ),
        // settle elapsed with no re-down → commit (tap vs hold decided in ptt_commit)
        (
            PttState::Releasing {
                started, released, ..
            },
            Wake::Timeout,
        ) => (
            PttState::Idle,
            PttAction::Commit {
                held: released.duration_since(started),
            },
        ),
    }
}

fn recv_until(rx: &Receiver<PttEvent>, deadline: Instant) -> Option<Wake> {
    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(ev) => Some(Wake::Event(ev)),
        Err(RecvTimeoutError::Timeout) => Some(Wake::Timeout),
        Err(RecvTimeoutError::Disconnected) => None,
    }
}

// Show the "listening" UI: cursor halo + notch capsule + the recording-truth event
// (the frontend `shouldIdleClose` guard keys off this so the capsule can't auto-hide).
fn ptt_promote(app: &tauri::AppHandle) {
    crate::klog!(ptt, info, "hold confirmed → listening");
    let _ = app.emit("cursor:listening", ());
    let _ = app.emit("ptt:recording", serde_json::json!({ "active": true }));
    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let notch_state = app_main.state::<NotchState>();
        if let Err(error) =
            show_notch_with_payload(&app_main, notch_state.inner(), Some(listening_notch_payload()))
        {
            crate::klog!(ptt, error, "failed to show notch: {error}");
        }
    });
}

fn ptt_commit(app: &tauri::AppHandle, held: Duration) {
    let _ = app.emit("ptt:recording", serde_json::json!({ "active": false }));
    match classify_press(held, constants::PTT_TAP_MAX_MS) {
        PttOutcome::Tap => {
            crate::klog!(ptt, info, ms = held.as_millis(), "tap → typing");
            send_audio_command(app, AudioCommand::Cancel);
            let _ = app.emit("cursor:idle", ());
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                let notch_state = app_main.state::<NotchState>();
                if let Err(error) = show_notch_with_payload(
                    &app_main,
                    notch_state.inner(),
                    Some(typing_notch_payload()),
                ) {
                    crate::klog!(ptt, error, "failed to show typing notch: {error}");
                }
                let _ = app_main.emit("notch:focus-input", ());
            });
        }
        PttOutcome::Hold => {
            crate::klog!(ptt, info, ms = held.as_millis(), "hold → send");
            send_audio_command(app, AudioCommand::Stop);
            let _ = app.emit("cursor:thinking", ());
        }
    }
}

// The controller thread: owns the state machine, serial + single-owner. Timers are
// `recv_timeout` deadlines, so there are NO per-edge spawned threads and NO shared
// atomics to race. Guarantees one Start per press + one Stop/Cancel per release.
fn spawn_ptt_controller(app: tauri::AppHandle, rx: Receiver<PttEvent>) {
    std::thread::spawn(move || {
        let mut state = PttState::Idle;
        loop {
            let wake = match &state {
                PttState::Idle => rx.recv().ok().map(Wake::Event),
                PttState::Recording { started, promoted } => {
                    let ms = if *promoted {
                        constants::PTT_MAX_RECORD_MS
                    } else {
                        constants::PTT_TAP_MAX_MS
                    };
                    recv_until(&rx, *started + Duration::from_millis(ms))
                }
                PttState::Releasing { released, .. } => recv_until(
                    &rx,
                    *released + Duration::from_millis(constants::PTT_RELEASE_SETTLE_MS),
                ),
            };
            let Some(wake) = wake else {
                crate::klog!(ptt, warn, "PTT controller channel closed; exiting");
                break;
            };
            let is_max_record = matches!(
                (&state, &wake),
                (
                    PttState::Recording { promoted: true, .. },
                    Wake::Timeout
                )
            );
            let (next, action) = ptt_transition(state, wake);
            state = next;
            match action {
                PttAction::None => {}
                PttAction::StartCapture => {
                    crate::klog!(ptt, info, "⌥⌃ down");
                    send_audio_command(&app, AudioCommand::Start(Instant::now()));
                }
                PttAction::Promote => ptt_promote(&app),
                PttAction::Commit { held } => {
                    if is_max_record {
                        crate::klog!(ptt, warn, ms = held.as_millis(), "max record reached → auto-send");
                    }
                    ptt_commit(&app, held);
                }
            }
        }
    });
}

// Thin event tap: forward clean ⌥⌃ Down/Up edges to the controller. Owns nothing
// but a local edge-detector; all timing/state lives in the controller.
pub(crate) fn spawn_ptt(app: &tauri::AppHandle) {
    let (tx, rx) = channel::<PttEvent>();
    spawn_ptt_controller(app.clone(), rx);
    spawn_ptt_tap(tx);
}

fn spawn_ptt_tap(tx: Sender<PttEvent>) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult,
    };
    std::thread::spawn(move || {
        let chord_down = AtomicBool::new(false);
        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged],
            move |_proxy, _event_type, event| {
                let flags = event.get_flags();
                let both = flags.contains(CGEventFlags::CGEventFlagAlternate)
                    && flags.contains(CGEventFlags::CGEventFlagControl);
                let was = chord_down.swap(both, Ordering::SeqCst);
                if both && !was {
                    let _ = tx.send(PttEvent::Down(Instant::now()));
                } else if !both && was {
                    let _ = tx.send(PttEvent::Up(Instant::now()));
                }
                CallbackResult::Keep
            },
        );
        let Ok(tap) = tap else {
            crate::klog!(ptt, warn, "tap unavailable; grant Input Monitoring + relaunch to enable ⌥⌃");
            return;
        };
        unsafe {
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                crate::klog!(ptt, error, "failed to create PTT runloop source");
                return;
            };
            CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
            tap.enable();
            CFRunLoop::run_current();
        }
    });
}

#[cfg(test)]
mod ptt_tests {
    use super::*;

    #[test]
    fn quick_press_is_a_tap() {
        assert_eq!(classify_press(Duration::from_millis(120), 250), PttOutcome::Tap);
    }
    #[test]
    fn at_or_over_threshold_is_a_hold() {
        assert_eq!(classify_press(Duration::from_millis(250), 250), PttOutcome::Hold);
    }
    #[test]
    fn idle_down_starts_capture_once() {
        let (s, a) = ptt_transition(PttState::Idle, Wake::Event(PttEvent::Down(Instant::now())));
        assert_eq!(a, PttAction::StartCapture);
        assert!(matches!(s, PttState::Recording { promoted: false, .. }));
    }
    #[test]
    fn recording_threshold_promotes() {
        let (s, a) = ptt_transition(
            PttState::Recording { started: Instant::now(), promoted: false }, Wake::Timeout);
        assert_eq!(a, PttAction::Promote);
        assert!(matches!(s, PttState::Recording { promoted: true, .. }));
    }
    #[test]
    fn release_bounce_resumes_same_recording_no_new_start() {
        let t = Instant::now();
        let (s, a) = ptt_transition(
            PttState::Releasing { started: t, released: t, promoted: true },
            Wake::Event(PttEvent::Down(t)));
        assert_eq!(a, PttAction::None); // NOT StartCapture — the stream keeps running
        assert!(matches!(s, PttState::Recording { promoted: true, .. }));
    }
    #[test]
    fn release_settle_commits_and_returns_idle() {
        let t = Instant::now();
        let (s, a) = ptt_transition(
            PttState::Releasing { started: t, released: t, promoted: true }, Wake::Timeout);
        assert!(matches!(a, PttAction::Commit { .. }));
        assert!(matches!(s, PttState::Idle));
    }
    #[test]
    fn max_record_commits_and_returns_idle() {
        let (s, a) = ptt_transition(
            PttState::Recording { started: Instant::now(), promoted: true }, Wake::Timeout);
        assert!(matches!(a, PttAction::Commit { .. }));
        assert!(matches!(s, PttState::Idle));
    }
}
