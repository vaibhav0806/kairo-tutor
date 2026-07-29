import { useEffect, useMemo, useRef, useState } from 'react';
import type { Voice } from '@kairo/shared';
import { klog } from '../core/logger';

/**
 * The voice list: search, filters, and a per-row preview.
 *
 * The old picker was a native `<select>`, which is the wrong control for this data twice over.
 * ElevenLabs' catalogue is fetched live and can run to hundreds of entries, so there was no way to
 * find a voice; and Preview played whatever was already SAVED, so auditioning a voice meant
 * committing to it first — a server write per curiosity.
 *
 * Here, ▶ on any row plays that voice without touching preferences, and the row itself selects.
 * Language is the axis people actually choose on (Kairo's wedge is multilingual), so it leads;
 * the engine is metadata, not a top-level split.
 */

// Just the languages Sarvam + ElevenLabs actually return. Anything unlisted falls back to the raw
// BCP-47 subtag, so a new language never disappears from the filter row.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  gu: 'Gujarati',
  kn: 'Kannada',
  ml: 'Malayalam',
  pa: 'Punjabi',
  od: 'Odia',
  or: 'Odia'
};

export function languageLabel(tag: string): string {
  const base = tag.split('-')[0]?.toLowerCase() ?? tag;
  return LANGUAGE_NAMES[base] ?? base.toUpperCase();
}

/** Every language present in the catalogue, most common first — the filter row's contents. */
export function languagesInCatalogue(voices: Voice[]): string[] {
  const counts = new Map<string, number>();
  for (const voice of voices) {
    for (const tag of voice.languages) {
      const label = languageLabel(tag);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label]) => label);
}

export type VoiceFilters = { language: string | null; gender: 'male' | 'female' | null };

/** Search + filters, applied together. Exported so the behaviour is testable without a DOM. */
export function filterVoices(voices: Voice[], query: string, filters: VoiceFilters): Voice[] {
  const needle = query.trim().toLowerCase();
  return voices.filter((voice) => {
    if (filters.gender && voice.gender !== filters.gender) return false;
    if (filters.language && !voice.languages.some((tag) => languageLabel(tag) === filters.language)) {
      return false;
    }
    if (!needle) return true;
    const haystack = `${voice.name} ${voice.description ?? ''} ${voice.languages.join(' ')}`;
    return haystack.toLowerCase().includes(needle);
  });
}

export function VoicePicker({
  voices,
  selectedId,
  busy,
  previewingId,
  onSelect,
  onPreview
}: {
  voices: Voice[];
  selectedId: string;
  busy: boolean;
  previewingId: string;
  onSelect: (voiceId: string) => void;
  onPreview: (voiceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<VoiceFilters>({ language: null, gender: null });
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = voices.find((voice) => voice.id === selectedId);
  const languages = useMemo(() => languagesInCatalogue(voices), [voices]);
  const results = useMemo(() => filterVoices(voices, query, filters), [voices, query, filters]);

  // The filter row is noise on a curated six-voice list; it earns its space only on a big one.
  const showFilters = voices.length >= 8;

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // A changed catalogue (engine switch) invalidates whatever was typed.
  useEffect(() => {
    setQuery('');
    setFilters({ language: null, gender: null });
  }, [voices]);

  const meta = (voice: Voice) =>
    [voice.languages.length > 0 ? languageLabel(voice.languages[0]) : null,
     voice.gender !== 'unknown' ? voice.gender : null]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="vp">
      <div className="vp-current">
        <div className="vp-current-body">
          <span className="vp-current-name">{selected?.name ?? 'No voice selected'}</span>
          {selected ? <span className="settings-muted">{meta(selected)}</span> : null}
        </div>
        <button
          type="button"
          className="vp-play"
          aria-label={selected ? `Preview ${selected.name}` : 'Preview voice'}
          disabled={!selected || previewingId !== ''}
          onClick={() => selected && onPreview(selected.id)}
        >
          {previewingId === selectedId && previewingId !== '' ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="vp-change"
          aria-expanded={open}
          onClick={() => {
            klog('settings', 'debug', 'voice list toggled', { open: !open, voices: voices.length });
            setOpen((previous) => !previous);
          }}
        >
          {open ? 'Done' : 'Change'}
        </button>
      </div>

      {open ? (
        <div className="vp-panel">
          <div className="vp-search">
            <span aria-hidden>⌕</span>
            <input
              ref={searchRef}
              value={query}
              placeholder={`Search ${voices.length} voices…`}
              aria-label="Search voices"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setOpen(false);
              }}
            />
            {query ? (
              <button type="button" className="vp-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                ✕
              </button>
            ) : null}
          </div>

          {showFilters ? (
            <div className="vp-filters">
              {languages.slice(0, 6).map((language) => (
                <button
                  key={language}
                  type="button"
                  className="vp-chip"
                  data-on={filters.language === language}
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      language: previous.language === language ? null : language
                    }))
                  }
                >
                  {language}
                </button>
              ))}
              {(['female', 'male'] as const).map((gender) => (
                <button
                  key={gender}
                  type="button"
                  className="vp-chip"
                  data-on={filters.gender === gender}
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      gender: previous.gender === gender ? null : gender
                    }))
                  }
                >
                  {gender}
                </button>
              ))}
            </div>
          ) : null}

          <div className="vp-list" role="listbox" aria-label="Voices">
            {results.map((voice) => {
              const isSelected = voice.id === selectedId;
              return (
                <div
                  key={voice.id}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  className="vp-row"
                  data-selected={isSelected}
                  onClick={() => !busy && onSelect(voice.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (!busy) onSelect(voice.id);
                    }
                  }}
                >
                  <button
                    type="button"
                    className="vp-play"
                    aria-label={`Preview ${voice.name}`}
                    disabled={previewingId !== ''}
                    onClick={(event) => {
                      // Preview must never select — auditioning is not choosing.
                      event.stopPropagation();
                      onPreview(voice.id);
                    }}
                  >
                    {previewingId === voice.id ? '❚❚' : '▶'}
                  </button>
                  <span className="vp-row-body">
                    <span className="vp-row-name">{voice.name}</span>
                    <span className="settings-muted vp-row-meta">
                      {voice.description || meta(voice)}
                    </span>
                  </span>
                  {isSelected ? <span className="vp-check" aria-hidden>✓</span> : null}
                </div>
              );
            })}
            {results.length === 0 ? (
              <p className="settings-muted vp-empty">No voice matches that.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
