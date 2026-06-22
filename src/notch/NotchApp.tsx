import { useEffect, useMemo, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { createNativeBridge } from '../native/nativeBridge';
import { subscribeToNotchPayload } from './notchEvents';
import { isNotchPromptVisible, submitNotchPrompt } from './prompt';
import type { NotchPayload } from './types';

const defaultPayload: NotchPayload = {
  state: 'idle',
  title: 'Kairo is ready',
  detail: 'Press the shortcut to start'
};

export function NotchApp() {
  const [payload, setPayload] = useState<NotchPayload>(defaultPayload);
  const [query, setQuery] = useState('');
  const nativeBridge = useMemo(() => createNativeBridge(), []);
  const isPromptVisible = isNotchPromptVisible(payload);

  useEffect(() => {
    document.documentElement.classList.add('notch-document');
    document.body.classList.add('notch-document');

    return () => {
      document.documentElement.classList.remove('notch-document');
      document.body.classList.remove('notch-document');
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | undefined;

    void subscribeToNotchPayload({
      listen,
      readCurrentPayload: () => nativeBridge.getCurrentNotchPayload(),
      onPayload: (nextPayload) => {
        if (isMounted) {
          setPayload(nextPayload);
        }
      }
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Browser preview and tests run without the Tauri event bus.
      });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [nativeBridge]);

  return (
    <main className="notch-shell" aria-label="Kairo assistant status">
      <div className="notch-card" data-state={payload.state}>
        <div className="notch-orb" aria-hidden="true" />
        <div className="notch-copy">
          <strong>{payload.title}</strong>
          <span>{payload.detail}</span>
        </div>
        {isPromptVisible ? (
          <form
            className="notch-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              void submitNotchPrompt(query, async (askPayload) => {
                await emit('notch:ask', askPayload);
                setQuery('');
              });
            }}
          >
            <input
              aria-label="Ask Kairo"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ask about this screen"
              value={query}
            />
            <button type="submit">Ask</button>
            <button
              className="notch-secondary"
              type="button"
              onClick={() => {
                void emit('annotation:start', {});
              }}
            >
              Annotate
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
