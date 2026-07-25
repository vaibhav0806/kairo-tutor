// @vitest-environment node

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { LandingPage } from '../src/landing/LandingPage';

function collectAssetUrls(html: string): string[] {
  const urls = [...html.matchAll(/\b(?:src|srcSet)="([^"]+)"/gi)].flatMap((match) =>
    (match[1] ?? '').split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
  );

  return [...new Set(urls)].filter(Boolean).sort();
}

describe('landing server rendering', () => {
  test('renders the landing page without browser globals', () => {
    expect(globalThis).not.toHaveProperty('window');
    expect(globalThis).not.toHaveProperty('document');
    expect(() => renderToString(createElement(LandingPage))).not.toThrow();
  });

  test('includes approved product and waitlist copy with one h1', () => {
    const html = renderToString(createElement(LandingPage));

    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('Stuck? Point at it.');
    expect(html).toContain('Kairo sees what you mean.');
    expect(html).toContain('You make the move.');
    expect(html).toContain('Kairo goes where');
    expect(html).toContain('you create.');
    expect(html).toContain('anything else on your screen');
    expect(html).toContain('Learn by doing.');
    expect(html).toContain('Built in the open.');
    expect(html).toContain('Kairo connects your question to the exact place you mean');
    expect(html).toContain('Kairo gives one next move, waits while you try it, then checks the result');
    for (const tool of [
      'After Effects',
      'DaVinci Resolve',
      'Blender',
      'Figma',
      'VS Code',
      'Grafana',
      'Chrome',
      'GitHub',
      'Audacity',
      'Notion',
      'Jira',
      'Google Sheets',
      'AutoCAD',
      'Cursor',
      'Docker',
      'Datadog'
    ]) {
      expect(html).toContain(tool);
    }
    expect(html).toContain('Open source on GitHub');
    expect(html).toContain('vaibhav0806/kairo-tutor');
    expect(html).toContain('We’ll use your email only to contact you about Kairo early access.');
    expect(html).toContain('end of screen.');
    expect(html).toContain('© 2026 Kairo');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/license"');
    expect(html).not.toContain('Take over the task');
  });

  test('renders the approved creator assets without legacy photography', () => {
    const html = renderToString(createElement(LandingPage));
    const assetUrls = collectAssetUrls(html);

    expect(assetUrls).toEqual([
      '/brand/kairo-mark-transparent-64.png',
      '/hero/after-effects-workspace.webp',
      '/hero/blender-viewport.webp',
      '/hero/creator-editing.mp4',
      '/hero/davinci-nodes.webp',
      '/hero/figma-layout.webp',
      '/learn/after-effects-timeline.webp',
      '/travel/icons/after-effects.svg',
      '/travel/icons/audacity.svg',
      '/travel/icons/autocad.svg',
      '/travel/icons/blender.svg',
      '/travel/icons/canva.svg',
      '/travel/icons/chrome.svg',
      '/travel/icons/cursor.svg',
      '/travel/icons/datadog.svg',
      '/travel/icons/davinci-resolve.svg',
      '/travel/icons/docker.svg',
      '/travel/icons/figma.svg',
      '/travel/icons/google-sheets.svg',
      '/travel/icons/grafana.svg',
      '/travel/icons/illustrator.svg',
      '/travel/icons/jira.svg',
      '/travel/icons/jupyter.svg',
      '/travel/icons/kubernetes.svg',
      '/travel/icons/maya.svg',
      '/travel/icons/miro.svg',
      '/travel/icons/notion.svg',
      '/travel/icons/obs-studio.svg',
      '/travel/icons/photoshop.svg',
      '/travel/icons/postman.svg',
      '/travel/icons/premiere-pro.svg',
      '/travel/icons/unity.svg',
      '/travel/icons/vscode.svg',
      '/travel/icons/xcode.svg',
      '/travel/icons/zoom.svg',
      '/understand/after-effects-preview.webp',
      '/understand/after-effects-workspace.webp'
    ]);
    expect(html).not.toContain('/field-notes/');
    expect(html).not.toContain('/kairo-blender-preview.webp');
  });
});
