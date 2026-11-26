import type { DeskState } from '../types';
import { amount, clock, money3, shortHash, usd } from '../format';

const TONE_BY_ID: Record<string, string> = { desk: 't0', risk: 't4', momentum: 't1', rwa: 't2', event: 't3' };
const tone = (id: string): string => TONE_BY_ID[id] ?? 't4';

export function SettlementPanel({ desk }: { desk: DeskState }) {
  const alloc = desk.railState?.allocations ?? null;
  const order = ['desk', 'risk', 'momentum', 'rwa', 'event'];
  const entries = alloc ? Object.entries(alloc).map(([id, v]) => ({ id, v: amount(v) })).filter((e) => e.v > 0 || e.id === 'desk').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : [];
  const total = entries.reduce((t, e) => t + e.v, 0) || 1;
  const names = new Map<string, string>([['desk', 'Desk reserve'], ['risk', 'Risk manager']]);
  for (const a of desk.agents) names.set(a.agentId, a.name);
  const offchain = desk.receipts.filter((r) => r.offchain).length;
  const onchain = desk.receipts.filter((r) => !r.offchain);
  const recent = [...desk.receipts].reverse().slice(0, 1);
  const asset = desk.config.asset.toUpperCase();

  return (
    <section className="panel settle" aria-label="Settlement">
      <div className="panel-head">
        <h2>Settlement</h2>
        <span className="muted small mono">{desk.railState ? `session v${desk.railState.version}, ${desk.railState.status}` : 'no session'}</span>
      </div>
      {entries.length > 0 ? (
        <>
          <div className="alloc-bar" role="img" aria-label="Allocation by participant">
            {entries.map((e) => <div key={e.id} className={`seg ${tone(e.id)}`} style={{ width: `${(e.v / total) * 100}%` }} title={`${names.get(e.id) ?? e.id}: ${money3(e.v)} ${asset}`} />)}
          </div>
          <p className="muted small demo-note">Demo pot: {amount(desk.config.realPot)} {asset}. Each {amount(desk.config.realAllocationPerAgent)} {asset} allocation mirrors a {usd(desk.config.paperAccountUsd)} paper account.</p>
          <ul className="alloc-list">
            {entries.map((e) => (
              <li key={e.id}><i className={`sw ${tone(e.id)}`} /><span className="al-name">{names.get(e.id) ?? e.id}</span><span className="mono">{money3(e.v)} {asset}</span></li>
            ))}
          </ul>
        </>
      ) : <p className="empty">The pot has not been deposited yet.</p>}
      <p className="small receipts-head"><strong className="mono">{offchain}</strong> off-chain updates, no gas. <strong className="mono">{onchain.length}</strong> on-chain.</p>
      {(desk.onchainLinks ?? []).length > 0 && (
        <ul className="receipts onchain-links">
          {(desk.onchainLinks ?? []).map((l) => (
            <li key={l.txHash} className="scorecard">
              <span className="mono muted">BNB</span>
              <span>{l.label}</span>
              <span className="mono small"><a href={l.explorerUrl} target="_blank" rel="noreferrer">tx {shortHash(l.txHash)}</a></span>
            </li>
          ))}
        </ul>
      )}
      <ul className="receipts">
        {recent.map((r) => (
          <li key={`${r.version}-${r.kind}`}>
            <span className="mono muted">{clock(r.ts)}</span>
            <span>{r.kind} v{r.version}{r.memo ? `, ${r.memo.toLowerCase()}` : ''}</span>
            <span className="mono small">
              {r.offchain ? 'off-chain' : r.txHash ? (r.explorerUrl ? <a href={r.explorerUrl} target="_blank" rel="noreferrer">tx {shortHash(r.txHash)}</a> : `tx ${shortHash(r.txHash)}`) : 'on-chain'}
            </span>
          </li>
        ))}
        {desk.scorecards.map((s) => (
          <li key={s.txHash} className="scorecard">
            <span className="mono muted">BNB</span>
            <span>Scorecard, round {s.roundId}</span>
            <span className="mono small"><a href={s.explorerUrl} target="_blank" rel="noreferrer">tx {shortHash(s.txHash)}</a></span>
          </li>
        ))}
      </ul>
      <p className="credit">{creditLine(desk.rail)}</p>
    </section>
  );
}

function creditLine(rail: DeskState['rail']): string {
  if (rail === 'local') return 'Local ledger. Settlement rail not connected.';
  return rail === 'yellow-sandbox' ? 'Settlement runs on Yellow Network Protocol (sandbox)' : 'Settlement runs on Yellow Network Protocol';
}
