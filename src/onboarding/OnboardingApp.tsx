import { useEffect, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';

/**
 * The temporary centered panel slot. While it holds content the orchestrator window must catch
 * clicks; when empty it stays click-through so the desktop / pet / overlay receive input.
 */
function TempPanelSlot({ active, children }: { active: boolean; children?: ReactNode }) {
  useEffect(() => {
    if (!hasNativeBridge) return;
    void invoke('set_onboarding_click_through', { clickThrough: !active }).catch(() => {});
    return () => {
      void invoke('set_onboarding_click_through', { clickThrough: true }).catch(() => {});
    };
  }, [active]);
  if (!active) return null;
  return <div className="ob-temp-panel">{children}</div>;
}

/** Root of the full-screen, transparent, click-through onboarding orchestrator (#/onboarding). */
export function OnboardingApp() {
  return (
    <div className="ob-orchestrator">
      {/* Phase 0: the existing flow lives in the temp panel. Later phases move most content to
          the notch caption + pet, keeping only color (Act 1) + sign-in (Act 5) in this slot. */}
      <TempPanelSlot active>
        <OnboardingFlow
          onComplete={() => {
            if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
          }}
        />
      </TempPanelSlot>
    </div>
  );
}
