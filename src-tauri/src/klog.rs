//! Universal, non-blocking logger for Kairo (developer-facing; debugging + telemetry).
//!
//! Design goals (see docs/superpowers/specs/2026-07-03-universal-logger-and-claude-md-design.md):
//! - Zero impact on hot threads. A log call only formats + hands the line to an
//!   in-memory channel; a dedicated background thread does the file I/O. If the
//!   channel is full the line is DROPPED (lossy), never blocking the caller.
//! - One persistent file per day under `~/Library/Logs/Kairo/`, surviving runs.
//! - Everything — Rust subsystems AND every frontend WebView — lands in one file.
//!
//! Usage from anywhere in the crate:
//!   klog!(vision, info, count = boxes.len(), "detected element boxes");
//!   klog!(audio, error, "audio stream error: {err}");
//!   let _t = klog::timer("timing", "gate_turn"); // logs `ms=` on drop
//!
//! Fields come first, the message literal comes LAST (tracing's grammar). Never log
//! secrets or raw media — use the redaction helpers (`transcript_field`, size fields).

use std::sync::OnceLock;
use std::time::Instant;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Keeps the background writer alive for the whole process. Dropping this flushes
/// and stops the writer thread, so it must live as long as the app.
static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Emit a structured event under a subsystem `target`. Prefer the ergonomic
/// `klog!(subsystem, level, field = val, "message")` form below.
// All Kairo subsystems log under a `kairo::<subsystem>` target so one directive
// (`kairo=debug`) turns our logs verbose while third-party crates (hyper, wry,
// reqwest, …) stay quiet at the root level. See `constants::LOG_FILTER`.
#[macro_export]
macro_rules! klog {
    ($sub:ident, error, $($rest:tt)*) => { tracing::error!(target: concat!("kairo::", stringify!($sub)), $($rest)*) };
    ($sub:ident, warn,  $($rest:tt)*) => { tracing::warn!(target: concat!("kairo::", stringify!($sub)), $($rest)*) };
    ($sub:ident, info,  $($rest:tt)*) => { tracing::info!(target: concat!("kairo::", stringify!($sub)), $($rest)*) };
    ($sub:ident, debug, $($rest:tt)*) => { tracing::debug!(target: concat!("kairo::", stringify!($sub)), $($rest)*) };
    ($sub:ident, trace, $($rest:tt)*) => { tracing::trace!(target: concat!("kairo::", stringify!($sub)), $($rest)*) };
}

/// Install the global logger. Call ONCE, first thing in `run()`, before any
/// subsystem starts. Never panics — on any failure it degrades (temp dir, then
/// stderr-only) so logging can never crash the app.
pub(crate) fn init() {
    // Directive string, RUST_LOG-style. Default lives in `constants::LOG_FILTER`
    // (everything at INFO, our `kairo::*` subsystems at DEBUG). `KAIRO_LOG` still
    // overrides at runtime, e.g. `KAIRO_LOG=info,kairo::vision=trace,kairo::mic=warn`
    // or `KAIRO_LOG=debug` (everything, incl. deps).
    let directives = crate::env::provider_env("KAIRO_LOG", crate::constants::LOG_FILTER);
    // Never fail on a bad directive — fall back to the default filter.
    let make_filter = || {
        EnvFilter::try_new(&directives).unwrap_or_else(|_| EnvFilter::new(crate::constants::LOG_FILTER))
    };

    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);

    // Daily-rotated file, keep the last 7. Files are named `kairo.YYYY-MM-DD.log`.
    let file_layer = match RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("kairo")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&dir)
    {
        Ok(appender) => {
            // Non-blocking + lossy: full buffer drops lines instead of blocking a
            // hot thread. The guard must outlive the process (stored below).
            let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
                .lossy(true)
                .buffered_lines_limit(16_384)
                .finish(appender);
            let _ = GUARD.set(guard);
            refresh_latest_symlink(&dir);
            Some(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer)
                    .with_ansi(false)
                    .with_target(true),
            )
        }
        Err(_) => None,
    };

    // Optional stderr mirror (off by default — the packaged .app launched via
    // `open` has no useful stderr, and we avoid any blocking write on a hot path).
    // Toggle in `constants::LOG_TO_STDERR`.
    let stderr_layer = if crate::constants::LOG_TO_STDERR {
        Some(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(true)
                .with_target(true),
        )
    } else {
        None
    };

    // `try_init` returns Err if a global subscriber already exists (e.g. a second
    // call). Either way we must not panic.
    let _ = tracing_subscriber::registry()
        .with(make_filter())
        .with(file_layer)
        .with(stderr_layer)
        .try_init();

    klog!(app, info, dir = %dir.display(), "logger ready");
}

