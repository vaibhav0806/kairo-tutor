import { describe, expect, it } from 'vitest';
import type { Voice } from '@kairo/shared';
import { filterVoices, languageLabel, languagesInCatalogue } from '../src/settings/VoicePicker';
import { filterSkills } from '../src/settings/SkillsDialog';

const voice = (partial: Partial<Voice> & { id: string; name: string }): Voice => ({
  provider: 'sarvam',
  gender: 'unknown',
  languages: [],
  ...partial
});

const CATALOGUE: Voice[] = [
  voice({ id: 'anushka', name: 'Anushka', gender: 'female', languages: ['hi-IN', 'en-IN'] }),
  voice({ id: 'abhilash', name: 'Abhilash', gender: 'male', languages: ['hi-IN'] }),
  voice({ id: 'vidya', name: 'Vidya', gender: 'female', languages: ['ta-IN'] }),
  voice({
    id: 'rachel',
    name: 'Rachel',
    gender: 'female',
    languages: ['en-US'],
    description: 'Calm narration voice',
    provider: 'elevenlabs'
  })
];

describe('languageLabel', () => {
  it('names the languages the catalogues actually return', () => {
    expect(languageLabel('hi-IN')).toBe('Hindi');
    expect(languageLabel('en-US')).toBe('English');
  });

  it('falls back to the subtag so a new language never vanishes from the filters', () => {
    expect(languageLabel('as-IN')).toBe('AS');
  });
});

describe('languagesInCatalogue', () => {
  // Hindi and English both appear twice here, so the alphabetical tie-break decides — the order
  // has to be stable, otherwise the filter chips reshuffle every time the catalogue reloads.
  it('lists every language present, most common first, ties broken alphabetically', () => {
    expect(languagesInCatalogue(CATALOGUE)).toEqual(['English', 'Hindi', 'Tamil']);
  });

  it('ranks a genuinely more common language first', () => {
    const extraHindi = [...CATALOGUE, voice({ id: 'karun', name: 'Karun', languages: ['hi-IN'] })];
    expect(languagesInCatalogue(extraHindi)[0]).toBe('Hindi');
  });
});

describe('filterVoices', () => {
  const none = { language: null, gender: null };

  it('returns everything with no query and no filters', () => {
    expect(filterVoices(CATALOGUE, '', none)).toHaveLength(4);
  });

  it('matches on name regardless of case', () => {
    expect(filterVoices(CATALOGUE, 'ra', none).map((v) => v.id)).toEqual(['rachel']);
  });

  it('matches on the description too', () => {
    expect(filterVoices(CATALOGUE, 'narration', none).map((v) => v.id)).toEqual(['rachel']);
  });

  it('filters by language using the display label', () => {
    expect(filterVoices(CATALOGUE, '', { language: 'Hindi', gender: null }).map((v) => v.id)).toEqual([
      'anushka',
      'abhilash'
    ]);
  });

  it('combines search, language and gender', () => {
    expect(
      filterVoices(CATALOGUE, 'a', { language: 'Hindi', gender: 'female' }).map((v) => v.id)
    ).toEqual(['anushka']);
  });

  it('returns nothing when the combination excludes everything', () => {
    expect(filterVoices(CATALOGUE, '', { language: 'Tamil', gender: 'male' })).toEqual([]);
  });
});

describe('filterSkills', () => {
  const skills = [
    { slug: 'blender', name: 'Blender', description: '3D modelling guidance', enabled: true },
    { slug: 'figma', name: 'Figma', description: 'Design tool walkthroughs', enabled: true },
    { slug: 'excel', name: 'Excel', description: 'Spreadsheet formulas', enabled: false }
  ];

  it('returns everything for an empty query', () => {
    expect(filterSkills(skills, '  ')).toHaveLength(3);
  });

  it('matches the name and the description', () => {
    expect(filterSkills(skills, 'design').map((s) => s.slug)).toEqual(['figma']);
    expect(filterSkills(skills, 'BLEND').map((s) => s.slug)).toEqual(['blender']);
  });
});
