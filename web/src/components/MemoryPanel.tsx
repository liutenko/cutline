import type { DeskState } from '../types';
import { clock } from '../format';

export function MemoryPanel({ desk }: { desk: DeskState }) {
  const m = desk.memoryStatus;
  if (!m?.enabled) return null;
  return (
    <section className="panel memory" aria-label="Desk memory">
      <div className="panel-head">
        <h2>Desk memory</h2>
        <span className="muted small">Living Brain{m.brainName ? `, brain ${m.brainName}` : ''}</span>
      </div>
      <p className="small">
        <span className="mono">{m.pendingCaptures > 0 ? `${m.pendingCaptures} captures compiling` : 'up to date'}</span>
        <span className="muted mono"> · written {m.lastWriteAt ? clock(m.lastWriteAt).slice(0, 5) : 'never'} · recalled {m.lastRecallAt ? clock(m.lastRecallAt).slice(0, 5) : 'never'}</span>
      </p>
      {m.error && <p className="small mem-err">{m.error}</p>}
      <p className="muted small mem-cap">After each round the desk writes what every agent did. Before the next round it reads each agent&apos;s record.</p>
    </section>
  );
}
