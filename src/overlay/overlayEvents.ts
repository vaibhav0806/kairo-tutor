import type { OverlayPayload } from './OverlayApp';

type OverlayEvent<T> = {
  payload: T;
};

type OverlayListen = <T>(
  eventName: string,
  handler: (event: OverlayEvent<T>) => void
) => Promise<() => void>;

export async function subscribeToOverlayPayload({
  listen,
  readCurrentPayload,
  onPayload
}: {
  listen: OverlayListen;
  readCurrentPayload: () => Promise<OverlayPayload | null>;
  onPayload: (payload: OverlayPayload) => void;
}) {
  const currentPayload = await readCurrentPayload().catch(() => null);
  if (currentPayload) {
    onPayload(currentPayload);
  }

  return listen<OverlayPayload>('overlay:update', (event) => {
    onPayload(event.payload);
  });
}
