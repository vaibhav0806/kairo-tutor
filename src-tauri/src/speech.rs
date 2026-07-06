//! Speech-to-text and text-to-speech provider integrations (Sarvam, ElevenLabs)
//! plus the request/response helpers and the two Tauri commands.

use crate::constants;
use crate::env::{provider_env, provider_env_optional};
use crate::tutor::shared_http_client;
use crate::types::{
    SpeechSynthesisResult, SynthesizeSpeechInput, TranscribeAudioInput, TranscriptionResult,
};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) fn audio_filename(input: &TranscribeAudioInput) -> String {
    if let Some(filename) = input
        .filename
        .as_deref()
        .map(str::trim)
        .filter(|filename| !filename.is_empty())
    {
        return filename.to_string();
    }

    let extension = if input.mime_type.contains("mpeg") || input.mime_type.contains("mp3") {
        "mp3"
    } else if input.mime_type.contains("mp4") {
        "m4a"
    } else if input.mime_type.contains("webm") {
        "webm"
    } else {
        "wav"
    };

    format!("kairo-voice.{extension}")
}

pub(crate) fn decode_audio_base64(input: &TranscribeAudioInput) -> Result<Vec<u8>, String> {
    use base64::Engine;

    base64::engine::general_purpose::STANDARD
        .decode(input.audio_base64.trim())
        .map_err(|error| format!("Voice recording was not valid base64 audio: {error}"))
}

fn parse_provider_json_error(payload: &Value, fallback: &str) -> String {
    payload
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("detail")
                .and_then(|detail| detail.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or(fallback)
        .to_string()
}

async fn parse_transcription_response(
    response: reqwest::Response,
    transcript_keys: &[&str],
    missing_message: &str,
) -> Result<String, String> {
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("STT response was not JSON: {error}"))?;

    if !status.is_success() {
        return Err(parse_provider_json_error(
            &payload,
            &format!("STT request failed with {status}"),
        ));
    }

    transcript_keys
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| missing_message.to_string())
}

async fn parse_sarvam_tts_response(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Sarvam TTS response was not JSON: {error}"))?;

    if !status.is_success() {
        return Err(parse_provider_json_error(
            &payload,
            &format!("Sarvam TTS request failed with {status}"),
        ));
    }

    payload
        .get("audios")
        .and_then(Value::as_array)
        .and_then(|audios| audios.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|audio| !audio.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "Sarvam TTS response did not include audio.".to_string())
}

async fn parse_binary_audio_response(
    response: reqwest::Response,
    provider_name: &str,
    default_mime_type: &str,
) -> Result<(String, String), String> {
    use base64::Engine;

    let status = response.status();
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or(default_mime_type)
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{provider_name} TTS response could not be read: {error}"))?;

    if !status.is_success() {
        if let Ok(payload) = serde_json::from_slice::<Value>(&bytes) {
            return Err(parse_provider_json_error(
                &payload,
                &format!("{provider_name} TTS request failed with {status}"),
            ));
        }

        return Err(format!("{provider_name} TTS request failed with {status}"));
    }

    if bytes.is_empty() {
        return Err(format!(
            "{provider_name} TTS response did not include audio."
        ));
    }

    Ok((
        base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type,
    ))
}

