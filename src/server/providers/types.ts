import type { TutorPlannerAdapter } from '../../core/orchestrator';

export type AudioInput = {
  audio?: Uint8Array | ArrayBuffer | Blob;
  mimeType?: string;
  filename?: string;
};

export type TranscriptionResult = {
  text: string;
};

export type SpeechSynthesisInput = {
  text: string;
};

export type SpeechSynthesisResult = {
  audioBase64: string;
  mimeType: string;
};

export type SpeechToTextAdapter = {
  transcribe(input?: AudioInput): Promise<TranscriptionResult>;
};

export type TextToSpeechAdapter = {
  synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult>;
};

export type ProviderAdapters = {
  kind: {
    planner: 'mock' | 'openrouter';
    stt: 'mock' | 'sarvam' | 'elevenlabs';
    tts: 'mock' | 'sarvam' | 'elevenlabs';
  };
  planner: TutorPlannerAdapter;
  stt: SpeechToTextAdapter;
  tts: TextToSpeechAdapter;
};

export type ProviderSecrets = {
  openRouterApiKey?: string;
  sarvamApiKey?: string;
  elevenLabsApiKey?: string;
};

export function createMockSpeechToTextAdapter(): SpeechToTextAdapter {
  return {
    async transcribe() {
      return { text: '' };
    }
  };
}

export function createMockTextToSpeechAdapter(): TextToSpeechAdapter {
  return {
    async synthesize() {
      return {
        audioBase64: '',
        mimeType: 'audio/wav'
      };
    }
  };
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const errorPayload = payload as { error?: { message?: string }; message?: string };
    throw new Error(errorPayload.error?.message ?? errorPayload.message ?? `HTTP ${response.status}`);
  }

  return payload as T;
}

export function toAudioBlob(input: AudioInput): Blob {
  if (input.audio instanceof Blob) {
    return input.audio;
  }

  const audio = input.audio ?? new Uint8Array();
  const audioBytes = audio instanceof ArrayBuffer ? new Uint8Array(audio) : new Uint8Array(audio);
  const bytes = new Uint8Array(audioBytes.byteLength);
  bytes.set(audioBytes);

  return new Blob([bytes.buffer as ArrayBuffer], {
    type: input.mimeType ?? 'application/octet-stream'
  });
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}
