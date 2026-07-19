import { invoke } from '@tauri-apps/api/core';
import { OnboardingFlow } from './OnboardingFlow';
import { hasNativeBridge } from './config';

/** Root of the dedicated borderless onboarding window (#/onboarding). */
export function OnboardingApp() {
  return (
    <OnboardingFlow
      onComplete={() => {
        if (hasNativeBridge) void invoke('finish_onboarding').catch(() => {});
      }}
    />
  );
}
