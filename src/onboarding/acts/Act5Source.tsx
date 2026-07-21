import { useEffect, useMemo, useState } from 'react';
import { ONBOARDING_SOURCES } from '@kairo/shared';
import { createNativeBridge } from '../../native/nativeBridge';
import { useVoice } from '../useVoice';
import { ACT5_SOURCE } from '../copy';
import { setCoachCaption, clearCoachCaption } from '../coachSurface';
import { TempPanel } from './TempPanel';

/** Act 5b — "where'd you hear about me?" one-tap chip row (+ free-text "Other"). */
export function Act5Source({ onPick }: { onPick: (source: string) => void }) {
  const bridge = useMemo(() => createNativeBridge(), []);
  const voice = useVoice();
  const [other, setOther] = useState('');

  useEffect(() => {
    void setCoachCaption(bridge, { title: 'One last thing', detail: 'Where did you hear about me?' });
    void voice.speak(ACT5_SOURCE, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (source: string) => {
    void clearCoachCaption(bridge);
    onPick(source);
  };

  return (
    <TempPanel>
      <div className="ob-field-col">
        <div className="ob-chips">
          {ONBOARDING_SOURCES.map((s) =>
            s === 'Other' ? null : (
              <button key={s} type="button" className="ob-chip" onClick={() => pick(s)}>
                {s}
              </button>
            )
          )}
        </div>
        <div className="ob-chips">
          <input
            className="ob-chip"
            value={other}
            placeholder="somewhere else…"
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && other.trim() && pick(other.trim())}
          />
          <button
            type="button"
            className="ob-cta"
            disabled={!other.trim()}
            onClick={() => pick(other.trim())}
          >
            Done
          </button>
        </div>
      </div>
    </TempPanel>
  );
}
