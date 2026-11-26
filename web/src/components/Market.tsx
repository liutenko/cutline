import type { MarketSnapshot } from '../types';
import { clock, price } from '../format';

const AGREE = {
  both: { text: 'Atlas confirmed', cls: 'ok' },
  single: { text: 'CoinMarketCap only', cls: 'warn' },
  disagree: { text: 'Atlas disagrees', cls: 'no' },
} as const;

export function MarketStrip({ snapshot }: { snapshot: MarketSnapshot | null }) {
  const marks = snapshot ? Object.values(snapshot.marks) : [];
  return (
    <section className="marketstrip" aria-label="Market strip">
      <div className="ms-label">
        <span className="label">Marks</span>
        <span className="muted small">CoinMarketCap, Atlas</span>
        <span className="muted small mono">{snapshot ? clock(snapshot.ts) : ''}</span>
        {snapshot?.fearGreed !== undefined && <span className="muted small">Fear and greed {snapshot.fearGreed}</span>}
      </div>
      {marks.length === 0 && <p className="empty">No marks yet.</p>}
      {marks.map((m) => {
        const base = AGREE[m.agreement];
        const age = m.atlasTs !== undefined && snapshot ? Math.max(0, Math.round((snapshot.ts - m.atlasTs) / 60000)) : null;
        const a = m.atlasStale ? { text: age !== null ? `Atlas price stale, ${age} min old` : 'Atlas price stale', cls: 'warn' } : base;
        return (
          <div key={m.symbol} className={`ms-cell ${m.synthetic ? 'sim' : ''}`}>
            <div className="ms-top"><span className="sym">{m.symbol}</span><span className="mono ms-px">{price(m.cmcPrice)}</span></div>
            <div className="mono small ms-atlas">
              {m.atlasPrice !== undefined
                ? <><span className="muted">Atlas</span> {price(m.atlasPrice)}</>
                : <span className="muted">No Atlas price</span>}
            </div>
            <div className="ms-agree"><span className={`agree ${a.cls}`} title={a.text}>{a.text}{m.deviationBps !== undefined && m.atlasPrice !== undefined && !m.atlasStale ? `, ${m.deviationBps.toFixed(0)} bps` : ''}</span>{m.synthetic && <span className="sim-tag">Simulated shock</span>}</div>
          </div>
        );
      })}
    </section>
  );
}
