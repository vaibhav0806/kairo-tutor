import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OnboardingApp } from './onboarding/OnboardingApp';
import { CursorApp } from './cursor/CursorApp';
import { NotchApp } from './notch/NotchApp';
import { OverlayApp } from './overlay/OverlayApp';
import { installGlobalErrorLogging, klog } from './core/logger';
import { applyAccent, getAccent, onAccentChanged } from './core/accent';
import '@fontsource-variable/geist';
// Instrument Serif — the display face for the onboarding hero + color card (v2 Phase C). The dep was
// installed but never imported, so 'Instrument Serif' references were silently falling back to Georgia.
import '@fontsource/instrument-serif';
// Bricolage Grotesque — the notch caption face (more character than Geist). Weights used: 400/500/600.
import '@fontsource/bricolage-grotesque/400.css';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/600.css';
import './styles.css';

// Record uncaught errors/rejections from this WebView into the shared Kairo log.
installGlobalErrorLogging();

// Paint the user accent immediately + keep it live across every webview (foundation for the
// accent-threaded notch/cursor/overlay redesigns in later phases).
void getAccent().then(applyAccent);
void onAccentChanged(applyAccent);

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
