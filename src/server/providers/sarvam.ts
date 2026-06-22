import {
  parseJsonResponse,
  toAudioBlob,
  type AudioInput,
  type SpeechSynthesisInput,
  type SpeechSynthesisResult,
  type SpeechToTextAdapter,
  type TextToSpeechAdapter,
  type TranscriptionResult
} from './types';

export type SarvamSpeechClientConfig = {
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  sttMode: string;
  ttsModel: string;
  ttsLanguageCode: string;
  ttsSpeaker: string;
  fetchImpl?: typeof fetch;
};

type SarvamTranscriptionResponse = {
  transcript?: string;
  text?: string;
};

type SarvamTtsResponse = {
  audios?: string[];
};

export function createSarvamSpeechClient(
  config: SarvamSpeechClientConfig
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
      formData.set('model', config.sttModel);
      formData.set('mode', config.sttMode);

      const payload = await parseJsonResponse<SarvamTranscriptionResponse>(
        await fetchImpl(`${baseUrl}/speech-to-text`, {
          method: 'POST',
          headers: {
            'api-subscription-key': config.apiKey
          },
          body: formData
        })
      );

      const text = payload.transcript ?? payload.text;
      if (!text) {
        throw new Error('Sarvam STT response did not include transcript text');
      }

      return { text };
    },

    async synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
      const payload = await parseJsonResponse<SarvamTtsResponse>(
        await fetchImpl(`${baseUrl}/text-to-speech`, {
          method: 'POST',
          headers: {
            'api-subscription-key': config.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: input.text,
            target_language_code: config.ttsLanguageCode,
            speaker: config.ttsSpeaker,
            model: config.ttsModel,
            output_audio_codec: 'wav',
            speech_sample_rate: 24000
          })
        })
      );

      const audioBase64 = payload.audios?.[0];
      if (!audioBase64) {
        throw new Error('Sarvam TTS response did not include audio');
      }

      return {
        audioBase64,
        mimeType: 'audio/wav'
      };
    }
  };
}
