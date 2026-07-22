import { useCallback, useMemo } from 'react';
import { createNativeBridge } from '../native/nativeBridge';
import { useVoice } from './useVoice';
import { setCoachCaption, clearCoachCaption } from './coachSurface';
import type { Segment } from './copy';

export type CoachLine = string | Segment[];

/**
 * The ONE way onboarding talks to the user. Every scripted line goes through `say`, which is the
 * single guarantee that keeps the whole flow honest:
 *
 *   the notch caption ALWAYS shows the exact words Kairo is speaking, in sync.
 *
 * `say(line)`:
 *   1. shows a loading pulse in the notch (empty caption) while the audio synthesises,
 *   2. reveals the words at the instant the voice starts — never before (mandate §),
 *   3. resolves when the voice finishes.
 *
 * So an act reads straight down the page as a sequence:
 *
 *     await say(intro);          // notch shows the intro, in sync with the voice
 *     await openSettings();      // THEN the window opens — one thing at a time
 *     coach.guide('Turn it on'); // a silent sticky hint while the user acts
 *
 * Two notch modes, kept deliberately separate so they can never drift:
 *   • `say`   — a SPOKEN line. Caption == speech, guaranteed.
 *   • `guide` — a SILENT, sticky instruction shown WHILE the user does something (toggle a switch).
 *               Never implies audio, so it never has to match a spoken line.
 */
export function useCoach(name: string) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();

  // Speak a line AND mirror it as the notch caption, perfectly in sync. Resolves when speech ends.
  const say = useCallback(
    async (line: CoachLine, opts: { chip?: string } = {}): Promise<void> => {
      const segments: Segment[] = typeof line === 'string' ? [{ text: () => line }] : line;
      const detail = segments
        .map((s) => s.text(name))
        .join(' ')
        .trim();
      if (!detail) return;
      await setCoachCaption(bridge, { title: 'Kairo', detail: '' }); // loading pulse (no words yet)
      await voice.speak(segments, name, () => {
        // Voice just started → reveal the exact words now.
        void setCoachCaption(bridge, { title: 'Kairo', detail, ...(opts.chip ? { chip: opts.chip } : {}) });
      });
    },
    [bridge, voice.speak, name]
  );

  // Loading pulse only (no words) — for while we transcribe / think between the user's turn and ours.
  const thinking = useCallback(
    () => setCoachCaption(bridge, { title: 'Kairo', detail: '' }),
    [bridge]
  );

  // Show words in the notch WITHOUT speaking here — used only when the audio is already playing
  // elsewhere (e.g. the practice reply, spoken by demoController) and we mirror it in via a callback.
  const caption = useCallback(
    (detail: string, chip?: string) =>
      setCoachCaption(bridge, { title: 'Kairo', detail, ...(chip ? { chip } : {}) }),
    [bridge]
  );

  // A silent, sticky instruction while the user performs an action (no voice attached).
  const guide = useCallback(
    (title: string, detail: string, chip?: string) =>
      setCoachCaption(bridge, { title, detail, ...(chip ? { chip } : {}) }),
    [bridge]
  );

  const clear = useCallback(() => clearCoachCaption(bridge), [bridge]);

  return { say, thinking, caption, guide, clear, bridge, voice };
}
