// Convert a #rrggbb (or #rgb) hex to a space-separated "r g b" triple for CSS
// `rgb(var(--x) / a)` usage — matches the existing --box-rgb convention in styles.css.
// Returns null for malformed input so callers can fall back to a default.
export function hexToRgbTriple(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `${r} ${g} ${b}`;
}
