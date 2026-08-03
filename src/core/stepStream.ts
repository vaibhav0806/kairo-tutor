/**
 * Incremental reader for the tutor's `{ "steps": [ … ] }` response.
 *
 * The vision turn spends most of its wall clock thinking before it emits a single token, then
 * writes the steps in order. Waiting for the closing brace means the user hears nothing until the
 * LAST step is written, even though the first one was speakable much earlier.
 *
 * This yields whole STEP OBJECTS, never partial fields. That distinction is the whole design: a
 * step carries both the line to speak and the box to point at, and the overlay reveals that box
 * when the step starts speaking. Yielding `say` the moment it closed would start the voice while
 * `box` was still arriving, so Kairo would talk about a control it was not yet pointing at.
 * Waiting for the complete object costs a couple of hundred milliseconds and keeps voice and
 * pointer in lockstep, exactly as the buffered path does today.
 *
 * Feed it whatever text has arrived so far; it returns only steps not yet returned.
 */
export class StepStreamReader {
  private yielded = 0;

  /** Complete steps present in `accumulated` that previous calls have not already returned. */
  read(accumulated: string): unknown[] {
    const objects = completeStepObjects(accumulated);
    if (objects.length <= this.yielded) return [];
    const fresh = objects.slice(this.yielded);
    this.yielded = objects.length;
    return fresh.map(parseOrNull).filter((step): step is Record<string, unknown> => step !== null);
  }

  /** How many steps have been handed out so far. */
  get count(): number {
    return this.yielded;
  }
}

function parseOrNull(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Slice out every closed `{…}` inside the `steps` array.
 *
 * Brace counting alone is not enough: a step's `say` is natural language and will contain braces,
 * brackets and escaped quotes ("press {Cmd}", a path, a quoted button label). So the scan tracks
 * string state and backslash escapes, and only counts structural braces.
 */
function completeStepObjects(source: string): string[] {
  const start = findStepsArray(source);
  if (start < 0) return [];

  const objects: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(source.slice(objectStart, i + 1));
        objectStart = -1;
      }
      if (depth < 0) break; // Left the steps array entirely.
    } else if (ch === ']' && depth === 0) {
      break; // End of the steps array.
    }
  }

  return objects;
}

/** Index just after the `[` that opens the `steps` array, or -1 while it has not arrived. */
function findStepsArray(source: string): number {
  const key = /"steps"\s*:\s*\[/g;
  const match = key.exec(source);
  return match ? match.index + match[0].length : -1;
}
