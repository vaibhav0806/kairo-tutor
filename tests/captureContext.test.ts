import { describe, expect, it } from 'vitest';
import { shouldSuppressVisualTargets, KAIRO_BUNDLE_ID } from '../src/core/captureContext';

const brave = { activeApp: 'Brave Browser', bundleId: 'com.brave.Browser' };
const docker = { activeApp: 'Docker Desktop', bundleId: 'com.docker.docker' };
const kairo = { activeApp: 'Kairo Tutor', bundleId: KAIRO_BUNDLE_ID };

describe('suppressing a box that would land on the wrong screen', () => {
  it('suppresses when the user switched to another app during the answer wait', () => {
    // The reported case: asked about Brave, switched to Docker, box still drew.
    expect(shouldSuppressVisualTargets(brave, docker)).toBe(true);
  });

  it('keeps the box when the same app is still frontmost', () => {
    expect(shouldSuppressVisualTargets(brave, { ...brave })).toBe(false);
  });

  it('does not treat Kairo fronting itself as a switch', () => {
    // The annotation overlay must be able to become key, so drawing can front our own app.
    // Counting that as a change would suppress the boxes we are in the middle of drawing.
    expect(shouldSuppressVisualTargets(brave, kairo)).toBe(false);
  });

  it('trusts the bundle id over the display name', () => {
    const renamed = { activeApp: 'Brave Browser Beta', bundleId: 'com.brave.Browser' };
    expect(shouldSuppressVisualTargets(brave, renamed)).toBe(false);

    const impostor = { activeApp: 'Brave Browser', bundleId: 'com.evil.fake' };
    expect(shouldSuppressVisualTargets(brave, impostor)).toBe(true);
  });

  it('falls back to the app name when a bundle id is missing', () => {
    const before = { activeApp: 'Terminal', bundleId: null };
    expect(shouldSuppressVisualTargets(before, { activeApp: 'Terminal', bundleId: null })).toBe(false);
    expect(shouldSuppressVisualTargets(before, { activeApp: 'Notes', bundleId: null })).toBe(true);
  });

  it('ignores case and stray whitespace', () => {
    expect(
      shouldSuppressVisualTargets(brave, { activeApp: 'Brave Browser', bundleId: ' COM.BRAVE.BROWSER ' }),
    ).toBe(false);
  });

  it('never suppresses on unknown identity', () => {
    // Missing information is not evidence of a switch; refusing to point on a null reading would
    // break normal turns for a case we cannot confirm.
    expect(shouldSuppressVisualTargets(null, brave)).toBe(false);
    expect(shouldSuppressVisualTargets(brave, null)).toBe(false);
    expect(shouldSuppressVisualTargets(brave, { activeApp: '', bundleId: '' })).toBe(false);
  });
});
