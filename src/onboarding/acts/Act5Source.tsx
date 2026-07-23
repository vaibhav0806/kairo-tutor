import { useEffect } from 'react';
import type { IconType } from 'react-icons';
import { SiInstagram, SiX, SiReddit, SiGoogle, SiClaude } from 'react-icons/si';
import { FaLinkedin } from 'react-icons/fa6';
import { RiOpenaiFill } from 'react-icons/ri';
import { LuUsers, LuEllipsis } from 'react-icons/lu';
import { useCoach } from '../useCoach';
import { ACT5_SOURCE } from '../copy';

// "Where'd you hear about us?" (v2 redesign) — a light Editorial card with an icon grid. No messaging
// icon, no free-text field; every source (incl. A friend / Other) is a one-tap button. The label string
// is sent to the backend (free-form, so the list can change freely).
const SOURCES: { label: string; Icon: IconType }[] = [
  { label: 'Instagram', Icon: SiInstagram },
  { label: 'X / Twitter', Icon: SiX },
  { label: 'LinkedIn', Icon: FaLinkedin },
  { label: 'Reddit', Icon: SiReddit },
  { label: 'ChatGPT', Icon: RiOpenaiFill },
  { label: 'Claude', Icon: SiClaude },
  { label: 'Google', Icon: SiGoogle },
  { label: 'A friend', Icon: LuUsers },
  { label: 'Other', Icon: LuEllipsis }
];

/** Act 5b — "where'd you hear about me?" one-tap icon grid. */
export function Act5Source({ onPick }: { onPick: (source: string) => void }) {
  const { say, clear } = useCoach('');

  useEffect(() => {
    void say(ACT5_SOURCE); // caption == the spoken line
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (source: string) => {
    void clear();
    onPick(source);
  };

  return (
    <>
      <div className="ob-vignette" aria-hidden />
      <div className="ob-card ob-card--source">
        <span className="ob-source-kicker">one last thing</span>
        <h1 className="ob-source-title">Where&apos;d you find us?</h1>
        <p className="ob-source-sub">
          We&apos;re a small team — knowing where you heard about us helps a ton.
        </p>
        <div className="ob-source-grid">
          {SOURCES.map(({ label, Icon }) => (
            <button key={label} type="button" className="ob-source-btn" onClick={() => pick(label)}>
              <Icon className="ob-source-ico" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
