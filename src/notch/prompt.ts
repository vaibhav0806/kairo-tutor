import type { NotchPayload } from './types';

export type NotchAskPayload = {
  query: string;
};

export type EmitNotchAsk = (payload: NotchAskPayload) => Promise<void>;

export function isNotchPromptVisible(payload: NotchPayload) {
  return payload.state === 'captured';
}

export function buildNotchAskPayload(query: string): NotchAskPayload {
  return {
    query: query.trim()
  };
}

export async function submitNotchPrompt(query: string, emitAsk: EmitNotchAsk) {
  const payload = buildNotchAskPayload(query);
  if (!payload.query) {
    return;
  }

  await emitAsk(payload);
}
