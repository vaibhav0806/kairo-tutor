import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OnboardingApp } from './onboarding/OnboardingApp';
import { CursorApp } from './cursor/CursorApp';
import { NotchApp } from './notch/NotchApp';
import { OverlayApp } from './overlay/OverlayApp';
import { installGlobalErrorLogging, klog } from './core/logger';
import '@fontsource-variable/geist';
import './styles.css';

// Record uncaught errors/rejections from this WebView into the shared Kairo log.
installGlobalErrorLogging();

const RootApp =
  window.location.hash === '#/overlay'
    ? OverlayApp
    : window.location.hash === '#/notch'
      ? NotchApp
      : window.location.hash === '#/cursor'
        ? CursorApp
        : window.location.hash === '#/onboarding'
          ? OnboardingApp
          : App;

klog('boot', 'info', 'webview mounted');

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
