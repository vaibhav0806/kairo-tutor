//! Speech-to-text and text-to-speech provider integrations (Sarvam, ElevenLabs)
//! plus the request/response helpers and the two Tauri commands.

use crate::env::{provider_env, provider_env_optional};
use crate::tutor::shared_http_client;
use crate::types::{
    SpeechSynthesisResult, SynthesizeSpeechInput, TranscribeAudioInput, TranscriptionResult,
};
use serde_json::{json, Value};

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
    let provider = provider_env("KAIRO_STT_PROVIDER", "mock");
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

    let filename = audio_filename(&input);
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(&input.mime_type)
        .map_err(|error| format!("Unsupported voice recording MIME type: {error}"))?;
    let client = shared_http_client();

    if provider == "sarvam" {
        let api_key = provider_env_optional("SARVAM_API_KEY")
            .ok_or_else(|| "SARVAM_API_KEY is required for Sarvam transcription.".to_string())?;
        let base_url = provider_env("SARVAM_BASE_URL", "https://api.sarvam.ai");
        // Pin the language so Sarvam doesn't auto-detect the wrong one (it
        // guessed gu-IN on a cold first recording and returned an empty
        // transcript). Set SARVAM_STT_LANGUAGE_CODE=unknown to auto-detect.
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", provider_env("SARVAM_STT_MODEL", "saaras:v3"))
            .text("mode", provider_env("SARVAM_STT_MODE", "transcribe"))
            .text(
                "language_code",
                provider_env("SARVAM_STT_LANGUAGE_CODE", "en-IN"),
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

        return Ok(TranscriptionResult { text, provider });
    }

    if provider == "elevenlabs" {
        let api_key = provider_env_optional("ELEVENLABS_API_KEY").ok_or_else(|| {
            "ELEVENLABS_API_KEY is required for ElevenLabs transcription.".to_string()
        })?;
        let base_url = provider_env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io");
        let form = reqwest::multipart::Form::new().part("file", part).text(
            "model_id",
            provider_env("ELEVENLABS_STT_MODEL", "scribe_v1"),
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

        return Ok(TranscriptionResult { text, provider });
    }

    Err(format!("Unsupported KAIRO_STT_PROVIDER={provider}."))
}

#[tauri::command]
pub(crate) async fn synthesize_speech(
    input: SynthesizeSpeechInput,
) -> Result<SpeechSynthesisResult, String> {
    let provider = provider_env("KAIRO_TTS_PROVIDER", "mock");
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
        let base_url = provider_env("SARVAM_BASE_URL", "https://api.sarvam.ai");
        let audio_base64 = parse_sarvam_tts_response(
            client
                .post(format!("{}/text-to-speech", base_url.trim_end_matches('/')))
                .header("api-subscription-key", api_key)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "text": text,
                    "target_language_code": provider_env("SARVAM_TTS_LANGUAGE_CODE", "en-IN"),
                    "speaker": provider_env("SARVAM_TTS_SPEAKER", "anushka"),
                    "model": provider_env("SARVAM_TTS_MODEL", "bulbul:v3"),
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
        let base_url = provider_env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io");
        let voice_id = provider_env("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM");
        let (audio_base64, mime_type) = parse_binary_audio_response(
            client
                .post(format!(
                    "{}/v1/text-to-speech/{}",
                    base_url.trim_end_matches('/'),
                    voice_id
                ))
                .header("xi-api-key", api_key)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "text": text,
                    "model_id": provider_env("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
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
