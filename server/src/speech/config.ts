/**
 * Server-side speech model config. This is the counterpart to the desktop's `constants.rs`: the
 * desktop keeps these values only for the direct-key dev path (proxy disabled), while every
 * shipped build routes through here. Changing a model is a redeploy, never a new DMG.
 */

export const SARVAM_STT_MODEL = 'saaras:v3';
export const SARVAM_STT_MODE = 'transcribe';
/** Auto-detect. Forcing en-IN garbles Hindi/Hinglish into nonsense English — never hard-code it. */
export const SARVAM_STT_LANGUAGE_CODE = 'unknown';

export const SARVAM_TTS_MODEL = 'bulbul:v3';
export const SARVAM_TTS_LANGUAGE_CODE = 'en-IN';

/**
 * Flash, not multilingual_v2: on a voice tutor the user is waiting on first audio, and flash is
 * the low-latency line that still covers Hindi. Quality per clip is slightly below multilingual_v2;
 * responsiveness matters more here.
 */
export const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';

/**
 * Both engines are asked for raw 24kHz little-endian PCM so the frontend's Web Audio scheduler
 * plays either stream through the same path. Sarvam calls it `linear16`, ElevenLabs `pcm_24000`.
 */
export const TTS_SAMPLE_RATE = 24_000;
export const SARVAM_OUTPUT_CODEC = 'linear16';
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_24000';
