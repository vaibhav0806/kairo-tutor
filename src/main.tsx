import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OnboardingApp } from './onboarding/OnboardingApp';
import { CursorApp } from './cursor/CursorApp';
import { NotchApp } from './notch/NotchApp';
import { OverlayApp } from './overlay/OverlayApp';
import { installGlobalErrorLogging, klog } from './core/logger';
import { applyAccent, getAccent, onAccentChanged } from './core/accent';
// The website's three faces, so the app reads as the same product (kairo/src/app/layout.tsx):
// Geist for body copy, Bricolage Grotesque for display, Geist Mono for kickers and labels.
// All variable — the site uses weights (670, 740) that the static cuts can't reach.
import '@fontsource-variable/geist';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/geist-mono';
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
