import type { SpeechClip } from './streamingTts';

/**
 * A single speech clip synthesized before playback asks for it.
 *
 * Playback used to receive the finished step list and only then start synthesizing step one, so
 * two slow things ran back to back: the model writing the whole answer, then ~1.5-3s of speech
 * synthesis. The streamed turn completes step one long before the response ends, which makes that
 * synthesis overlappable — by the time playback starts, the first clip is already warm.
 *
 * Deliberately ONE slot. The point is to cover the gap before playback begins; keeping more would
 * spend synthesis on steps that a barge-in may never reach, and Sarvam stalls on parallel requests
 * anyway (which is why playback prefetches a window of two rather than everything).
 *
 * Matching is by exact text, so a stale clip can never be spoken for a different step: a miss just
 * synthesizes normally, exactly as before this existed.
 */
type Prewarmed = { text: string; clip: SpeechClip; turn: number };

let slot: Prewarmed | null = null;
let activeTurn = 0;

/**
 * Claim the prewarm slot for a new turn and return its token.
 *
 * Text alone was not enough to keep turns apart. A late `onEarlyStep` from a superseded request
 * can still fire after the next turn has started; without a token it either replaces the live
 * clip, or — if both turns open with the same sentence — hands the new turn audio synthesized
 * from the old screenshot.
 */
export function beginPrewarmTurn(): number {
  discardPrewarmedClip();
  activeTurn += 1;
  return activeTurn;
}

/** Hold `clip` as the warm clip for `text`, replacing (and stopping) any previous one. */
export function setPrewarmedClip(text: string, clip: SpeechClip, turn: number): void {
  const key = text.trim();
  if (!key) return;
  if (turn !== activeTurn) {
    // A superseded turn finished synthesizing. Nothing will play it; drop it now.
    try {
      clip.pause();
      clip.src = '';
    } catch {
      // Best-effort cleanup.
    }
    return;
  }
  discardPrewarmedClip();
  slot = { text: key, clip, turn };
}

/** Take the warm clip for `text`, or null. Taking clears the slot — a clip is never handed out twice. */
export function takePrewarmedClip(text: string): SpeechClip | null {
  const key = text.trim();
  if (!slot || !key || slot.text !== key || slot.turn !== activeTurn) return null;
  const { clip } = slot;
  slot = null;
  return clip;
}

/**
 * Drop the warm clip without playing it. Called when a turn is superseded, fails, or finishes —
 * an unclaimed clip holds a live audio element and, worse, could be claimed by a later turn that
 * happens to speak the same sentence.
 */
export function discardPrewarmedClip(): void {
  const current = slot;
  slot = null;
  if (!current) return;
  try {
    current.clip.pause();
    current.clip.src = '';
  } catch {
    // A clip that is already torn down is fine; this is best-effort cleanup.
  }
}

/** Whether a clip is currently warm (tests + logging). */
export function hasPrewarmedClip(text?: string): boolean {
  if (!slot) return false;
  return text === undefined ? true : slot.text === text.trim();
}