#[tauri::command]
pub(crate) async fn transcribe_audio(
    input: TranscribeAudioInput,
) -> Result<TranscriptionResult, String> {
    let _t = crate::klog::timer("stt", "transcribe");
    let provider = provider_env("KAIRO_STT_PROVIDER", constants::STT_PROVIDER);
    if provider == "mock" {
        return Ok(TranscriptionResult {
            text: String::new(),
            provider,
        });
    }

    let audio_bytes = decode_audio_base64(&input)?;
    if audio_bytes.is_empty() {
        return Err("Voice recording was empty.".to_string());
    }
    crate::klog!(stt, debug, provider = %provider, audio_bytes = audio_bytes.len(), "audio decoded");

    let filename = audio_filename(&input);
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(&input.mime_type)
        .map_err(|error| format!("Unsupported voice recording MIME type: {error}"))?;
    let client = shared_http_client();

    if provider == "sarvam" {
        let api_key = provider_env_optional("SARVAM_API_KEY")
            .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam transcription.".to_string())?;
        let base_url = provider_env("SARVAM_BASE_URL", constants::SARVAM_BASE_URL);
        // Pin the language so Sarvam doesn't auto-detect the wrong one (it
        // guessed gu-IN on a cold first recording and returned an empty
        // transcript). Set SARVAM_STT_LANGUAGE_CODE=unknown to auto-detect.
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", provider_env("SARVAM_STT_MODEL", constants::SARVAM_STT_MODEL))
            .text("mode", provider_env("SARVAM_STT_MODE", constants::SARVAM_STT_MODE))
            .text(
                "language_code",
                provider_env("SARVAM_STT_LANGUAGE_CODE", constants::SARVAM_STT_LANGUAGE_CODE),
            );
        let response = client
            .post(format!("{}/speech-to-text", base_url.trim_end_matches('/')))
            .header("api-subscription-key", api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("Sarvam STT request failed: {error}"))?;
        let body = response.text().await.unwrap_or_default();
        let value: Value = serde_json::from_str(&body)
            .map_err(|error| format!("Sarvam STT response was not JSON: {error}"))?;
        let text = value
            .get("transcript")
            .or_else(|| value.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Sarvam STT response did not include transcript text.".to_string())?
            .to_string();

        // With language_code="unknown", saaras returns the detected language + a
        // confidence — log both so we can see WHAT it heard (and catch mis-detects).
        let detected_lang = value.get("language_code").and_then(Value::as_str).unwrap_or("?");
        let lang_prob = value
            .get("language_probability")
            .and_then(Value::as_f64)
            .unwrap_or(-1.0);
        crate::klog!(
            stt,
            info,
            provider = %provider,
            detected_lang = detected_lang,
            lang_prob = lang_prob,
            transcript = %crate::klog::transcript_field(&text),
            "transcribed"
        );
        return Ok(TranscriptionResult { text, provider });
    }

    if provider == "elevenlabs" {
        let api_key = provider_env_optional("ELEVENLABS_API_KEY").ok_or_else(|| {
            "ELEVENLABS_API_KEY is required for ElevenLabs transcription.".to_string()
        })?;
        let base_url = provider_env("ELEVENLABS_BASE_URL", constants::ELEVENLABS_BASE_URL);
        let form = reqwest::multipart::Form::new().part("file", part).text(
            "model_id",
            provider_env("ELEVENLABS_STT_MODEL", constants::ELEVENLABS_STT_MODEL),
        );
        let text = parse_transcription_response(
            client
                .post(format!(
                    "{}/v1/speech-to-text",
                    base_url.trim_end_matches('/')
                ))
                .header("xi-api-key", api_key)
                .multipart(form)
                .send()
                .await
                .map_err(|error| format!("ElevenLabs STT request failed: {error}"))?,
            &["text"],
            "ElevenLabs STT response did not include transcript text.",
        )
        .await?;

        crate::klog!(stt, info, provider = %provider, transcript = %crate::klog::transcript_field(&text), "transcribed");
        return Ok(TranscriptionResult { text, provider });
    }

    Err(format!("Unsupported KAIRO_STT_PROVIDER={provider}."))
}

#[tauri::command]
pub(crate) async fn synthesize_speech(
    input: SynthesizeSpeechInput,
) -> Result<SpeechSynthesisResult, String> {
    let _t = crate::klog::timer("tts", "synthesize");
    let provider = provider_env("KAIRO_TTS_PROVIDER", constants::TTS_PROVIDER);
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(constants::TTS_TIMEOUT_MS));
    let text = input.text.trim();
    if provider == "mock" || text.is_empty() {
        return Ok(SpeechSynthesisResult {
            audio_base64: String::new(),
            mime_type: "audio/mpeg".to_string(),
            provider,
        });
    }

    let client = shared_http_client();

    if provider == "sarvam" {
        let api_key = provider_env_optional("SARVAM_API_KEY")
            .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam speech synthesis.".to_string())?;
        let base_url = provider_env("SARVAM_BASE_URL", constants::SARVAM_BASE_URL);
        let audio_base64 = parse_sarvam_tts_response(
            client
                .post(format!("{}/text-to-speech", base_url.trim_end_matches('/')))
                .header("api-subscription-key", api_key)
                .header("Content-Type", "application/json")
                .timeout(timeout)
                .json(&json!({
                    "text": text,
                    "target_language_code": provider_env("SARVAM_TTS_LANGUAGE_CODE", constants::SARVAM_TTS_LANGUAGE_CODE),
                    "speaker": provider_env("SARVAM_TTS_SPEAKER", constants::SARVAM_TTS_SPEAKER),
                    "model": provider_env("SARVAM_TTS_MODEL", constants::SARVAM_TTS_MODEL),
                    "output_audio_codec": "wav",
                    "speech_sample_rate": 24000,
                }))
                .send()
                .await
                .map_err(|error| format!("Sarvam TTS request failed: {error}"))?,
        )
        .await?;

        return Ok(SpeechSynthesisResult {
            audio_base64,
            mime_type: "audio/wav".to_string(),
            provider,
        });
    }

    if provider == "elevenlabs" {
        let api_key = provider_env_optional("ELEVENLABS_API_KEY").ok_or_else(|| {
            "ELEVENLABS_API_KEY is required for ElevenLabs speech synthesis.".to_string()
        })?;
        let base_url = provider_env("ELEVENLABS_BASE_URL", constants::ELEVENLABS_BASE_URL);
        let voice_id = provider_env("ELEVENLABS_VOICE_ID", constants::ELEVENLABS_VOICE_ID);
        let (audio_base64, mime_type) = parse_binary_audio_response(
            client
                .post(format!(
                    "{}/v1/text-to-speech/{}",
                    base_url.trim_end_matches('/'),
                    voice_id
                ))
                .header("xi-api-key", api_key)
                .header("Content-Type", "application/json")
                .timeout(timeout)
                .json(&json!({
                    "text": text,
                    "model_id": provider_env("ELEVENLABS_TTS_MODEL", constants::ELEVENLABS_TTS_MODEL),
                }))
                .send()
                .await
                .map_err(|error| format!("ElevenLabs TTS request failed: {error}"))?,
            "ElevenLabs",
            "audio/mpeg",
        )
        .await?;

        return Ok(SpeechSynthesisResult {
            audio_base64,
            mime_type,
            provider,
        });
    }

    Err(format!("Unsupported KAIRO_TTS_PROVIDER={provider}."))
}

