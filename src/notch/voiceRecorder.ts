export type VoiceCaptureState = 'idle' | 'recording' | 'transcribing' | 'error';

export const VOICE_SILENCE_THRESHOLD = 0.018;
export const VOICE_SILENCE_AFTER_SPEECH_MS = 900;
export const VOICE_MIN_RECORDING_MS = 650;
export const VOICE_NO_SPEECH_TIMEOUT_MS = 4_800;
export const VOICE_MAX_RECORDING_MS = 18_000;

const preferredAudioMimeTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav'
];

type MediaRecorderConstructorLike = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?: (mimeType: string) => boolean;
};

export function selectAudioMimeType(
  mediaRecorder: Pick<typeof MediaRecorder, 'isTypeSupported'> | undefined = globalThis.MediaRecorder
) {
  if (!mediaRecorder?.isTypeSupported) {
    return '';
  }

  return preferredAudioMimeTypes.find((mimeType) => mediaRecorder.isTypeSupported(mimeType)) ?? '';
}

export function createVoiceRecorder(
  stream: MediaStream,
  MediaRecorderConstructor: MediaRecorderConstructorLike | undefined = globalThis.MediaRecorder
) {
  if (!MediaRecorderConstructor) {
    throw new Error('MediaRecorder is unavailable');
  }

  const candidates = MediaRecorderConstructor.isTypeSupported
    ? preferredAudioMimeTypes.filter((mimeType) =>
        MediaRecorderConstructor.isTypeSupported?.(mimeType) ?? false
      )
    : preferredAudioMimeTypes;

  for (const mimeType of candidates) {
    try {
      return {
        recorder: new MediaRecorderConstructor(stream, { mimeType }),
        mimeType
      };
    } catch {
      continue;
    }
  }

  return {
    recorder: new MediaRecorderConstructor(stream),
    mimeType: ''
  };
}

// Virtual / loopback audio devices (e.g. BlackHole, Soundflower, Loopback) show
// up as audio inputs but carry no real microphone signal, so getUserMedia's
// default-device pick can silently capture silence. Prefer the real built-in mic.
const VIRTUAL_INPUT_RE =
  /blackhole|soundflower|loopback|aggregate|multi-?output|virtual|vb-?cable|\bcable\b|sound siphon|background music/i;
const BUILTIN_INPUT_RE = /built-?in|macbook|imac|mac\s?mini|mac\s?studio|internal|microphone/i;

let cachedMicDeviceId: string | null = null;

export async function acquireMicrophoneStream(
  mediaDevices: MediaDevices | undefined = globalThis.navigator?.mediaDevices,
  log: (message: string) => void = () => {}
): Promise<MediaStream> {
  if (!mediaDevices?.getUserMedia) {
    throw new Error('Microphone recording is unavailable in this runtime.');
  }

  const baseConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  // Fast path: reuse the device we already resolved (skips the default-acquire
  // + enumerate + switch round-trip on every later recording).
  if (cachedMicDeviceId) {
    try {
      return await mediaDevices.getUserMedia({
        audio: { ...baseConstraints, deviceId: { exact: cachedMicDeviceId } }
      });
    } catch {
      cachedMicDeviceId = null; // device went away — fall through to re-resolve
    }
  }

  // Acquire a default stream FIRST. Device labels are hidden until a getUserMedia
  // grant, so without this the first call can't identify the real built-in mic
  // and may bind to a silent virtual device (e.g. BlackHole) — the cause of an
  // empty first transcription.
  let stream = await mediaDevices.getUserMedia({ audio: baseConstraints });

  try {
    const devices = await mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    const preferred =
      inputs.find(
        (device) => BUILTIN_INPUT_RE.test(device.label) && !VIRTUAL_INPUT_RE.test(device.label)
      ) ??
      inputs.find((device) => !VIRTUAL_INPUT_RE.test(device.label) && device.deviceId !== 'default');
    const current = stream.getAudioTracks()[0];
    const currentId = current?.getSettings().deviceId;

    log(
      `mic: current="${current?.label ?? ''}" preferred="${preferred?.label ?? ''}" switch=${Boolean(
        preferred?.deviceId && preferred.deviceId !== currentId
      )}`
    );

    if (preferred?.deviceId && preferred.deviceId !== currentId) {
      stream.getTracks().forEach((track) => track.stop());
      stream = await mediaDevices.getUserMedia({
        audio: { ...baseConstraints, deviceId: { exact: preferred.deviceId } }
      });
      cachedMicDeviceId = preferred.deviceId;
    } else if (preferred?.deviceId) {
      // Default is already the real built-in mic.
      cachedMicDeviceId = preferred.deviceId;
    }
  } catch (error) {
    log(`mic select error: ${String(error)}`);
  }

  return stream;
}

export function voiceStatusCopy(state: VoiceCaptureState) {
  if (state === 'recording') {
    return {
      title: 'Kairo is listening',
      detail: 'Speak now'
    };
  }

  if (state === 'transcribing') {
    return {
      title: 'Kairo is transcribing',
      detail: 'Turning voice into text'
    };
  }

  if (state === 'error') {
    return {
      title: 'Voice unavailable',
      detail: 'Check microphone access and try again'
    };
  }

  return {
    title: 'Screen captured',
    detail: 'Ready for a question'
  };
}

export async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary);
}

export function voiceFilenameForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();

  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'kairo-voice.mp3';
  }

  if (normalized.includes('mp4') || normalized.includes('m4a')) {
    return 'kairo-voice.m4a';
  }

  if (normalized.includes('webm')) {
    return 'kairo-voice.webm';
  }

  return 'kairo-voice.wav';
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodeWavFromFloat32Chunks(chunks: Float32Array[], sampleRate: number) {
  const frameCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + frameCount * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, frameCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index] ?? 0));
      const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, value, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function rmsFromTimeDomainData(data: Uint8Array) {
  if (data.length === 0) {
    return 0;
  }

  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / data.length);
}

export function shouldStopVoiceCapture({
  elapsedMs,
  heardSpeech,
  silenceMs,
  rms,
  silenceThreshold = VOICE_SILENCE_THRESHOLD,
  minRecordingMs = VOICE_MIN_RECORDING_MS,
  silenceAfterSpeechMs = VOICE_SILENCE_AFTER_SPEECH_MS,
  noSpeechTimeoutMs = VOICE_NO_SPEECH_TIMEOUT_MS,
  maxRecordingMs = VOICE_MAX_RECORDING_MS
}: {
  elapsedMs: number;
  heardSpeech: boolean;
  silenceMs: number;
  rms: number;
  silenceThreshold?: number;
  minRecordingMs?: number;
  silenceAfterSpeechMs?: number;
  noSpeechTimeoutMs?: number;
  maxRecordingMs?: number;
}) {
  if (elapsedMs >= maxRecordingMs) {
    return true;
  }

  if (!heardSpeech && elapsedMs >= noSpeechTimeoutMs && rms < silenceThreshold) {
    return true;
  }

  return (
    heardSpeech &&
    elapsedMs >= minRecordingMs &&
    rms < silenceThreshold &&
    silenceMs >= silenceAfterSpeechMs
  );
}
