import { useCallback, useRef } from 'react';
import { klog } from '../core/logger';
import {
  GATE_HISTORY_TRIPLES,
  TRIPLE_BUFFER,
  TUTOR_HISTORY_TRIPLES,
  type TurnTriple
} from './notchConstants';

function formatTriples(triples: TurnTriple[]) {
  return triples
    .map((t) => {
      const filler = t.gateFiller.trim() ? ` filler="${t.gateFiller.trim()}"` : '';
      return `Turn: user="${t.user.trim()}"${filler} kairo="${t.kairo.trim()}"`;
    })
    .join('\n');
}

// Session memory: rolling turn-triples (one per turn, voice OR click) kept for
// continuity. Exposes the tutor's `recentContext` (last N triples) and the gate's
// shorter history (last M). A larger buffer is retained; the slices read the tail.
export function useTurnHistory() {
  const triplesRef = useRef<TurnTriple[]>([]);

  const recordTriple = useCallback((triple: TurnTriple) => {
    triplesRef.current.push(triple);
    if (triplesRef.current.length > TRIPLE_BUFFER) {
      triplesRef.current = triplesRef.current.slice(-TRIPLE_BUFFER);
    }
    klog('notch', 'debug', 'turn triple recorded', { total: triplesRef.current.length });
  }, []);

  // Last N triples → the tutor's `recentContext`.
  const buildRecentContext = useCallback(() => {
    const t = triplesRef.current.slice(-TUTOR_HISTORY_TRIPLES);
    return t.length ? formatTriples(t) : '';
  }, []);

  // Last M triples → the gate.
  const buildGateHistory = useCallback(() => {
    const t = triplesRef.current.slice(-GATE_HISTORY_TRIPLES);
    return t.length ? formatTriples(t) : '';
  }, []);

  return { recordTriple, buildRecentContext, buildGateHistory };
}
