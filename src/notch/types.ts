export type NotchState = 'idle' | 'listening' | 'captured' | 'thinking' | 'showing_step' | 'coach';
export type NotchLayout = 'compact' | 'prompt' | 'answer';

export type NotchPayload = {
  state: NotchState;
  layout: NotchLayout;
  title: string;
  detail: string;
  // Optional seeded-prompt chip shown under a coach caption (e.g. "try: 'hey Kairo, what's up?'").
  chip?: string;
  // When true, a coach caption shows the live mic meter (Phase F — Act 2's say-hi drill only).
  meter?: boolean;
};