/// `~/Library/Logs/Kairo`, or the system temp dir if HOME is unavailable.
fn log_dir() -> std::path::PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(home).join("Library/Logs/Kairo");
    }
    std::env::temp_dir().join("Kairo")
}

/// Best-effort stable path: `kairo-latest.log -> kairo.<today>.log`. The target
/// may not exist until the first line is written; a dangling symlink is fine and
/// resolves once the appender creates today's file (use `tail -F` to follow it).
#[cfg(unix)]
fn refresh_latest_symlink(dir: &std::path::Path) {
    let link = dir.join("kairo-latest.log");
    let target = format!("kairo.{}.log", today_utc_date());
    let _ = std::fs::remove_file(&link);
    let _ = std::os::unix::fs::symlink(&target, &link);
}

#[cfg(not(unix))]
fn refresh_latest_symlink(_dir: &std::path::Path) {}

/// Today's UTC date as `YYYY-MM-DD`, computed from the epoch without pulling in a
/// date crate (Howard Hinnant's civil-from-days). Matches tracing-appender's
/// daily filename so the symlink target lines up.
fn today_utc_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// RAII stopwatch. Hold it in a function scope; on drop it logs the elapsed
/// milliseconds under the `timing` subsystem at DEBUG (`sub`/`op` as fields).
/// Works across `.await`. Filter with `KAIRO_LOG=timing=debug`.
pub(crate) struct Timer {
    sub: &'static str,
    op: &'static str,
    start: Instant,
}

pub(crate) fn timer(sub: &'static str, op: &'static str) -> Timer {
    Timer {
        sub,
        op,
        start: Instant::now(),
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_millis();
        tracing::debug!(target: "kairo::timing", sub = self.sub, op = self.op, ms = ms, "elapsed");
    }
}

/// Format a transcript for logging. Returns the full text when
/// `constants::LOG_TRANSCRIPTS` is true (the default — this is a local dev tool and
/// the log file is our primary debugging surface), otherwise metadata-only
/// (`len=N`). Never log raw audio, screenshot pixels/base64, or secrets — pass
/// byte/size counts instead.
pub(crate) fn transcript_field(text: &str) -> String {
    if crate::constants::LOG_TRANSCRIPTS {
        text.to_string()
    } else {
        format!("len={}", text.chars().count())
    }
}

/// Route a frontend WebView log line into the same file. Called by the
/// `debug_log_batch` Tauri command. `target` is the fixed `kairo::frontend`; the
/// WebView and the frontend's own subsystem ride as fields.
pub(crate) fn frontend(level: &str, webview: &str, sub: &str, message: &str) {
    match level {
        "error" => tracing::error!(target: "kairo::frontend", webview, sub, "{message}"),
        "warn" => tracing::warn!(target: "kairo::frontend", webview, sub, "{message}"),
        "debug" => tracing::debug!(target: "kairo::frontend", webview, sub, "{message}"),
        "trace" => tracing::trace!(target: "kairo::frontend", webview, sub, "{message}"),
        _ => tracing::info!(target: "kairo::frontend", webview, sub, "{message}"),
    }
}
