import type { ControlAction, DeskEvent, DeskState } from './types';

export interface DeskSource {
  /** Starts feeding state. Returns a stop function. */
  subscribe(h: { onState(s: DeskState): void; onEvent(e: DeskEvent): void; onOffline(reason: string): void }): () => void;
  control(a: ControlAction): Promise<void>;
  readonly label: string;
}

export const ENGINE_URL: string = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export function createEngineSource(): DeskSource {
  return {
    label: ENGINE_URL,
    subscribe({ onState, onEvent, onOffline }) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let es: EventSource | undefined;

      const poll = async (): Promise<void> => {
        try {
          const r = await fetch(`${ENGINE_URL}/api/state`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const s = (await r.json()) as DeskState;
          if (!stopped) onState(s);
        } catch (e) {
          if (!stopped) onOffline(e instanceof Error ? e.message : String(e));
        }
        if (!stopped) timer = setTimeout(poll, 1000);
      };
      void poll();

      try {
        es = new EventSource(`${ENGINE_URL}/api/events`);
        es.onmessage = (m: MessageEvent<string>) => {
          try {
            onEvent(JSON.parse(m.data) as DeskEvent);
          } catch {
            /* ignore malformed message */
          }
        };
      } catch {
        /* polling still works */
      }

      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        es?.close();
      };
    },
    async control(a) {
      const r = await fetch(`${ENGINE_URL}/api/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a),
      });
      if (!r.ok) throw new Error(`Engine answered HTTP ${r.status}`);
    },
  };
}
