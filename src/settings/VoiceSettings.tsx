import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreferencesResponse, TtsProvider, Voice } from '@kairo/shared';
import type { NativeBridge } from '../native/nativeBridge';
import { klog } from '../core/logger';
import { Segmented } from '../components/Segmented';
import { notify, notifySaving } from '../core/notify';
import { VoicePicker } from './VoicePicker';

const PROVIDER_LABEL: Record<TtsProvider, string> = {
  sarvam: 'Sarvam',
  elevenlabs: 'ElevenLabs',
};

const PROVIDER_BLURB: Record<TtsProvider, string> = {
  sarvam: 'Indian-language voices. Best for Hindi and Hinglish.',
  elevenlabs: 'Expressive multilingual voices.',
};

/**
 * Voice picker. Everything here is server state — the catalog, the stored choice, and the preview
 * audio — so the desktop holds no vendor knowledge and a voice survives a reinstall.
 */
export function VoiceSettings({ bridge }: { bridge: NativeBridge }) {
  const [prefs, setPrefs] = useState<PreferencesResponse | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState('');
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const loadVoices = useCallback(
    async (provider: TtsProvider) => {
      const result = await bridge.listVoices(provider);
      setVoices(result?.voices ?? []);
      if (!result) setError('Could not load voices. Check your connection.');
    },
    [bridge],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await bridge.getSpeechPreferences();
      if (cancelled) return;
      setPrefs(current);
      if (current) await loadVoices(current.ttsProvider);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
      // Stop any preview still playing when Settings closes.
      audioRef.current?.pause();
    };
  }, [bridge, loadVoices]);

  // Optimistic: paint the choice immediately and reconcile with whatever the server actually
  // stored. The picker used to disable itself for the whole round-trip, which made every voice
  // change feel like the app had stalled.
  const save = async (patch: { ttsProvider?: TtsProvider; ttsVoiceId?: string }) => {
    if (!prefs) return;
    const previous = prefs;
    setError('');
    setSaving(true);
    setPrefs({ ...prefs, ...patch });
    try {
      const next = await notifySaving(bridge.setSpeechPreferences(patch), {
        pending: 'Saving voice…',
        success: patch.ttsProvider ? 'Voice engine changed' : 'Voice saved',
      });
      setPrefs(next);
      // The server may land on a different voice than requested (engine switch → that engine's
      // default), so the list is reloaded from what it actually stored, not from the request.
      await loadVoices(next.ttsProvider);
      klog('settings', 'info', 'voice preference saved', {
        provider: next.ttsProvider,
        voice: next.ttsVoiceId,
      });
    } catch (err) {
      setPrefs(previous);
      klog('settings', 'warn', 'voice preference save failed', { error: String(err) });
    }
    setSaving(false);
  };

  // Auditioning is not choosing: this plays ANY voice id without writing preferences.
  const preview = async (voiceId: string) => {
    if (!prefs) return;
    setPreviewing(voiceId);
    try {
      const audio = await bridge.previewVoice(prefs.ttsProvider, voiceId);
      audioRef.current?.pause();
      const element = new Audio(`data:${audio.mimeType};base64,${audio.audioBase64}`);
      audioRef.current = element;
      // Hold the ❚❚ state for the length of the clip, so the row shows what is playing.
      element.addEventListener('ended', () => setPreviewing((current) => (current === voiceId ? '' : current)));
      await element.play();
      klog('settings', 'debug', 'voice previewed', { voice: voiceId });
      return;
    } catch (err) {
      klog('settings', 'warn', 'voice preview failed', { error: String(err) });
      notify({
        tone: 'error',
        message: "Couldn't play that voice",
        detail: String(err).replace(/^.*?:\s*/, ''),
      });
    }
    setPreviewing('');
  };

  if (loading) {
    return (
      <section className="s-section">
        <div className="s-label">Voice</div>
        <p className="settings-muted">Loading voices…</p>
      </section>
    );
  }

  // Signed out or backend unreachable — say so plainly instead of showing an empty picker.
  if (!prefs) {
    return (
      <section className="s-section">
        <div className="s-label">Voice</div>
        <p className="settings-muted">Sign in to choose how Kairo sounds.</p>
      </section>
    );
  }

  return (
    <section className="s-section">
      <div className="s-label">Voice</div>

      {prefs.availableProviders.length > 1 && (
        <Segmented
          label="Voice engine"
          disabled={saving}
          value={prefs.ttsProvider}
          options={prefs.availableProviders.map((provider) => ({
            value: provider,
            label: PROVIDER_LABEL[provider]
          }))}
          onChange={(provider) => {
            if (provider !== prefs.ttsProvider) void save({ ttsProvider: provider });
          }}
        />
      )}
      <p className="settings-muted s-voice-blurb">{PROVIDER_BLURB[prefs.ttsProvider]}</p>

      <VoicePicker
        voices={voices}
        selectedId={prefs.ttsVoiceId}
        busy={saving}
        previewingId={previewing}
        onSelect={(voiceId) => {
          if (voiceId !== prefs.ttsVoiceId) void save({ ttsVoiceId: voiceId });
        }}
        onPreview={(voiceId) => void preview(voiceId)}
      />

      {/* A catalogue that failed to load is a STATE, not an event — it stays inline, with a way
          out, rather than flashing past in a toast. */}
      {error && (
        <p className="settings-muted s-voice-error" role="alert">
          {error}{' '}
          <button type="button" className="s-link" onClick={() => void loadVoices(prefs.ttsProvider)}>
            Retry
          </button>
        </p>
      )}
    </section>
  );
}
