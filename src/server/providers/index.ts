import type { KairoEnv } from '../../config/env';
import { createMockTutorPlanner } from '../../core/mockTutor';
import type { TutorPlannerAdapter } from '../../core/orchestrator';
import { createElevenLabsSpeechClient } from './elevenLabs';
import { createOpenRouterClient } from './openRouter';
import { createSarvamSpeechClient } from './sarvam';
import {
  createMockSpeechToTextAdapter,
  createMockTextToSpeechAdapter,
  type ProviderAdapters,
  type ProviderSecrets,
  type SpeechToTextAdapter,
  type TextToSpeechAdapter
} from './types';
import { createOpenRouterTutorPlanner } from './tutorPlanner';

export type CreateProviderAdaptersOptions = {
  env: KairoEnv;
  secrets?: ProviderSecrets;
  fetchImpl?: typeof fetch;
};

function createMockPlannerAdapter(): TutorPlannerAdapter {
  const mockPlanner = createMockTutorPlanner();

  return async (input) =>
    mockPlanner.planNextStep({
      ...input.activeApp,
      userQuery: input.userQuery,
      annotations: input.annotations
    });
}

function requireSecret(value: string | undefined, message: string) {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function createPlannerAdapter({
  env,
  secrets,
  fetchImpl
}: CreateProviderAdaptersOptions): TutorPlannerAdapter {
  if (env.aiProvider === 'mock') {
    return createMockPlannerAdapter();
  }

  const apiKey = requireSecret(
    secrets?.openRouterApiKey,
    'OPENROUTER_API_KEY is required to create the OpenRouter planner adapter'
  );

  return createOpenRouterTutorPlanner(
    createOpenRouterClient({
      apiKey,
      model: env.openRouterModel,
      baseUrl: env.openRouterBaseUrl,
      siteUrl: env.openRouterSiteUrl,
      appTitle: env.openRouterAppTitle,
      fetchImpl
    })
  );
}

function createSarvamClient({
  env,
  secrets,
  fetchImpl
}: CreateProviderAdaptersOptions) {
  return createSarvamSpeechClient({
    apiKey: requireSecret(
      secrets?.sarvamApiKey,
      'SARVAM_API_KEY is required to create the Sarvam speech adapter'
    ),
    baseUrl: env.sarvamBaseUrl,
    sttModel: env.sarvamSttModel,
    sttMode: env.sarvamSttMode,
    ttsModel: env.sarvamTtsModel,
    ttsLanguageCode: env.sarvamTtsLanguageCode,
    ttsSpeaker: env.sarvamTtsSpeaker,
    fetchImpl
  });
}

function createElevenLabsClient({
  env,
  secrets,
  fetchImpl
}: CreateProviderAdaptersOptions) {
  return createElevenLabsSpeechClient({
    apiKey: requireSecret(
      secrets?.elevenLabsApiKey,
      'ELEVENLABS_API_KEY is required to create the ElevenLabs speech adapter'
    ),
    baseUrl: env.elevenLabsBaseUrl,
    sttModel: env.elevenLabsSttModel,
    ttsModel: env.elevenLabsTtsModel,
    voiceId: env.elevenLabsVoiceId,
    fetchImpl
  });
}

function createSttAdapter(options: CreateProviderAdaptersOptions): SpeechToTextAdapter {
  if (options.env.sttProvider === 'mock') {
    return createMockSpeechToTextAdapter();
  }

  if (options.env.sttProvider === 'sarvam') {
    return createSarvamClient(options);
  }

  return createElevenLabsClient(options);
}

function createTtsAdapter(options: CreateProviderAdaptersOptions): TextToSpeechAdapter {
  if (options.env.ttsProvider === 'mock') {
    return createMockTextToSpeechAdapter();
  }

  if (options.env.ttsProvider === 'sarvam') {
    return createSarvamClient(options);
  }

  return createElevenLabsClient(options);
}

export function createProviderAdapters(options: CreateProviderAdaptersOptions): ProviderAdapters {
  return {
    kind: {
      planner: options.env.aiProvider,
      stt: options.env.sttProvider,
      tts: options.env.ttsProvider
    },
    planner: createPlannerAdapter(options),
    stt: createSttAdapter(options),
    tts: createTtsAdapter(options)
  };
}

export type {
  ProviderAdapters,
  ProviderSecrets,
  SpeechToTextAdapter,
  TextToSpeechAdapter
} from './types';
