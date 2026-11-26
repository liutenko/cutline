import { useState } from 'react';
import type { AgentAccount, ControlAction, DeskState } from '../types';

export function Controls({ desk, send }: { desk: DeskState; send: (a: ControlAction) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [rogueId, setRogueId] = useState<AgentAccount['agentId']>('momentum');
  const marks = desk.snapshot ? Object.keys(desk.snapshot.marks) : [];
  const holders = new Map<string, string[]>();
  for (const a of desk.agents) for (const p of a.positions) if (p.qty > 0) holders.set(p.symbol, [...(holders.get(p.symbol) ?? []), a.name]);
  const symbols = [...holders.keys(), ...marks.filter((m) => !holders.has(m))];
  const [sym, setSym] = useState('');
  const [size, setSize] = useState(-15);
  const [err, setErr] = useState<string | null>(null);
  const run = (a: ControlAction) => async () => {
    try {
      setErr(null);
      await send(a);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Control failed');
    }
  };
  const name = desk.agents.find((a) => a.agentId === rogueId)?.name ?? rogueId;
  const symValue = symbols.includes(sym) ? sym : (symbols[0] ?? 'BNB');
  return (
    <div className={`controls ${open ? 'open' : ''}`}>
      <button className="ctl-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>Demo controls</button>
      {open && (
        <div className="ctl-body">
          <div className="ctl-row">
            <button onClick={run({ action: 'start' })}>Start</button>
            <button onClick={run({ action: 'pause' })}>Pause</button>
            <button onClick={run({ action: 'reset' })}>Reset</button>
            <button onClick={run({ action: 'close-round' })}>Close round</button>
            <button onClick={run({ action: 'recall' })}>Recall desk memory</button>
          </div>
          <div className="ctl-row">
            <select value={rogueId} onChange={(e) => setRogueId(e.target.value as AgentAccount['agentId'])} aria-label="Agent">
              {desk.agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
            </select>
            <button onClick={run({ action: 'rogue', agentId: rogueId })}>Make {name} go rogue</button>
          </div>
          <div className="ctl-row">
            <select value={symValue} onChange={(e) => setSym(e.target.value)} aria-label="Symbol">
              {symbols.map((s) => <option key={s} value={s}>{s}{holders.has(s) ? ` (held by ${holders.get(s)!.join(', ')})` : ' (not held)'}</option>)}
            </select>
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Shock size">
              {[-10, -15, -25].map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>
            <button onClick={run({ action: 'shock', symbol: symValue, pct: size })}>Stress test: shock {symValue} by {size}%</button>
          </div>
          {err && <p className="ctl-err">{err}</p>}
        </div>
      )}
    </div>
  );
}
