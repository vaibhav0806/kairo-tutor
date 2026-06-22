import { useMemo, useState } from 'react';
import { loadKairoEnv } from './config/env';
import { createMockTutorPlanner } from './core/mockTutor';
import type { TutorResponse } from './core/types';

const demoContext = {
  activeApp: 'Blender',
  bundleId: 'org.blenderfoundation.blender',
  windowTitle: 'Blender'
};

export function App() {
  const env = loadKairoEnv({
    KAIRO_APP_ENV: import.meta.env.KAIRO_APP_ENV,
    KAIRO_AI_PROVIDER: import.meta.env.KAIRO_AI_PROVIDER,
    KAIRO_STT_PROVIDER: import.meta.env.KAIRO_STT_PROVIDER,
    KAIRO_TTS_PROVIDER: import.meta.env.KAIRO_TTS_PROVIDER,
    KAIRO_DEFAULT_SKILL: import.meta.env.KAIRO_DEFAULT_SKILL,
    KAIRO_ENABLE_WEB_RESEARCH: import.meta.env.KAIRO_ENABLE_WEB_RESEARCH
  });
  const planner = useMemo(() => createMockTutorPlanner(), []);
  const [query, setQuery] = useState('Help me make my first animation');
  const [response, setResponse] = useState<TutorResponse>(() =>
    planner.planNextStep({
      ...demoContext,
      userQuery: 'Help me make my first animation',
      annotations: []
    })
  );

  function askTutor() {
    setResponse(
      planner.planNextStep({
        ...demoContext,
        userQuery: query,
        annotations: []
      })
    );
  }

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Tutor status">
        <div>
          <p className="eyebrow">Kairo Tutor</p>
          <h1>Screen-native AI tutor shell</h1>
        </div>
        <div className="status-pill">Provider: {env.aiProvider}</div>
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>Activation</h2>
          <p>Shortcut target: Command + Shift + Space</p>
          <p>Default skill: {env.defaultSkill}</p>
          <p>Voice: {env.sttProvider === 'sarvam' || env.ttsProvider === 'sarvam' ? 'Sarvam' : 'Mock'}</p>
          <p>Active app: {demoContext.activeApp}</p>
          <p>Window: {demoContext.windowTitle}</p>
        </aside>

        <section className="tutor-surface">
          <div className="screen-preview" aria-label="Mock screen preview">
            <div className="toolbar">Blender viewport</div>
            <div className="cube" />
            <div className="timeline">Timeline: frame 1 - 250</div>
          </div>

          <div className="ask-row">
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
            <button type="button" onClick={askTutor}>
              Ask
            </button>
          </div>

          <article className="response">
            <p className="eyebrow">{response.mode}</p>
            <h2>{response.screenText}</h2>
            <p>{response.voiceText}</p>
            <ul>
              {response.visualTargets.map((target) => (
                <li key={`${target.kind}-${target.targetId}`}>
                  {target.kind}: {target.label} ({Math.round(target.confidence * 100)}%)
                </li>
              ))}
            </ul>
          </article>
        </section>
      </section>
    </main>
  );
}
