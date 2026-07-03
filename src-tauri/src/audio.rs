//! Native microphone capture (cpal) for push-to-talk: device selection, WAV
//! encoding, the capture thread, and the command channel.

use crate::{AudioCapture, AudioCommand};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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

pub(crate) fn audio_stream_error(err: cpal::StreamError) {
    crate::klog!(audio, error, "stream error: {err}");
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

// Build the input stream in an ARMED (not playing) state. The device is opened /
// AudioUnit initialized here, but no I/O runs until play(), so the mic indicator
// stays OFF until recording actually starts. Returns the stream + its sample rate.
pub(crate) fn build_armed_input(
    host: &cpal::Host,
    samples: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
) -> Option<(cpal::Stream, u32)> {
    use cpal::traits::DeviceTrait;
    let device = pick_input_device(host)?;
    let config = device.default_input_config().ok()?;
    let sample_format = config.sample_format();
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.into();
    let (s1, l1) = (samples.clone(), level.clone());
    let (s2, l2) = (samples.clone(), level.clone());
    let (s3, l3) = (samples.clone(), level.clone());
    let built = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |d: &[f32], _: &_| append_mono(&s1, &l1, d, channels),
            audio_stream_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |d: &[i16], _: &_| {
                let f: Vec<f32> = d.iter().map(|s| *s as f32 / 32768.0).collect();
                append_mono(&s2, &l2, &f, channels);
            },
            audio_stream_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |d: &[u16], _: &_| {
                let f: Vec<f32> = d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                append_mono(&s3, &l3, &f, channels);
            },
            audio_stream_error,
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
    let capturing_worker = capturing;
    let level_worker = level;
    std::thread::spawn(move || {
        use cpal::traits::StreamTrait;
        let host = cpal::default_host();
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        // Build-per-press: build + play the stream on Start, DROP it on Stop. Dropping
        // closes the input device, so the mic (and its indicator) is on ONLY while
        // recording. Trade-off: the first press pays the ~200ms cold build.
        let mut current: Option<cpal::Stream> = None;
        let mut current_rate: u32 = 16_000;

        while let Ok(cmd) = rx.recv() {
            match cmd {
                // Nothing to warm — build-per-press keeps the mic closed when idle.
                AudioCommand::Warm => {}
                AudioCommand::Start(chord_down) => {
                    if let Ok(mut buf) = samples.lock() {
                        buf.clear();
                    }
                    match build_armed_input(&host, &samples, &level_worker) {
                        Some((stream, rate)) => {
                            current_rate = rate;
                            match stream.play() {
                                Ok(()) => {
                                    crate::klog!(
                                        ptt,
                                        info,
                                        ms = chord_down.elapsed().as_millis(),
                                        hz = current_rate,
                                        "recording started"
                                    );
                                    current = Some(stream);
                                    capturing_worker.store(true, Ordering::SeqCst);
                                }
                                Err(err) => {
                                    crate::klog!(mic, error, "failed to start mic stream: {err}");
                                }
                            }
                        }
                        None => {}
                    }
                }
                AudioCommand::Stop => {
                    capturing_worker.store(false, Ordering::SeqCst);
                    level_worker.store(0, Ordering::SeqCst);
                    // Drop the stream → I/O stops AND the device closes, so the mic
                    // indicator turns off between presses.
                    current.take();
                    let captured: Vec<f32> =
                        samples.lock().map(|buf| buf.clone()).unwrap_or_default();
                    crate::klog!(
                        ptt,
                        info,
                        samples = captured.len(),
                        hz = current_rate,
                        "captured audio"
                    );
                    if captured.is_empty() {
                        continue;
                    }
                    let wav = encode_wav_mono(&captured, current_rate);
                    use base64::Engine;
                    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&wav);
                    if let Some(window) = app.get_webview_window("notch") {
                        let _ = window.emit(
                            "ptt:audio",
                            json!({ "audioBase64": audio_base64, "mimeType": "audio/wav" }),
                        );
                    }
                }
                AudioCommand::Cancel => {
                    capturing_worker.store(false, Ordering::SeqCst);
                    level_worker.store(0, Ordering::SeqCst);
                    // Drop the stream (closes the device / turns the mic indicator off) and
                    // throw the buffer away — no WAV, no `ptt:audio`, so no transcription runs.
                    current.take();
                    if let Ok(mut buf) = samples.lock() {
                        buf.clear();
                    }
                    crate::klog!(ptt, info, "capture cancelled (tap → typing)");
                }
            }
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
