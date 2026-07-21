import { describe, expect, test } from 'vitest';
import {
  createVoiceRecorder,
  encodeWavFromFloat32Chunks,
  rmsFromTimeDomainData,
  shouldStopVoiceCapture,
  voiceFilenameForMimeType,
  voiceStatusCopy
} from '../src/notch/voiceRecorder';

describe('voiceRecorder helpers', () => {
  test('creates a recorder with the first supported MIME type', () => {
    class FakeRecorder {
      static isTypeSupported(mimeType: string) {
        return mimeType === 'audio/mp4';
      }

      mimeType: string;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? '';
      }
    }

    const result = createVoiceRecorder({} as MediaStream, FakeRecorder as unknown as typeof MediaRecorder);

    expect(result.mimeType).toBe('audio/mp4');
    expect(result.recorder.mimeType).toBe('audio/mp4');
  });

  test('falls back to bare MediaRecorder construction when MIME-specific creation fails', () => {
    class FakeRecorder {
      static isTypeSupported() {
        return true;
      }

      mimeType: string;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        if (options?.mimeType) {
          throw new Error('unsupported constructor option');
        }

        this.mimeType = '';
      }
    }

    const result = createVoiceRecorder({} as MediaStream, FakeRecorder as unknown as typeof MediaRecorder);

    expect(result.mimeType).toBe('');
    expect(result.recorder.mimeType).toBe('');
  });

  test('describes recording and transcription states', () => {
    expect(voiceStatusCopy('recording')).toEqual({
      title: 'Kairo is listening',
      detail: 'Speak now'
    });
    expect(voiceStatusCopy('transcribing')).toEqual({
      title: 'Kairo is transcribing',
      detail: 'Turning voice into text'
    });
  });

  test('computes signal level from time-domain audio samples', () => {
    expect(rmsFromTimeDomainData(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(rmsFromTimeDomainData(new Uint8Array([255, 128, 1]))).toBeGreaterThan(0.5);
  });

  test('maps recorder MIME type to a matching upload filename', () => {
    expect(voiceFilenameForMimeType('audio/webm;codecs=opus')).toBe('kairo-voice.webm');
    expect(voiceFilenameForMimeType('audio/mp4')).toBe('kairo-voice.m4a');
    expect(voiceFilenameForMimeType('audio/mpeg')).toBe('kairo-voice.mp3');
    expect(voiceFilenameForMimeType('audio/wav')).toBe('kairo-voice.wav');
  });

  test('encodes mono float samples into a wav blob', async () => {
    const blob = encodeWavFromFloat32Chunks([new Float32Array([0, 0.5, -0.5])], 24_000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const header = new TextDecoder().decode(bytes.slice(0, 4));

    expect(blob.type).toBe('audio/wav');
    expect(header).toBe('RIFF');
    expect(bytes.length).toBe(44 + 3 * 2);
  });

  test('stops after speech is followed by enough silence', () => {
    expect(
      shouldStopVoiceCapture({
        elapsedMs: 3200,
        heardSpeech: true,
        silenceMs: 2100,
        rms: 0.001
      })
    ).toBe(true);
  });

  test('keeps recording through a short mid-thought pause', () => {
    // A ~1s pause must NOT submit — the user may resume talking.
    expect(
      shouldStopVoiceCapture({
        elapsedMs: 2200,
        heardSpeech: true,
        silenceMs: 1000,
        rms: 0.001
      })
    ).toBe(false);
  });

  test('does not stop on startup silence before speech is heard', () => {
    expect(
      shouldStopVoiceCapture({
        elapsedMs: 4000,
        heardSpeech: false,
        silenceMs: 4000,
        rms: 0.001
      })
    ).toBe(false);
  });

  test('stops earlier when no speech is detected after the startup window', () => {
    expect(
      shouldStopVoiceCapture({
        elapsedMs: 5000,
        heardSpeech: false,
        silenceMs: 5000,
        rms: 0.001
      })
    ).toBe(true);
  });

  test('stops at the maximum recording duration even without detected speech', () => {
    expect(
      shouldStopVoiceCapture({
        elapsedMs: 18_000,
        heardSpeech: false,
        silenceMs: 18_000,
        rms: 0.001
      })
    ).toBe(true);
  });
});
