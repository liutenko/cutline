import { useEffect, useRef, useState } from 'react';
import type { AgentId, DeskEvent, DeskState } from './types';
import type { DeskSource } from './source';

export interface DeskView {
  desk: DeskState | null;
  /** Set when the engine cannot be reached. */
  offline: string | null;
  /** Equity samples per agent, collected in this browser session (the engine sends no history). */
  history: Record<string, number[]>;
  /** Wall-clock time each agent was seen turning cut, for the brief highlight. */
  cutAt: Record<string, number>;
  /** Highest-numbered tick seen on each agent's history, to sample once per tick. */
  lastEvent: DeskEvent | null;
}

export function useDesk(source: DeskSource): DeskView {
  const [desk, setDesk] = useState<DeskState | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<DeskEvent | null>(null);
  const [history, setHistory] = useState<Record<string, number[]>>({});
  const [cutAt, setCutAt] = useState<Record<string, number>>({});
  const prevStatus = useRef<Record<string, string>>({});
  const lastKey = useRef<string>('');

  useEffect(() => {
    return source.subscribe({
      onState(s) {
        setOffline(null);
        setDesk(s);
        const key = `${s.round.id}:${s.round.tick}:${s.agents.map((a) => a.equityUsd.toFixed(2)).join(',')}`;
        if (key !== lastKey.current) {
          const reset = s.round.tick === 0 && s.round.phase === 'idle';
          lastKey.current = key;
          setHistory((h) => {
            const next: Record<string, number[]> = reset ? {} : { ...h };
            for (const a of s.agents) {
              const arr = reset ? [] : (next[a.agentId] ?? []).slice(-119);
              if (arr.length === 0) arr.push(a.startEquityUsd);
              arr.push(a.equityUsd);
              next[a.agentId] = arr;
            }
            return next;
          });
        }
        for (const a of s.agents) {
          const before = prevStatus.current[a.agentId];
          if (before && before !== 'cut' && a.status === 'cut') {
            const id: AgentId = a.agentId;
            setCutAt((c) => ({ ...c, [id]: Date.now() }));
          }
          prevStatus.current[a.agentId] = a.status;
        }
      },
      onEvent(e) {
        setLastEvent(e);
      },
      onOffline(reason) {
        setOffline(reason);
      },
    });
  }, [source]);

  return { desk, offline, history, cutAt, lastEvent };
}
