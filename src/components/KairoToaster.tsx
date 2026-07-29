import { Toaster } from 'sonner';

/**
 * The main window's toast surface. Sonner supplies the behaviour (stacking, swipe-dismiss, timers,
 * aria live region); every pixel is ours — `unstyled` turns off its default look so the toasts read
 * as the same product as the settings card: hairline border, near-square corners, Geist, and the
 * brand's hard offset shadow instead of a soft web-app drop shadow.
 *
 * Bottom-centre, not top-right: the notch owns the top of the screen, and a toast appearing up
 * there would compete with Kairo itself.
 */
export function KairoToaster() {
  return (
    <Toaster
      position="bottom-center"
      offset={18}
      gap={8}
      visibleToasts={3}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: 'k-toast',
          title: 'k-toast-title',
          description: 'k-toast-desc',
          actionButton: 'k-toast-action',
          success: 'k-toast-success',
          error: 'k-toast-error',
          loading: 'k-toast-loading'
        }
      }}
    />
  );
}
