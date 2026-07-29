import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreferencesResponse, TtsProvider, Voice } from '@kairo/shared';
import type { NativeBridge } from '../native/nativeBridge';
import { klog } from '../core/logger';
import { KButton } from '../components/KButton';
import { Segmented } from '../components/Segmented';

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

  const save = async (patch: { ttsProvider?: TtsProvider; ttsVoiceId?: string }) => {
    setError('');
    setSaving(true);
    try {
      const next = await bridge.setSpeechPreferences(patch);
      setPrefs(next);
      // The server may land on a different voice than requested (engine switch → that engine's
      // default), so the list is reloaded from what it actually stored, not from the request.
      await loadVoices(next.ttsProvider);
      klog('settings', 'info', 'voice preference saved', {
        provider: next.ttsProvider,
        voice: next.ttsVoiceId,
      });
    } catch (err) {
      setError(String(err).replace(/^.*?:\s*/, ''));
      klog('settings', 'warn', 'voice preference save failed', { error: String(err) });
    }
    setSaving(false);
  };

  const preview = async (voiceId: string) => {
    if (!prefs) return;
    setError('');
    setPreviewing(voiceId);
    try {
      const audio = await bridge.previewVoice(prefs.ttsProvider, voiceId);
      audioRef.current?.pause();
      const element = new Audio(`data:${audio.mimeType};base64,${audio.audioBase64}`);
      audioRef.current = element;
      await element.play();
    } catch (err) {
      setError(String(err).replace(/^.*?:\s*/, ''));
      klog('settings', 'warn', 'voice preview failed', { error: String(err) });
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

  const selected = voices.find((voice) => voice.id === prefs.ttsVoiceId);

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

      <div className="settings-row">
        <select
          className="s-input"
          value={prefs.ttsVoiceId}
          disabled={saving || voices.length === 0}
          onChange={(e) => void save({ ttsVoiceId: e.target.value })}
        >
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
              {voice.gender !== 'unknown' ? ` · ${voice.gender}` : ''}
            </option>
          ))}
        </select>
        <KButton
          variant="ghost"
          disabled={voices.length === 0}
          busy={!!previewing}
          onClick={() => void preview(prefs.ttsVoiceId)}
        >
          {previewing ? 'Playing…' : 'Preview'}
        </KButton>
      </div>

      {selected?.description && (
        <p className="settings-muted s-voice-desc">{selected.description}</p>
      )}
      {error && (
        <p className="settings-muted s-voice-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
