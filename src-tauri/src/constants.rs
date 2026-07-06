//! Central non-secret configuration. **Edit this file** (it is committed to git and
//! shared across collaborators) instead of adding environment variables.
//!
//! The rule:
//!   - **Secrets** (API keys) live in `.env` — never here. They differ per person
//!     and must not be committed.
//!   - **Everything else** (providers, models, base URLs, timeouts, tuning, toggles,
//!     logging) lives here, so a teammate only needs their API keys in `.env` to run.
//!
//! This is the *native* config home. The frontend mirror is the zod defaults in
//! `src/config/env.ts` — keep the two in sync when you change a value used by both
//! (provider selection, model names). See CLAUDE.md → "Configuration".
//!
//! For the few provider/model values, the env var of the same name still overrides
//! at runtime if set — but you never need to set it; the value below is the default.
//! The timeouts, toggles, and logging flags are read directly (no env).

// ---------------------------------------------------------------- Providers
pub(crate) const AI_PROVIDER: &str = "openrouter"; // gate + tutor turns
pub(crate) const STT_PROVIDER: &str = "sarvam"; // sarvam | elevenlabs | mock
pub(crate) const TTS_PROVIDER: &str = "sarvam";
pub(crate) const GROUNDING_PROVIDER: &str = "anthropic"; // anthropic | openrouter | qwen

// ---------------------------------------------------------------- OpenRouter
// Drives the gate (every ask) + text turns. Keep this a FAST model — Flash Lite
// has thinking off by default, so the gate answers in ~1-2s instead of qwen's ~10s.
pub(crate) const OPENROUTER_MODEL: &str = "google/gemini-2.5-flash-lite";
pub(crate) const OPENROUTER_VISION_MODEL: &str = "google/gemini-2.5-flash"; // legacy 2-call path
// Output cap for the OpenAI-compatible grounding path (OpenRouter/Qwen). A separate
// provider with NO always-on thinking, so it stays small — kept distinct from the
// Anthropic cap on purpose (do not merge the two).
pub(crate) const OPENROUTER_VISION_MAX_TOKENS: u32 = 1024;
pub(crate) const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub(crate) const OPENROUTER_SITE_URL: &str = "https://kairo.tutor";
pub(crate) const OPENROUTER_APP_TITLE: &str = "Kairo Tutor";

// ---------------------------------------------------------------- Anthropic
pub(crate) const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub(crate) const ANTHROPIC_VISION_MODEL: &str = "claude-fable-5"; // Opus/Fable grounding
pub(crate) const TUTOR_VISION_MODEL: &str = "claude-fable-5"; // single-call answer + box
// ONE output cap for BOTH Anthropic vision calls (single-call answer+box AND the
// separate box-detection call) — deliberately a single knob to avoid confusion.
// Fable thinks on every request and thinking counts against max_tokens, so a tight
// 1200 truncated the JSON on think-heavy asks. 3000 gives a full 5–7 step walkthrough
// room after thinking (still bounded by GROUNDING_TIMEOUT_MS).
pub(crate) const ANTHROPIC_VISION_MAX_TOKENS: u32 = 3000;
// Throttles Fable's thinking depth (low | medium | high | xhigh | max). GA, no beta
// header. `medium` keeps box coordinates accurate while cutting the thinking that
// drove the 21s latency; drop to `low` for more speed, raise for more accuracy.
pub(crate) const ANTHROPIC_VISION_EFFORT: &str = "medium";

// ------------------------------------------- Alt grounding (when selected)
pub(crate) const OPENROUTER_GROUNDING_MODEL: &str = "qwen/qwen3.7-plus";
pub(crate) const QWEN_VISION_MODEL: &str = "qwen3.7-plus";
pub(crate) const QWEN_BASE_URL: &str = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

// ---------------------------------------------------------------- Sarvam speech
pub(crate) const SARVAM_BASE_URL: &str = "https://api.sarvam.ai";
pub(crate) const SARVAM_STT_MODEL: &str = "saaras:v3";
pub(crate) const SARVAM_STT_MODE: &str = "transcribe";
// "unknown" = auto-detect across all 23 languages (22 Indian + English). saaras:v3
// then returns the detected language_code + a confidence in the response. Forcing a
// single language (e.g. en-IN) is what garbled accented/mixed English.
pub(crate) const SARVAM_STT_LANGUAGE_CODE: &str = "unknown";
pub(crate) const SARVAM_TTS_MODEL: &str = "bulbul:v3";
pub(crate) const SARVAM_TTS_LANGUAGE_CODE: &str = "en-IN";
pub(crate) const SARVAM_TTS_SPEAKER: &str = "shubh";

