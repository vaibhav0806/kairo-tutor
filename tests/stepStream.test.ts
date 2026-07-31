import { describe, expect, it } from 'vitest';
import { StepStreamReader } from '../src/core/stepStream';

/** Feed a payload one character at a time, collecting steps in the order they became readable. */
function drip(payload: string): { steps: unknown[]; firstAt: number } {
  const reader = new StepStreamReader();
  const steps: unknown[] = [];
  let firstAt = -1;
  for (let i = 1; i <= payload.length; i += 1) {
    const fresh = reader.read(payload.slice(0, i));
    if (fresh.length && firstAt < 0) firstAt = i;
    steps.push(...fresh);
  }
  return { steps, firstAt };
}

describe('reading steps out of a half-arrived response', () => {
  it('yields a step as soon as its object closes, not when the response ends', () => {
    const payload = JSON.stringify({
      steps: [
        { say: 'Open the File menu.', box: [0.1, 0.1, 0.2, 0.2] },
        { say: 'Choose Export.', box: [0.3, 0.3, 0.4, 0.4] },
        { say: 'Pick PNG.', box: null },
      ],
    });

    const { steps, firstAt } = drip(payload);

    expect(steps).toHaveLength(3);
    expect((steps[0] as { say: string }).say).toBe('Open the File menu.');
    // The point of the exercise: readable well before the payload finishes.
    expect(firstAt).toBeLessThan(payload.length);
  });

  it('never yields a step before its box has arrived', () => {
    // The desync this design exists to prevent: speaking while the pointer is still streaming.
    const head = '{"steps":[{"say":"Click the red button."';
    const reader = new StepStreamReader();

    expect(reader.read(head)).toEqual([]);
    expect(reader.read(`${head},"box":[0.5,0.6`)).toEqual([]);

    const complete = reader.read(`${head},"box":[0.5,0.6,0.9,0.8]}`);
    expect(complete).toHaveLength(1);
    expect((complete[0] as { box: number[] }).box).toEqual([0.5, 0.6, 0.9, 0.8]);
  });

  it('never returns the same step twice', () => {
    const payload = '{"steps":[{"say":"One","box":null},{"say":"Two","box":null}]}';
    const reader = new StepStreamReader();

    expect(reader.read(payload)).toHaveLength(2);
    expect(reader.read(payload)).toEqual([]);
    expect(reader.read(`${payload}   `)).toEqual([]);
    expect(reader.count).toBe(2);
  });

  it('is not fooled by braces and quotes inside spoken text', () => {
    // `say` is natural language: it will contain braces, brackets and quoted labels.
    const payload = JSON.stringify({
      steps: [
        { say: 'Press {Cmd} then type }{ — yes, really.', box: null },
        { say: 'Open "Export as…" and pick [PNG].', box: [0, 0, 1, 1] },
      ],
    });

    const { steps } = drip(payload);

    expect(steps).toHaveLength(2);
    expect((steps[0] as { say: string }).say).toBe('Press {Cmd} then type }{ — yes, really.');
    expect((steps[1] as { say: string }).say).toBe('Open "Export as…" and pick [PNG].');
  });

  it('handles escaped quotes and trailing backslashes in spoken text', () => {
    const payload = JSON.stringify({
      steps: [
        { say: 'Type \\ then "quit"', box: null },
        { say: 'Done', box: null },
      ],
    });

    const { steps } = drip(payload);

    expect(steps).toHaveLength(2);
    expect((steps[0] as { say: string }).say).toBe('Type \\ then "quit"');
  });

  it('keeps a nested object inside a step intact', () => {
    // await_click carries its own nested box, so a step is not always flat.
    const payload = JSON.stringify({
      steps: [{ say: 'Click Export.', box: null, await_click: { box: [0.1, 0.2, 0.3, 0.4], wait: 'ui-settle' } }],
    });

    const { steps } = drip(payload);

    expect(steps).toHaveLength(1);
    expect((steps[0] as { await_click: { wait: string } }).await_click.wait).toBe('ui-settle');
  });

  it('ignores keys that appear after the steps array', () => {
    const payload = '{"steps":[{"say":"Only","box":null}],"keepBoxes":true,"meta":{"a":1}}';

    const { steps } = drip(payload);

    expect(steps).toHaveLength(1);
  });

  it('waits for the steps key rather than grabbing any object', () => {
    const reader = new StepStreamReader();

    expect(reader.read('{"keepBoxes":true,')).toEqual([]);
    expect(reader.read('{"keepBoxes":true,"other":{"x":1},')).toEqual([]);
    expect(reader.read('{"keepBoxes":true,"other":{"x":1},"steps":[{"say":"Go","box":null}]')).toHaveLength(1);
  });

  it('survives a response that stops mid-flight', () => {
    // A dropped connection must still leave the completed steps usable.
    const reader = new StepStreamReader();
    const truncated = '{"steps":[{"say":"First","box":null},{"say":"Second, cut off';

    expect(reader.read(truncated)).toHaveLength(1);
  });

  it('returns nothing for text that never becomes a steps array', () => {
    const reader = new StepStreamReader();

    expect(reader.read('')).toEqual([]);
    expect(reader.read('not json at all')).toEqual([]);
    expect(reader.read('{"error":"nope"}')).toEqual([]);
  });

  it('tolerates whitespace and newlines between structure', () => {
    const payload = '{\n  "steps" : [\n    { "say" : "Spaced out",\n      "box" : null }\n  ]\n}';

    const { steps } = drip(payload);

    expect(steps).toHaveLength(1);
    expect((steps[0] as { say: string }).say).toBe('Spaced out');
  });
});
