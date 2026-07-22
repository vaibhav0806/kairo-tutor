import { useEffect, useState } from 'react';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { useCoach } from '../useCoach';
import { ACT5_SOURCE } from '../copy';
import { TempPanel } from './TempPanel';

/** Act 5b — "where'd you hear about me?" one-tap chip row (+ free-text "Other"). */
export function Act5Source({ onPick }: { onPick: (source: string) => void }) {
  const { say, clear } = useCoach('');
  const [other, setOther] = useState('');

  useEffect(() => {
    void say(ACT5_SOURCE); // caption == the spoken line
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (source: string) => {
    void clear();
    onPick(source);
  };

  return (
    <TempPanel>
      <div className="ob-panel-body">
        <div className="ob-panel-icon" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M20 11.5a8.5 8.5 0 0 1-12.2 7.6L4 20l1-3.6A8.5 8.5 0 1 1 20 11.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <circle cx="8.5" cy="11.5" r="1.1" fill="currentColor" />
            <circle cx="12" cy="11.5" r="1.1" fill="currentColor" />
            <circle cx="15.5" cy="11.5" r="1.1" fill="currentColor" />
          </svg>
        </div>
        <span className="ob-panel-kicker">one last thing</span>
        <div className="ob-source-chips">
          {ONBOARDING_SOURCES.map((s) =>
            s === 'Other' ? null : (
              <button key={s} type="button" className="ob-chip" onClick={() => pick(s)}>
                {s}
              </button>
            )
          )}
        </div>
        <div className="ob-source-other">
          <input
            value={other}
            placeholder="somewhere else…"
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && other.trim() && pick(other.trim())}
          />
          <button
            type="button"
            className="ob-source-go"
            disabled={!other.trim()}
            aria-label="Done"
            onClick={() => pick(other.trim())}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </TempPanel>
  );
}
