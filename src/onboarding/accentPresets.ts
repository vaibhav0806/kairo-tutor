// Kairo's curated accent presets (founder-approved 2026-07-23). Replaces the free HSV color wheel: a
// vetted set so no pick can look bad / vanish on a light background. All 8 are deep, saturated mid-tones
// spread across the hue wheel (no pale/light colors). The `name` is INTERNAL only — the UI shows just the
// swatch. Kept in sync with DEFAULT_ACCENT in core/accent.ts (Nebula = the brand default).
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Nebula', hex: '#7c3aed' }, // deep electric violet (brand default)
  { name: 'Ember', hex: '#ea580c' }, // burnt orange
  { name: 'Tide', hex: '#0891b2' }, // deep cyan
  { name: 'Flare', hex: '#dc2626' }, // strong crimson red
  { name: 'Verdant', hex: '#059669' }, // deep emerald green
  { name: 'Bloom', hex: '#db2777' }, // deep magenta pink
  { name: 'Cobalt', hex: '#2563eb' }, // confident deep blue
  { name: 'Zest', hex: '#65a30d' }, // deep lime green
];
