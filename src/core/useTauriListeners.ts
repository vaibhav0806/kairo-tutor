import { useEffect, type DependencyList } from 'react';

type UnlistenFn = () => void;

// Subscribe to a set of Tauri events for the lifetime of the effect. Handles the two
// races every window was hand-rolling three different ways:
//   1. listen() resolves asynchronously — if we unmount before it does, the resolved
//      unlisten is called immediately so we never leak a subscription.
//   2. on cleanup (unmount / deps change) every resolved listener is unlistened.
// The event bus is absent in browser-preview / tests, so subscribe failures are
// swallowed. `factories` is an array of thunks (each returns listen(...)); `deps`
// controls re-subscription (pass [] to subscribe once).
export function useTauriListeners(
  factories: Array<() => Promise<UnlistenFn>>,
  deps: DependencyList
) {
  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    for (const make of factories) {
      make()
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        })
        .catch(() => {
          // Browser preview / tests run without the Tauri event bus.
        });
    }

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
