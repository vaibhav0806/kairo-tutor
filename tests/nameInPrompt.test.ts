import { describe, expect, test } from 'vitest';
import { buildTutorTurnInput } from '../src/core/orchestrator';

const request = { activeApp: 'Finder', userQuery: 'hi', annotations: [] };

describe('name in prompt plumbing', () => {
  test('threads userName when provided', () => {
    const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: '', userName: 'Prasad' });
    expect(input.userName).toBe('Prasad');
  });

  test('omits userName when absent', () => {
    const input = buildTutorTurnInput({ request, screenCapture: null, skillSlug: '' });
    expect(input.userName).toBeUndefined();
  });
});
