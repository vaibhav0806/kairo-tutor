export type VoiceCaptureState = 'idle' | 'recording' | 'transcribing' | 'error';

export const VOICE_SILENCE_THRESHOLD = 0.018;
export const VOICE_SILENCE_AFTER_SPEECH_MS = 900;
export const VOICE_MIN_RECORDING_MS = 650;
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
  maxRecordingMs = VOICE_MAX_RECORDING_MS
}: {
  elapsedMs: number;
  heardSpeech: boolean;
  silenceMs: number;
  rms: number;
  silenceThreshold?: number;
  minRecordingMs?: number;
  silenceAfterSpeechMs?: number;
  maxRecordingMs?: number;
}) {
  if (elapsedMs >= maxRecordingMs) {
    return true;
  }

  return (
    heardSpeech &&
    elapsedMs >= minRecordingMs &&
    rms < silenceThreshold &&
    silenceMs >= silenceAfterSpeechMs
  );
}
