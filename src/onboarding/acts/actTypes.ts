// Contract every act component honors. `onAdvance` moves the Phase-0 orchestrator to the next act;
// `name` is the user's name if already known (blank until sign-in, which is the front door's last panel).
export type ActProps = { name: string; onAdvance: () => void };
