import { useMemo, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Switch } from '@base-ui/react/switch';
import { klog } from '../core/logger';

/**
 * The skills dialog.
 *
 * It used to be a bare `div` behind a click-outside handler: Escape did nothing, Tab walked
 * straight out of it, the page behind it still scrolled, and focus never returned to the trigger.
 * Base UI supplies all of that; the surface is still ours.
 *
 * Deliberately still a dialog rather than an inline disclosure — skills are per-application and
 * the list is expected to reach the hundreds, so it needs its own scroll region and its own search.
 */
export type SkillInfo = { slug: string; name: string; description: string; enabled: boolean };

export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(needle)
  );
}

export function SkillsDialog({
  skills,
  open,
  onOpenChange,
  onToggle
}: {
  skills: SkillInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (slug: string, enabled: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => filterSkills(skills, query), [skills, query]);
  const enabledCount = skills.filter((skill) => skill.enabled).length;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        klog('settings', 'debug', 'skills dialog toggled', { open: next });
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog" aria-label="Skills">
          <div className="k-dialog-head">
            <Dialog.Title className="k-dialog-title">Skills</Dialog.Title>
            <Dialog.Close className="k-dialog-close" aria-label="Close">
              Done
            </Dialog.Close>
          </div>
          <Dialog.Description className="settings-muted">
            {enabledCount} of {skills.length} enabled · turn off anything Kairo should ignore.
          </Dialog.Description>

          {/* Search earns its place the moment the list outgrows one screen. */}
          {skills.length >= 8 ? (
            <div className="k-dialog-search">
              <span aria-hidden>⌕</span>
              <input
                autoFocus
                value={query}
                aria-label="Search skills"
                placeholder={`Search ${skills.length} skills…`}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}

          <div className="k-dialog-list">
            {results.map((skill) => (
              <div className="k-skill" key={skill.slug}>
                <span className="k-skill-body">
                  <span className="s-item-name">{skill.name}</span>
                  <span className="settings-muted s-check-desc">{skill.description}</span>
                </span>
                {/* A switch, not a checkbox: this applies instantly, it is not a pending choice. */}
                <Switch.Root
                  className="kswitch kswitch-sm"
                  aria-label={skill.name}
                  checked={skill.enabled}
                  onCheckedChange={(enabled) => onToggle(skill.slug, enabled)}
                >
                  <Switch.Thumb className="kswitch-knob" />
                </Switch.Root>
              </div>
            ))}
            {results.length === 0 ? (
              <p className="settings-muted vp-empty">No skill matches that.</p>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