// ---------------------------------------------------------------- ElevenLabs speech
pub(crate) const ELEVENLABS_BASE_URL: &str = "https://api.elevenlabs.io";
pub(crate) const ELEVENLABS_STT_MODEL: &str = "scribe_v1";
pub(crate) const ELEVENLABS_TTS_MODEL: &str = "eleven_multilingual_v2";
pub(crate) const ELEVENLABS_VOICE_ID: &str = "EXAVITQu4vr4xnSDxMaL";

// ---------------------------------------------------------------- Timeouts (ms)
pub(crate) const OPENROUTER_REQUEST_TIMEOUT_MS: u64 = 45_000;
// The gate runs on EVERY ask. 3_500 was too tight — a slow gate response timed out
// and defaulted to "look at the screen", producing screen-flavored answers to plain
// questions. 12s gives the gate model room to answer.
pub(crate) const GATE_TIMEOUT_MS: u64 = 12_000;
pub(crate) const GROUNDING_TIMEOUT_MS: u64 = 15_000;
// Default per-request cap on a TTS synthesis (the full direct answer / filler). A
// long paragraph legitimately takes a while, so this stays generous; walkthrough
// STEP synths pass a tighter override (they retry on failure).
pub(crate) const TTS_TIMEOUT_MS: u64 = 45_000;
// (Walkthrough step synths pass a tighter per-request override from the frontend —
// see STEP_SYNTH_TIMEOUT_MS in src/notch — so there's no step-specific constant here.)

// ---------------------------------------------------------------- Vision tuning
pub(crate) const VISION_MAX_EDGE: u32 = 1568; // longest screenshot edge sent to the model

// Max steps in one tutor answer. `single` = 1 step (a direct answer); `steps` = a
// short narrated walkthrough. Capped so a turn stays snappy and grounding stays
// accurate (more boxes/call = each less precise). Step gap + history-turns are UI
// concerns and live on the frontend (src/notch).
pub(crate) const MAX_TUTOR_STEPS: usize = 7;

// ---------------------------------------------------------------- Toggles
pub(crate) const SEPARATE_GROUNDING: bool = false; // true = legacy 2-call (OpenRouter answer + Opus/Fable box)
// Whether Kairo's OWN UI (notch, pet cursor, guidance box) shows up in screen
// captures/recordings AND the tutor's own screenshot. Overridable at BUILD time via
// KAIRO_SHOW_IN_CAPTURE (build.rs declares rerun-if-env-changed so a changed value
// recompiles). Default `true` = demo-visible for local dev. The production DMG build
// (scripts/build-dmg.sh → `npm run dist`) sets KAIRO_SHOW_IN_CAPTURE=false so real
// users never get Kairo's UI in their captures and the AI's screenshot stays clean.
// Pen marks are UNAFFECTED either way — they're always included via the mode-based
// rule in panels.rs (`shows_user_marks`).
const fn str_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
pub(crate) const SHOW_IN_CAPTURE: bool = match option_env!("KAIRO_SHOW_IN_CAPTURE") {
    // Off only when explicitly disabled (the production DMG build sets "false").
    Some(v) => !(str_eq(v, "false") || str_eq(v, "0")),
    None => true, // unset → dev/demo default
};

// ---------------------------------------------------------------- Logging
// Log the actual transcript + answer TEXT (not just lengths). Intentionally ON:
// this is a local dev tool and the log file is our primary debugging surface. No env
// var needed. Set to false to log lengths only.
pub(crate) const LOG_TRANSCRIPTS: bool = true;
pub(crate) const LOG_TO_STDERR: bool = false;
// Default verbosity filter (tracing EnvFilter syntax). KAIRO_LOG still overrides.
pub(crate) const LOG_FILTER: &str = "info,kairo=debug";

// ---------------------------------------------------------------- PTT (push-to-talk)
pub(crate) const PTT_TAP_MAX_MS: u64 = 250; // hold < this = tap (→ typing); >= = talk
pub(crate) const PTT_RELEASE_SETTLE_MS: u64 = 60; // absorb a modifier key-bounce shorter than this
pub(crate) const PTT_MAX_RECORD_MS: u64 = 30_000; // hard cap: auto-send a runaway hold (keeps WAV under STT limit)
