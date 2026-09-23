import { SettingsView } from './settings/SettingsView';
import { KairoToaster } from './components/KairoToaster';
// The main window is Settings, including permission recovery for returning users.
// First-run onboarding has its own window.

export function App() {
  return (
    <>
      <SettingsView />
      <KairoToaster />
    </>
  );
}
