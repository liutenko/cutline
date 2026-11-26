// Autopilot: runs rounds back to back with no operator. Start, trade for ROUND_MINUTES, close, rest, repeat.
// It only uses the same control actions as the API, and never uses the demo controls (rogue, shock).
import type { Desk } from './desk.ts';
import { errMsg } from './desk.ts';

export interface AutopilotOptions {
  roundMs: number;
  restMs: number;
  checkMs?: number;
  log: (m: string) => void;
}

export function startAutopilot(desk: Desk, o: AutopilotOptions): () => void {
  let settledSeen = 0;
  let backoffUntil = 0;
  let busy = false;
  const act = async (action: 'start' | 'close-round' | 'reset', why: string) => {
    o.log(`autopilot: ${action} (${why})`);
    try {
      await desk.control({ action });
      if (action === 'start' && desk.state().round.phase === 'idle') {
        o.log('autopilot: the round did not open; retrying in a minute');
        backoffUntil = Date.now() + 60_000;
      }
    } catch (e) {
      o.log(`autopilot: ${action} failed: ${errMsg(e)}`);
      backoffUntil = Date.now() + 60_000;
      if (action !== 'reset') await desk.control({ action: 'reset' }).catch(() => undefined);
    }
  };
  const tick = async () => {
    if (busy || Date.now() < backoffUntil) return;
    busy = true;
    try {
      const s = desk.state();
      const now = Date.now();
      const pending = (s.railPending ?? 0) > 0;
      const phase = s.round.phase;
      if (phase !== 'settled') settledSeen = 0;
      if (phase === 'idle') return void (await act('start', 'desk idle'));
      if (phase === 'settled') {
        if (!settledSeen) settledSeen = now;
        if (!pending && now - settledSeen >= o.restMs) await act('start', 'next round');
        return;
      }
      // evaluation or funded
      if (!s.running && !pending) return void (await act('reset', 'desk paused mid-round'));
      const started = s.round.startedAt ?? now;
      if (!pending && now - started >= o.roundMs) await act('close-round', `round ran ${Math.round((now - started) / 60_000)} min`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), o.checkMs ?? 5_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
