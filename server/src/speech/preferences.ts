import { sql } from 'drizzle-orm';
import { isTtsProvider, type PreferencesResponse, type TtsProvider } from '@kairo/shared';
import { db } from '../db/client';
import { defaultTtsProvider, enabledTtsProviders } from '../config/env';
import { defaultVoiceFor, isKnownVoice } from './catalog';

/**
 * Effective speech settings for a user.
 *
 * Resolution is deliberately forgiving: a stored provider that has since been disabled (key pulled,
 * allowlist narrowed) or a voice id that no longer exists must never break synthesis — it falls back
 * to the deployment default. A user cannot pin the server into calling an engine we turned off.
 */
export async function readPreferences(userId: string): Promise<PreferencesResponse> {
  const rows = await db.execute(
    sql`SELECT tts_provider, tts_voice_id FROM user_preference WHERE user_id = ${userId}`,
  );
  const row = rows.rows[0] as { tts_provider?: string | null; tts_voice_id?: string | null } | undefined;

  const stored = row?.tts_provider;
  const provider: TtsProvider =
    isTtsProvider(stored) && enabledTtsProviders.includes(stored) ? stored : defaultTtsProvider;

  // Only honour the stored voice when it belongs to the provider we actually resolved — switching
  // engines must not carry a Sarvam speaker name into an ElevenLabs voice_id slot.
  const storedVoice = row?.tts_voice_id ?? null;
  const voiceId =
    storedVoice && provider === stored && (await isKnownVoice(provider, storedVoice).catch(() => false))
      ? storedVoice
      : defaultVoiceFor(provider);

  return { ttsProvider: provider, ttsVoiceId: voiceId, availableProviders: enabledTtsProviders };
}

/**
 * Persist a preference change. The caller validates the (provider, voice) pair against the live
 * catalog first; this only writes.
 */
export async function writePreferences(
  userId: string,
  next: { ttsProvider: TtsProvider; ttsVoiceId: string },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO user_preference (user_id, tts_provider, tts_voice_id)
        VALUES (${userId}, ${next.ttsProvider}, ${next.ttsVoiceId})
        ON CONFLICT (user_id) DO UPDATE
          SET tts_provider = EXCLUDED.tts_provider,
              tts_voice_id = EXCLUDED.tts_voice_id,
              updated_at = now()`,
  );
}
