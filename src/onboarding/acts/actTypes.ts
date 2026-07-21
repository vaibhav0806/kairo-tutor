// Contract every act component honors. `onAdvance` moves the Phase-0 orchestrator to the next act;
// `name` is the user's name if already known (blank in Acts 1-2 — name arrives at sign-in, Act 5).
export type ActProps = { name: string; onAdvance: () => void };
