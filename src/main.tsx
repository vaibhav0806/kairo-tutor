import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { installGlobalErrorLogging, klog } from './core/logger';
import { applyAccent, getAccent, onAccentChanged } from './core/accent';
// The website's three faces, so the app reads as the same product (kairo/src/app/layout.tsx):
// Geist for body copy, Bricolage Grotesque for display, Geist Mono for kickers and labels.
// All variable — the site uses weights (670, 740) that the static cuts can't reach.
import '@fontsource-variable/geist';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/geist-mono';
import './styles.css';

// Each native window uses the same HTML entry but needs only one UI. Route-level chunks keep the
// always-running notch/cursor windows from parsing onboarding, settings, and overlay code (including
// their large icon/motion trees) at startup.
const App = lazy(() => import('./App').then((module) => ({ default: module.App })));
const OnboardingApp = lazy(() =>
  import('./onboarding/OnboardingApp').then((module) => ({ default: module.OnboardingApp }))
);
const CursorApp = lazy(() =>
  import('./cursor/CursorApp').then((module) => ({ default: module.CursorApp }))
);
const NotchApp = lazy(() => import('./notch/NotchApp').then((module) => ({ default: module.NotchApp })));
const OverlayApp = lazy(() =>
  import('./overlay/OverlayApp').then((module) => ({ default: module.OverlayApp }))
);

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

klog('boot', 'info', 'webview mounted', { route: window.location.hash || 'main' });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Suspense fallback={null}>
      <RootApp />
    </Suspense>
  </StrictMode>
);