// One message in the streaming-TTS pipe (Rust → notch webview over a Tauri Channel).
// `Chunk.data` is base64-encoded raw PCM (linear16, s16le, mono) at `Start.sampleRate`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TtsStreamMsg {
    Start {
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
        channels: u16,
    },
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
    },
}

// Streaming text-to-speech: forwards raw PCM chunks to the frontend as they arrive
// from Sarvam's /text-to-speech/stream endpoint, so playback can begin at first byte
// (~200-400ms) instead of waiting for the whole clip to synthesize. The frontend
// schedules the PCM via the Web Audio API. Sarvam only — other providers return Err
// so the caller transparently falls back to the buffered `synthesize_speech`.
#[tauri::command]
pub(crate) async fn synthesize_speech_stream(
    input: SynthesizeSpeechInput,
    on_chunk: tauri::ipc::Channel<TtsStreamMsg>,
) -> Result<(), String> {
    let _t = crate::klog::timer("tts", "synthesize_stream");
    let provider = provider_env("KAIRO_TTS_PROVIDER", constants::TTS_PROVIDER);
    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(constants::TTS_TIMEOUT_MS));
    let text = input.text.trim();
    let sample_rate = constants::SARVAM_TTS_STREAM_SAMPLE_RATE;

    if provider == "mock" || text.is_empty() {
        let _ = on_chunk.send(TtsStreamMsg::End);
        return Ok(());
    }
    if provider != "sarvam" {
        // No streaming path for this provider; let the caller fall back to buffered.
        return Err(format!("streaming TTS unsupported for provider {provider}"));
    }

    let api_key = provider_env_optional("SARVAM_API_KEY")
        .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam speech synthesis.".to_string())?;
    let base_url = provider_env("SARVAM_BASE_URL", constants::SARVAM_BASE_URL);

    let response = shared_http_client()
        .post(format!(
            "{}/text-to-speech/stream",
            base_url.trim_end_matches('/')
        ))
        .header("api-subscription-key", api_key)
        .header("Content-Type", "application/json")
        .timeout(timeout)
        .json(&json!({
            "text": text,
            "target_language_code": provider_env("SARVAM_TTS_LANGUAGE_CODE", constants::SARVAM_TTS_LANGUAGE_CODE),
            "speaker": provider_env("SARVAM_TTS_SPEAKER", constants::SARVAM_TTS_SPEAKER),
            "model": provider_env("SARVAM_TTS_MODEL", constants::SARVAM_TTS_MODEL),
            "output_audio_codec": "linear16",
            "speech_sample_rate": sample_rate,
        }))
        .send()
        .await
        .map_err(|error| {
            let message = format!("Sarvam TTS stream request failed: {error}");
            let _ = on_chunk.send(TtsStreamMsg::Error {
                message: message.clone(),
            });
            message
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let message = format!(
            "Sarvam TTS stream HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        );
        let _ = on_chunk.send(TtsStreamMsg::Error {
            message: message.clone(),
        });
        return Err(message);
    }

    let _ = on_chunk.send(TtsStreamMsg::Start {
        sample_rate,
        channels: 1,
    });

    use base64::Engine;
    let mut response = response;
    let mut total: usize = 0;
    let mut chunks: u32 = 0;
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                if bytes.is_empty() {
                    continue;
                }
                total += bytes.len();
                chunks += 1;
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if on_chunk.send(TtsStreamMsg::Chunk { data }).is_err() {
                    // Frontend dropped the channel (barge-in / navigation) → stop early.
                    crate::klog!(tts, debug, chunks = chunks, "tts stream channel closed; stopping");
                    return Ok(());
                }
            }
            Ok(None) => break,
            Err(error) => {
                let message = format!("Sarvam TTS stream read failed: {error}");
                let _ = on_chunk.send(TtsStreamMsg::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        }
    }

    let _ = on_chunk.send(TtsStreamMsg::End);
    crate::klog!(
        tts,
        info,
        provider = %provider,
        bytes = total,
        chunks = chunks,
        sample_rate = sample_rate,
        "tts stream complete"
    );
    Ok(())
}
