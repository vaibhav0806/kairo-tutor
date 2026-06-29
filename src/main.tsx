import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CursorApp } from './cursor/CursorApp';
import { NotchApp } from './notch/NotchApp';
import { OverlayApp } from './overlay/OverlayApp';
import './styles.css';

const RootApp =
  window.location.hash === '#/overlay'
    ? OverlayApp
    : window.location.hash === '#/notch'
      ? NotchApp
      : window.location.hash === '#/cursor'
        ? CursorApp
        : App;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
