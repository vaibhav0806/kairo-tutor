import { describe, expect, it } from 'vitest';
import { createRuntimeTutorPlanner } from '../src/core/runtimePlanner';
import type { TutorTurnInput } from '../src/core/orchestrator';
import { createMockTutorPlanner } from '../src/core/mockTutor';

const input = {
  userQuery: 'Where do I export?',
  activeApp: { activeApp: 'Figma', bundleId: 'com.figma.Desktop', windowTitle: 'Untitled' },
  screen: { captured: true, imageBase64: 'x', imageMimeType: 'image/jpeg' },
  annotations: [],
  skillSlug: '',
} as unknown as TutorTurnInput;

/**
 * The two shapes are NOT the same, which is easy to miss.
 *
 * The stream carries the model's RAW output, where a step points via `box`. The promise resolves
 * with what native returns after grounding, where a step points via `visualTargets` in display
 * points. Early steps are only ever used for their `say`, so the difference is harmless — but a
 * future caller reaching for `box` on an early step should know it will not survive to the end.
 */
const streamedRaw = JSON.stringify({
  steps: [
    { say: 'Open the File menu.', box: [0.1, 0.1, 0.2, 0.2] },
    { say: 'Choose Export.', box: [0.3, 0.3, 0.4, 0.4] },
  ],
});

const groundedAnswer = JSON.stringify({
  voiceText: 'Open the File menu.',
  screenText: 'Open the File menu.',
  steps: [
    { say: 'Open the File menu.', visualTargets: [] },
    { say: 'Choose Export.', visualTargets: [] },
  ],
});

/** A bridge that streams the raw body in fixed-size pieces, like a provider would. */
function streamingBridge(chunkSize: number) {
  const calls = { buffered: 0, streamed: 0 };
  return {
    calls,
    runTutorTurn: async () => {
      calls.buffered += 1;
      return groundedAnswer;
    },
    runTutorTurnStream: async (_i: TutorTurnInput, onDelta: (t: string) => void) => {
      calls.streamed += 1;
      for (let i = 0; i < streamedRaw.length; i += chunkSize) {
        onDelta(streamedRaw.slice(i, i + chunkSize));
      }
      return groundedAnswer;
    },
  };
}

describe('runtime planner · streamed turn', () => {
  it('announces each step as it completes, in order', async () => {
    const bridge = streamingBridge(7);
    const seen: Array<{ say: string; index: number }> = [];
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: bridge,
      mockPlanner: createMockTutorPlanner(),
      onEarlyStep: (step, index) => seen.push({ say: (step as { say: string }).say, index }),
    });

    await planner(input);

    expect(bridge.calls.streamed).toBe(1);
    expect(bridge.calls.buffered).toBe(0);
    expect(seen).toEqual([
      { say: 'Open the File menu.', index: 0 },
      { say: 'Choose Export.', index: 1 },
    ]);
  });

  it('still resolves with the complete response, not the streamed pieces', async () => {
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: streamingBridge(3),
      mockPlanner: createMockTutorPlanner(),
      onEarlyStep: () => {},
    });

    // The stream is an accelerator; the full body remains what gets parsed.
    const result = await planner(input);
    expect(result.steps).toHaveLength(2);
    expect(result.steps?.[0]?.say).toBe('Open the File menu.');
  });

  it('uses the buffered turn when no caller wants early steps', async () => {
    const bridge = streamingBridge(5);
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: bridge,
      mockPlanner: createMockTutorPlanner(),
    });

    await planner(input);

    expect(bridge.calls.streamed).toBe(0);
    expect(bridge.calls.buffered).toBe(1);
  });

  it('falls back when the bridge cannot stream at all', async () => {
    // An older native build exposes no streaming command; the turn must still work.
    const calls = { buffered: 0 };
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: {
        runTutorTurn: async () => {
          calls.buffered += 1;
          return groundedAnswer;
        },
      },
      mockPlanner: createMockTutorPlanner(),
      onEarlyStep: () => {
        throw new Error('must not be called without a streaming bridge');
      },
    });

    const result = await planner(input);

    expect(calls.buffered).toBe(1);
    expect(result.steps).toHaveLength(2);
  });

  it('announces nothing when the stream never forms a step', async () => {
    const seen: unknown[] = [];
    const planner = createRuntimeTutorPlanner({
      aiProvider: 'openrouter',
      nativeBridge: {
        runTutorTurn: async () => groundedAnswer,
        runTutorTurnStream: async (_i: TutorTurnInput, onDelta: (t: string) => void) => {
          onDelta('{"steps":[{"say":"cut off');
          return groundedAnswer; // native fell back internally and returned the buffered body
        },
      },
      mockPlanner: createMockTutorPlanner(),
      onEarlyStep: (step) => seen.push(step),
    });

    const result = await planner(input);

    expect(seen).toEqual([]);
    // The answer still lands intact, which is the whole point of the fallback.
    expect(result.steps).toHaveLength(2);
  });
});
