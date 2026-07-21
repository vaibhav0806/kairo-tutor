//! Notch constants + copy: timings, the wrong-button nudge pool, the "let me look"
//! filler lines, rolling-history sizes, and the small pure pickers. Pure data — kept
//! out of NotchApp so the component reads as behavior, not config.

import type { FollowButton } from './followAlong';
import type { NotchPayload } from './types';

// Shown + spoken (via the bundled upgrade.wav) when the user is out of free requests.
// MUST match the audio in src/notch/audio/upgrade.wav and the Rust FREE_LIMIT_MESSAGE.
export const FREE_LIMIT_TEXT = "You've used all your free Kairo requests. Upgrade to keep going.";

export const defaultPayload: NotchPayload = {
  state: 'idle',
  layout: 'compact',
  title: 'Kairo is ready',
  detail: 'Press the shortcut to start'
};

// A voice failure (no speech / STT error) shows a brief, self-dismissing status
// capsule instead of the typing box — then auto-closes to idle after this long.
export const VOICE_ERROR_VISIBLE_MS = 2400;

// Breathing pause between spoken steps of a walkthrough, so it doesn't feel rushed.
export const STEP_GAP_MS = 700;
// Tight per-step TTS timeout: a stalled step synth fails fast → retried, instead of
// freezing the walkthrough. The full direct answer uses the generous native default.
export const STEP_SYNTH_TIMEOUT_MS = 20_000;

// Wrong-button nudges: spoken when the user clicks the right target with the WRONG
// mouse button. Keyed by the button they SHOULD have used. Picked at random so the
// hint never sounds canned. (Only reached by an in-box wrong-button click — see the
// pointer-watch gauntlet; a correct click can never trigger these.)
const WRONG_BUTTON_NUDGES: Record<FollowButton, string[]> = {
  right: [
    'Actually, give that a right-click.',
    'Try right-clicking it instead.',
    'That one needs a right-click.',
    'Right-click it to open the menu.',
    'Oops — right-click that one.',
    "You'll want to right-click there.",
    'Use a right-click on that.',
    'Go ahead and right-click it.',
  ],
  left: [
    'Just a normal click there.',
    "That's a regular left-click.",
    'Try a left-click instead.',
    'A normal click will do it.',
    'No need to right-click — just click it.',
    'Left-click that one.',
    'Regular click there.',
    'Oops — just left-click that.',
  ],
};

export function pickNudge(expected: FollowButton): string {
  const pool = WRONG_BUTTON_NUDGES[expected];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Rolling turn-triples (unified turn). Each turn (voice OR click) records one:
// { user: <utterance> | "[clicked the highlighted target]", gateFiller: the spoken
// filler/ack, kairo: the response's step says + a note of what was highlighted }.
// The last TUTOR_HISTORY_TRIPLES go to the tutor (via `recentContext`), the last
// GATE_HISTORY_TRIPLES to the gate. A larger buffer is retained.
export const TUTOR_HISTORY_TRIPLES = 20;
export const GATE_HISTORY_TRIPLES = 6;
export const TRIPLE_BUFFER = 50;
export type TurnTriple = { user: string; gateFiller: string; kairo: string };

// After the answer finishes speaking, close the notch this long after the user
// stops interacting with it (also clears the box + companion cursor).
export const NOTCH_IDLE_CLOSE_MS = 3000;
// Body copy shown under the title while the answer is being synthesized to speech,
// after the LLM has replied but before playback (and the visuals) begin.
export const PREPARING_NEXT_STEP_TEXT = 'Preparing the next step';

// "Let me look" fillers spoken while a screen turn runs. A big, varied pool so the user
// doesn't hear the same line every time — one is picked at random per turn and STREAMED
// live (Sarvam, first byte ~300ms). Used whenever there's no contextual gate filler:
// gesture/annotation asks (which skip the gate by design) and typed asks.
const FILLER_LINES = [
  'Let me take a look.',
  'Sure, one sec.',
  'Okay, let me check.',
  'Let me see.',
  'One moment, looking now.',
  'Let me find that for you.',
  'On it — taking a look.',
  'Give me a second here.',
  'Let me pull that up.',
  'Alright, let me look.',
  'Let me get eyes on that.',
  'Hang tight, checking now.',
  'Let me see what you mean.',
  'Okay, scanning the screen.',
  'Just a sec, looking.',
  'Let me have a look at that.',
  'Right, let me check that out.',
  'Let me take a peek.',
  'Sure, looking now.',
  'Let me spot that for you.',
  'One sec, let me see.',
  'Okay, on it now.',
  'Let me look that over.',
  'Give me a moment.',
  'Let me zero in on that.',
];
// Only pre-synthesize a few at launch (a cheap fallback for the rare case a live filler
// stream fails). The random pick above draws from the full pool regardless.
export const FILLER_FALLBACK = FILLER_LINES.slice(0, 4);
// Random filler for turns with no contextual gate line.
export const pickFiller = () => FILLER_LINES[Math.floor(Math.random() * FILLER_LINES.length)];
export type QuerySource = 'typed' | 'voice';
