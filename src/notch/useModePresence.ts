import { useEffect, useRef, useState } from 'react';

export type Presence<T> = { key: T; phase: 'in' | 'out' };

// Keep the outgoing mode mounted for `ms` so its content can cross-fade/blur out while
// the new content fades in and the capsule box morphs. Returns 1 (steady) or 2 (during
// a transition) layers to render in the same grid cell.
export function useModePresence<T>(mode: T, ms: number): Presence<T>[] {
  const [layers, setLayers] = useState<Presence<T>[]>([{ key: mode, phase: 'in' }]);
  const prev = useRef(mode);
  useEffect(() => {
    if (prev.current === mode) return;
    const leaving = prev.current;
    prev.current = mode;
    setLayers([
      { key: leaving, phase: 'out' },
      { key: mode, phase: 'in' }
    ]);
    const t = setTimeout(() => setLayers([{ key: mode, phase: 'in' }]), ms);
    return () => clearTimeout(t);
  }, [mode, ms]);
  return layers;
}
