import type { DeskState } from '../types';
import { amount, assetLabel, clock, money3, shortHash } from '../format';

const TONE_BY_ID: Record<string, string> = { desk: 't0', risk: 't4', momentum: 't1', rwa: 't2', event: 't3' };
const tone = (id: string): string => TONE_BY_ID[id] ?? 't4';

export function SettlementPanel({ desk }: { desk: DeskState }) {
  const vault = desk.rail === 'bnb-testnet-vault';
  const alloc = desk.railState?.allocations ?? null;
  const order = ['desk', 'risk', 'momentum', 'rwa', 'event'];
  const entries = alloc ? Object.entries(alloc).map(([id, v]) => ({ id, v: amount(v) })).filter((e) => e.v > 0 || e.id === 'desk').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : [];
  const total = entries.reduce((t, e) => t + e.v, 0) || 1;
  const names = new Map<string, string>([['desk', 'Desk reserve'], ['risk', 'Risk manager']]);
  for (const a of desk.agents) names.set(a.agentId, a.name);
  const txs = desk.receipts.filter((r) => r.txHash);
  const recent = [...txs].reverse().slice(0, 3);
  const pending = desk.railPending ?? 0;
  const asset = assetLabel(desk);
  const links = desk.onchainLinks ?? [];

  return (
    <section className="panel settle" aria-label="Settlement">
      <div className="panel-head">
        <h2>{vault ? 'Settlement, on-chain' : 'Settlement'}</h2>
        <span className="muted small mono">{desk.railState ? `v${desk.railState.version}, ${desk.railState.status}` : 'no session'}</span>
      </div>
      {entries.length > 0 ? (
        <>
          <div className="alloc-bar" role="img" aria-label="Allocation by participant">
            {entries.map((e) => <div key={e.id} className={`seg ${tone(e.id)}`} style={{ width: `${(e.v / total) * 100}%` }} title={`${names.get(e.id) ?? e.id}: ${money3(e.v)} ${asset}`} />)}
          </div>
          <ul className="alloc-list">
            {entries.map((e) => (
              <li key={e.id}><i className={`sw ${tone(e.id)}`} /><span className="al-name">{names.get(e.id) ?? e.id}</span><span className="mono">{money3(e.v)} {asset}</span></li>
            ))}
          </ul>
        </>
      ) : <p className="empty">The pot has not been deposited yet.</p>}
      {vault ? (
        <p className="small receipts-head"><strong className="mono">{txs.length}</strong> transactions on BNB Smart Chain testnet{pending > 0 ? <span className="pending"> · {pending} transaction{pending > 1 ? 's' : ''} confirming</span> : null}</p>
      ) : (
        <p className="small receipts-head muted">Local ledger. No on-chain settlement in this mode.</p>
      )}
      {links.length > 0 && (
        <p className="small onchain-links">
          {links.map((l) => <span key={l.txHash}>{shortLabel(l.label)} <a className="mono" href={l.explorerUrl} target="_blank" rel="noreferrer" title={l.label}>{shortAddr(l)}</a></span>)}
        </p>
      )}
      <ul className="receipts">
        {recent.map((r) => (
          <li key={`${r.version}-${r.kind}`}>
            <span className="mono muted">{clock(r.ts)}</span>
            <span>{r.kind}{r.memo ? `, ${r.memo.toLowerCase()}` : ''}</span>
            <span className="mono small">{r.explorerUrl ? <a href={r.explorerUrl} target="_blank" rel="noreferrer">{shortHash(r.txHash ?? '')}</a> : shortHash(r.txHash ?? '')}</span>
          </li>
        ))}
        {desk.scorecards.map((s) => (
          <li key={s.txHash} className="scorecard">
            <span className="mono muted">BNB</span>
            <span>Scorecard, round {s.roundId}</span>
            <span className="mono small"><a href={s.explorerUrl} target="_blank" rel="noreferrer">{shortHash(s.txHash)}</a></span>
          </li>
        ))}
      </ul>
      {vault && <p className="muted small vault-note">The pot is held by the DeskVault contract in a test stablecoin. No allocation changes without the desk&apos;s transaction and the risk manager&apos;s signature.</p>}
    </section>
  );
}

const shortLabel = (l: string): string => {
  const i = l.indexOf(' deployed');
  return (i > 0 ? l.slice(0, i) : l.split(' at 0x')[0] ?? l).trim();
};
function shortAddr(l: { label: string; txHash: string; explorerUrl: string }): string {
  const m = /0x[0-9a-fA-F]{40}/.exec(l.label) ?? /0x[0-9a-fA-F]{40}/.exec(l.explorerUrl) ?? /0x[0-9a-fA-F]{8,}/.exec(l.txHash);
  const a = m ? m[0] : l.txHash;
  return a.length > 12 ? `${a.slice(0, 6)}\u2026${a.slice(-4)}` : a;
}
