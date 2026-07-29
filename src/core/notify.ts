import { toast } from 'sonner';
import { klog } from './logger';

/**
 * Transient feedback for the MAIN WINDOW (Settings + the permission-recovery screen).
 *
 * Kairo had no notification system at all: every failure was an inline string in whichever
 * section raised it (`s-action-error`, `s-voice-error`, the update row, the notch's error mode),
 * so an action that failed while the user was looking somewhere else simply never reported.
 *
 * The routing rule — keep it, or this drifts back into five ad-hoc mechanisms:
 *
 * | lane                | use for                                                       | lifetime            |
 * |---------------------|---------------------------------------------------------------|---------------------|
 * | this module (toast) | confirmations for an action the user just took in this window | seconds, dismissible|
 * | inline              | persistent STATE, not events: billing notices, permission rows | until state changes |
 * | the notch           | events that must reach the user while they WORK (quota, offline)| lands with the capsule work |
 *
 * So: an event that happened → toast. A state that is true → inline. Something about the product
 * working while the user is not in Settings → the notch, not here.
 */

export type NoticeTone = 'success' | 'error' | 'info';

type NoticeAction = { label: string; onClick: () => void };

type Notice = {
  tone?: NoticeTone;
  /** One short line. Sentence case, no trailing period. */
  message: string;
  /** Optional second line with the detail or the recovery step. */
  detail?: string;
  /** Give every failure a way out — a retry beats a dead end. */
  action?: NoticeAction;
};

const DURATION: Record<NoticeTone, number> = {
  success: 2600,
  info: 3200,
  // Failures stay longer: the user has to read a recovery step, not just register a tick.
  error: 5200
};

export function notify({ tone = 'info', message, detail, action }: Notice) {
  klog('notify', tone === 'error' ? 'warn' : 'info', 'notice shown', { tone, message });
  const options = {
    description: detail,
    duration: DURATION[tone],
    action: action ? { label: action.label, onClick: action.onClick } : undefined
  };
  if (tone === 'success') return toast.success(message, options);
  if (tone === 'error') return toast.error(message, options);
  return toast(message, options);
}

/**
 * Save flows: one call covers pending → saved → failed, so a slow network shows progress instead
 * of a frozen control, and a failure is never silent.
 */
export function notifySaving<T>(
  promise: Promise<T>,
  copy: { pending: string; success: string; error?: string }
) {
  klog('notify', 'debug', 'save notice started', { pending: copy.pending });
  toast.promise(promise, {
    loading: copy.pending,
    success: copy.success,
    error: (cause: unknown) => {
      const reason = String(cause).replace(/^.*?:\s*/, '');
      klog('notify', 'warn', 'save notice failed', { error: reason });
      return copy.error ?? reason;
    }
  });
  return promise;
}

/** Undo instead of a confirm dialog — fewer interruptions, same safety. */
export function notifyUndoable({ message, undo }: { message: string; undo: () => void }) {
  klog('notify', 'info', 'undoable notice shown', { message });
  toast(message, {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: () => {
        klog('notify', 'info', 'undo taken', { message });
        undo();
      }
    }
  });
}
