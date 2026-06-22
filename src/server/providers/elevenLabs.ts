import {
  arrayBufferToBase64,
  parseJsonResponse,
  toAudioBlob,
  type AudioInput,
  type SpeechSynthesisInput,
  type SpeechSynthesisResult,
  type SpeechToTextAdapter,
  type TextToSpeechAdapter,
  type TranscriptionResult
} from './types';

export type ElevenLabsSpeechClientConfig = {
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  voiceId: string;
  fetchImpl?: typeof fetch;
};

type ElevenLabsTranscriptionResponse = {
  text?: string;
};

export function createElevenLabsSpeechClient(
  config: ElevenLabsSpeechClientConfig
): SpeechToTextAdapter & TextToSpeechAdapter {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  return {
    async transcribe(input: AudioInput = {}): Promise<TranscriptionResult> {
      const formData = new FormData();
      formData.set(
        'file',
        toAudioBlob(input),
        input.filename ?? `kairo-audio.${input.mimeType?.includes('mpeg') ? 'mp3' : 'wav'}`
      );
      formData.set('model_id', config.sttModel);

      const payload = await parseJsonResponse<ElevenLabsTranscriptionResponse>(
        await fetchImpl(`${baseUrl}/v1/speech-to-text`, {
          method: 'POST',
          headers: {
            'xi-api-key': config.apiKey
          },
          body: formData
        })
      );

      if (!payload.text) {
        throw new Error('ElevenLabs STT response did not include transcript text');
      }

      return { text: payload.text };
    },

    async synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
      const response = await fetchImpl(`${baseUrl}/v1/text-to-speech/${config.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': config.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: input.text,
          model_id: config.ttsModel
        })
      });

      if (!response.ok) {
        const payload = await parseJsonResponse<{ detail?: { message?: string }; message?: string }>(
          response
        );
        throw new Error(payload.detail?.message ?? payload.message ?? `HTTP ${response.status}`);
      }

      return {
        audioBase64: arrayBufferToBase64(await response.arrayBuffer()),
        mimeType: response.headers.get('content-type') ?? 'audio/mpeg'
      };
    }
  };
}
