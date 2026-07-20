//! Native microphone capture (cpal) for push-to-talk: device selection, WAV
//! encoding, the capture thread, and the command channel.

use crate::{AudioCapture, AudioCommand};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// Pick the real built-in microphone. The OS *default* input on this machine is a
// silent virtual device (BlackHole), so `default_input_device()` would capture
// silence — mirror the WebView fix and skip known virtual/loopback devices.
pub(crate) fn pick_input_device(host: &cpal::Host) -> Option<cpal::Device> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let is_virtual = |name: &str| {
        let n = name.to_lowercase();
        n.contains("blackhole")
            || n.contains("soundflower")
            || n.contains("loopback")
            || n.contains("aggregate")
            || n.contains("multi-output")
            || n.contains("virtual")
            || n.contains("vb-audio")
            || n.contains("ishowu")
    };
    let devices: Vec<cpal::Device> = host
        .input_devices()
        .map(|iter| iter.collect())
        .unwrap_or_default();
    // 1) an explicitly built-in mic
    for device in &devices {
        if let Ok(name) = device.name() {
            let n = name.to_lowercase();
            if !is_virtual(&n)
                && (n.contains("macbook")
                    || n.contains("built-in")
                    || n.contains("built in")
                    || n.contains("internal")
                    || n.contains("microphone"))
            {
                return Some(device.clone());
            }
        }
    }
    // 2) any non-virtual input
    for device in &devices {
        if let Ok(name) = device.name() {
            if !is_virtual(&name.to_lowercase()) {
                return Some(device.clone());
            }
        }
    }
    // 3) last resort: whatever the OS default is
    host.default_input_device()
}

// Append captured frames as mono to the shared buffer and update the live level.
pub(crate) fn append_mono(
    samples: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
    data: &[f32],
    channels: usize,
) {
    let mut sum_sq = 0.0f32;
    let mut count = 0usize;
    if let Ok(mut buf) = samples.lock() {
        if channels <= 1 {
            buf.extend_from_slice(data);
            for &s in data {
                sum_sq += s * s;
            }
            count = data.len();
        } else {
            for frame in data.chunks(channels) {
                let mixed = frame.iter().sum::<f32>() / channels as f32;
                buf.push(mixed);
                sum_sq += mixed * mixed;
                count += 1;
            }
        }
    }
    if count > 0 {
        let rms = (sum_sq / count as f32).sqrt();
        let norm = (rms / 0.15).min(1.0);
        level.store(norm.to_bits(), Ordering::SeqCst);
    }
}

// Minimal mono 16-bit PCM WAV encoder (no extra dependency).
pub(crate) fn encode_wav_mono(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let byte_rate = sample_rate * 2;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

// Build the mic input stream. IMPORTANT: cpal's coreaudio backend AUTO-STARTS the
// AudioUnit inside `build_input_stream` — the returned stream is already capturing,
// it is NOT armed-and-idle. So the caller must `pause()` it if capture shouldn't
// begin yet. Two safety rails live here:
//   * the data callback appends ONLY while `recording` is set, so the unavoidable
//     window between build (auto-start) and the first play()/pause() can never
//     bleed stray samples into the buffer;
//   * the error callback flags `faulted`, so the worker rebuilds against the
//     current device after an unplug / default-device switch.
// Returns the stream + its sample rate.
pub(crate) fn build_gated_input(
    host: &cpal::Host,
    samples: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
    recording: &Arc<AtomicBool>,
    faulted: &Arc<AtomicBool>,
) -> Option<(cpal::Stream, u32)> {
    use cpal::traits::DeviceTrait;
    let device = pick_input_device(host)?;
    let config = device.default_input_config().ok()?;
    let sample_format = config.sample_format();
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.into();
    let (s1, l1, r1) = (samples.clone(), level.clone(), recording.clone());
    let (s2, l2, r2) = (samples.clone(), level.clone(), recording.clone());
    let (s3, l3, r3) = (samples.clone(), level.clone(), recording.clone());
    let fault = faulted.clone();
    let on_err = move |err: cpal::StreamError| {
        crate::klog!(mic, error, "stream error: {err}");
        // Force a rebuild on the next press (device unplug / default switch).
        fault.store(true, Ordering::SeqCst);
    };
    let built = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |d: &[f32], _: &_| {
                if r1.load(Ordering::SeqCst) {
                    append_mono(&s1, &l1, d, channels);
                }
            },
            on_err,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |d: &[i16], _: &_| {
                if r2.load(Ordering::SeqCst) {
                    let f: Vec<f32> = d.iter().map(|s| *s as f32 / 32768.0).collect();
                    append_mono(&s2, &l2, &f, channels);
                }
            },
            on_err,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |d: &[u16], _: &_| {
                if r3.load(Ordering::SeqCst) {
                    let f: Vec<f32> = d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                    append_mono(&s3, &l3, &f, channels);
                }
            },
            on_err,
            None,
        ),
        other => {
            crate::klog!(mic, error, "unsupported input sample format {other:?}");
            return None;
        }
    };
    match built {
        Ok(stream) => Some((stream, rate)),
        Err(err) => {
            crate::klog!(mic, error, "failed to build mic stream: {err}");
            None
        }
    }
}

