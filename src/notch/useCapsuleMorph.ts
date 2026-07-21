import { useEffect, type RefObject } from 'react';

// Observe the inner content (width: max-content) and mirror its measured size onto the
// outer capsule as --capsule-w / --capsule-h, which the capsule transitions (spring).
// Content swaps instantly inside; the box morphs smoothly around it.
export function useCapsuleMorph(
  outerRef: RefObject<HTMLElement | null>,
  innerRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      outer.style.setProperty('--capsule-w', `${Math.ceil(inner.offsetWidth)}px`);
      outer.style.setProperty('--capsule-h', `${Math.ceil(inner.offsetHeight)}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [outerRef, innerRef]);
}
