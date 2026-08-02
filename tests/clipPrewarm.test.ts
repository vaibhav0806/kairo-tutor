import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPrewarmTurn,
  discardPrewarmedClip,
  hasPrewarmedClip,
  setPrewarmedClip,
  takePrewarmedClip,
} from '../src/notch/clipPrewarm';
import type { SpeechClip } from '../src/notch/streamingTts';

function fakeClip(): SpeechClip & { paused: number } {
  return {
    paused: 0,
    play: async () => {},
    pause() {
      this.paused += 1;
    },
    src: 'blob:fake',
    onplay: null,
    onended: null,
    onpause: null,
    onerror: null,
  };
}

afterEach(() => discardPrewarmedClip());

describe('prewarmed speech clip', () => {
  it('hands back the clip for the exact text it was warmed for', () => {
    const clip = fakeClip();
    setPrewarmedClip('Open the File menu.', clip, beginPrewarmTurn());

    expect(takePrewarmedClip('Open the File menu.')).toBe(clip);
  });

  it('never hands the same clip out twice', () => {
    setPrewarmedClip('Open the File menu.', fakeClip(), beginPrewarmTurn());

    expect(takePrewarmedClip('Open the File menu.')).not.toBeNull();
    expect(takePrewarmedClip('Open the File menu.')).toBeNull();
  });

  it('refuses a clip warmed for different text', () => {
    const clip = fakeClip();
    setPrewarmedClip('Open the File menu.', clip, beginPrewarmTurn());

    // A stale clip spoken for the wrong step would narrate the wrong thing entirely.
    expect(takePrewarmedClip('Choose Export.')).toBeNull();
  });

  it('stops the previous clip when a newer turn warms another', () => {
    const turn = beginPrewarmTurn();
    const first = fakeClip();
    setPrewarmedClip('First answer.', first, turn);

    setPrewarmedClip('Second answer.', fakeClip(), turn);

    expect(first.paused).toBe(1);
    expect(hasPrewarmedClip('First answer.')).toBe(false);
    expect(hasPrewarmedClip('Second answer.')).toBe(true);
  });

  it('stops an unclaimed clip on discard, so a barge-in cannot leave audio live', () => {
    const clip = fakeClip();
    setPrewarmedClip('Abandoned answer.', clip, beginPrewarmTurn());

    discardPrewarmedClip();

    expect(clip.paused).toBe(1);
    expect(hasPrewarmedClip()).toBe(false);
    expect(takePrewarmedClip('Abandoned answer.')).toBeNull();
  });

  it('ignores empty text rather than holding an unusable slot', () => {
    setPrewarmedClip('   ', fakeClip(), beginPrewarmTurn());

    expect(hasPrewarmedClip()).toBe(false);
  });

  it('matches across surrounding whitespace', () => {
    const clip = fakeClip();
    setPrewarmedClip('  Trimmed.  ', clip, beginPrewarmTurn());

    expect(takePrewarmedClip('Trimmed.')).toBe(clip);
  });

  it('survives a clip that throws while being torn down', () => {
    const hostile = {
      ...fakeClip(),
      pause() {
        throw new Error('already gone');
      },
    } as unknown as SpeechClip;
    setPrewarmedClip('Hostile.', hostile, beginPrewarmTurn());

    expect(() => discardPrewarmedClip()).not.toThrow();
    expect(hasPrewarmedClip()).toBe(false);
  });

  it('discarding when nothing is warm is a no-op', () => {
    const spy = vi.fn();
    expect(() => discardPrewarmedClip()).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fences a late clip from a superseded turn out of the live slot', () => {
    // The reported race: turn A's onEarlyStep can still fire after turn B has started.
    const turnA = beginPrewarmTurn();
    const turnB = beginPrewarmTurn();
    const liveClip = fakeClip();
    setPrewarmedClip('Turn B opening line.', liveClip, turnB);

    const lateClip = fakeClip();
    setPrewarmedClip('Turn A opening line.', lateClip, turnA);

    // The late clip is dropped, not stored, and the live one is untouched.
    expect(lateClip.paused).toBe(1);
    expect(takePrewarmedClip('Turn B opening line.')).toBe(liveClip);
  });

  it('never hands a new turn audio synthesized for the previous one', () => {
    // Same opening sentence in both turns — text matching alone would have allowed this.
    const turnA = beginPrewarmTurn();
    const stale = fakeClip();
    setPrewarmedClip('Open the File menu.', stale, turnA);

    beginPrewarmTurn(); // turn B starts; A's clip belongs to a screenshot that is gone
    expect(takePrewarmedClip('Open the File menu.')).toBeNull();
    expect(stale.paused).toBe(1);
  });
});