// Owns the cpal stream (which is !Send) on a dedicated thread and reacts to
// Start/Stop. On Stop it encodes the buffer to WAV and emits `ptt:audio` to the
// notch, which transcribes + runs the tutor turn. Also spawns a level emitter that
// feeds the cursor halo while capturing. Returns the command sender.
pub(crate) fn spawn_audio_capture(
    app: &tauri::AppHandle,
    capturing: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> Sender<AudioCommand> {
    let (tx, rx) = channel::<AudioCommand>();

    // Level emitter → cursor:level (throttled), only while capturing.
    let app_level = app.clone();
    let capturing_level = capturing.clone();
    let level_read = level.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(66));
        if capturing_level.load(Ordering::SeqCst) {
            let lvl = f32::from_bits(level_read.load(Ordering::SeqCst));
            // Global so BOTH the cursor halo and the status capsule react to voice.
            let _ = app_level.emit("cursor:level", json!({ "level": lvl }));
        }
    });

    let app = app.clone();
    // `capturing_worker` is BOTH the level-emitter gate AND the callback record-gate:
    // the mic callback appends only while this is set, so a paused/leaked unit writes
    // nothing. Start sets it, Stop/Cancel clear it.
    let capturing_worker = capturing;
    let level_worker = level;
    std::thread::spawn(move || {
        use cpal::traits::StreamTrait;
        let host = cpal::default_host();
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        // Set by the stream error callback (device unplug / default switch); the next
        // Start rebuilds against the current device.
        let faulted: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        // ONE persistent AudioUnit for the whole process. cpal's coreaudio backend
        // auto-starts the unit on build and its Drop stops+disposes — but disposing a
        // STILL-RUNNING input unit swallows the stop error and leaks the live render
        // callback (each leaked callback keeps appending to `samples` → N× audio AND
        // a mic indicator that never turns off). So we NEVER drop per-press: build the
        // unit once (lazily, on the first press → mic hardware untouched until the user
        // actually talks), then play() it on Start and pause() it on Stop. pause() =
        // AudioOutputUnitStop, so the mic indicator goes dark between presses.
        let mut stream: Option<cpal::Stream> = None;
        let mut current_rate: u32 = 16_000;
        let mut record_started: Option<Instant> = None;

        while let Ok(cmd) = rx.recv() {
            match cmd {
                // Lazy build: no warm-up. The unit is created on the first press and
                // kept (paused) for the session, so the mic stays fully closed when idle.
                AudioCommand::Warm => {}
                AudioCommand::Start(chord_down) => {
                    // A device fault since last time → discard the dead unit so we
                    // rebuild against the current device. (Safe to drop: a faulted unit
                    // is not rendering, so this is NOT the leak-a-running-unit path.)
                    if faulted.swap(false, Ordering::SeqCst) {
                        crate::klog!(mic, warn, "mic faulted previously; rebuilding stream");
                        stream = None;
                    }
                    // Fresh buffer + arm the record-gate BEFORE the unit runs, so capture
                    // starts clean at frame 0 and nothing from a prior press can bleed in.
                    if let Ok(mut buf) = samples.lock() {
                        buf.clear();
                    }
                    capturing_worker.store(true, Ordering::SeqCst);
                    if stream.is_none() {
                        // Cold build (once per session, or after a fault). cpal auto-starts
                        // the unit, and the gate is already armed, so it captures immediately
                        // — no play() needed here.
                        match build_gated_input(
                            &host,
                            &samples,
                            &level_worker,
                            &capturing_worker,
                            &faulted,
                        ) {
                            Some((s, rate)) => {
                                current_rate = rate;
                                record_started = Some(Instant::now());
                                stream = Some(s);
                                crate::klog!(
                                    ptt,
                                    info,
                                    ms = chord_down.elapsed().as_millis(),
                                    hz = current_rate,
                                    "recording started (cold build)"
                                );
                            }
                            None => {
                                capturing_worker.store(false, Ordering::SeqCst);
                                crate::klog!(mic, error, "failed to build mic stream");
                            }
                        }
                    } else if let Some(s) = stream.as_ref() {
                        // Warm reuse: restart the paused-but-initialized unit. Instant.
                        match s.play() {
                            Ok(()) => {
                                record_started = Some(Instant::now());
                                crate::klog!(
                                    ptt,
                                    info,
                                    ms = chord_down.elapsed().as_millis(),
                                    hz = current_rate,
                                    "recording started (warm)"
                                );
                            }
                            Err(err) => {
                                capturing_worker.store(false, Ordering::SeqCst);
                                crate::klog!(mic, error, "failed to resume mic stream: {err}; dropping to rebuild");
                                stream = None;
                            }
                        }
                    }
                }
                AudioCommand::Stop => {
                    // Close the record-gate FIRST (callback appends nothing more), THEN
                    // stop the unit so the mic indicator goes dark. KEEP the stream alive
                    // — the next press reuses it (no rebuild, no leak).
                    capturing_worker.store(false, Ordering::SeqCst);
                    level_worker.store(0, Ordering::SeqCst);
                    if let Some(s) = stream.as_ref() {
                        if let Err(err) = s.pause() {
                            crate::klog!(mic, error, "failed to pause mic stream: {err}; dropping to rebuild");
                            stream = None;
                        }
                    }
                    let captured: Vec<f32> =
                        samples.lock().map(|buf| buf.clone()).unwrap_or_default();
                    // Leak canary: captured audio should be ~= how long the key was held.
                    // If it is materially longer, MORE THAN ONE live callback is feeding the
                    // buffer — i.e. a unit leaked. Log LOUD so a regression is unmistakable
                    // even when transcription still appears to work.
                    let audio_s = captured.len() as f64 / current_rate.max(1) as f64;
                    let held_s = record_started
                        .take()
                        .map(|t| t.elapsed().as_secs_f64())
                        .unwrap_or(0.0);
                    if held_s > 0.05 && audio_s / held_s > 1.5 {
                        crate::klog!(
                            mic,
                            error,
                            samples = captured.len(),
                            audio_s = audio_s,
                            held_s = held_s,
                            ratio = audio_s / held_s,
                            "MIC LEAK: captured audio far longer than key hold — multiple live callbacks feeding the buffer"
                        );
                    }
                    crate::klog!(
                        ptt,
                        info,
                        samples = captured.len(),
                        hz = current_rate,
                        audio_s = audio_s,
                        held_s = held_s,
                        "captured audio"
                    );
                    if captured.is_empty() {
                        continue;
                    }
                    let wav = encode_wav_mono(&captured, current_rate);
                    use base64::Engine;
                    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&wav);
                    // While the onboarding demo owns push-to-talk, its window transcribes
                    // + drives the practice turn instead of the notch.
                    let target = if crate::input::ONBOARDING_PTT.load(Ordering::SeqCst) {
                        "onboarding"
                    } else {
                        "notch"
                    };
                    if let Some(window) = app.get_webview_window(target) {
                        let _ = window.emit(
                            "ptt:audio",
                            json!({ "audioBase64": audio_base64, "mimeType": "audio/wav" }),
                        );
                    }
                }
                AudioCommand::Cancel => {
                    // Stop + discard: close the gate, pause the unit (mic indicator off),
                    // throw the buffer away. No WAV, no `ptt:audio`, so no transcription.
                    capturing_worker.store(false, Ordering::SeqCst);
                    level_worker.store(0, Ordering::SeqCst);
                    if let Some(s) = stream.as_ref() {
                        if let Err(err) = s.pause() {
                            crate::klog!(mic, error, "failed to pause mic stream on cancel: {err}; dropping to rebuild");
                            stream = None;
                        }
                    }
                    record_started = None;
                    if let Ok(mut buf) = samples.lock() {
                        buf.clear();
                    }
                    crate::klog!(ptt, info, "capture cancelled (tap → typing)");
                }
            }
        }
        // Channel closed (app shutdown): make sure the unit is never left running.
        if let Some(s) = stream.as_ref() {
            let _ = s.pause();
        }
    });

    tx
}

pub(crate) fn send_audio_command(app: &tauri::AppHandle, command: AudioCommand) {
    let sender = app
        .state::<AudioCapture>()
        .tx
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    if let Some(tx) = sender {
        let _ = tx.send(command);
    }
}
