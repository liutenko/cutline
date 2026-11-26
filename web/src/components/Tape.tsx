import { useEffect, useRef } from 'react';
import type { AgentAccount, DeskEvent, Fill, Order, RiskCheck, RiskDecision } from '../types';
import { clock, price, usd } from '../format';

interface Row { order: Order; decision: RiskDecision; fill?: Fill; ts: number }

const SOURCES: { key: RiskCheck['source']; label: string; what: string }[] = [
  { key: 'CoinMarketCap', label: 'CoinMarketCap', what: 'liquidity' },
  { key: 'Atlas', label: 'Atlas', what: 'price check' },
  { key: 'Cournot', label: 'Cournot', what: 'event budget' },
];

function buildRows(events: DeskEvent[]): Row[] {
  const fills = new Map<string, Fill>();
  for (const e of events) if (e.type === 'fill') fills.set(e.fill.orderId, e.fill);
  const rows: Row[] = [];
  for (const e of events) if (e.type === 'decision') rows.push({ order: e.order, decision: e.decision, fill: fills.get(e.order.id), ts: e.ts });
  return rows.reverse().slice(0, 40);
}

function Badge({ label, what, checks }: { label: string; what: string; checks: RiskCheck[] }) {
  const state = checks.length === 0 ? 'na' : checks.every((c) => c.pass) ? 'pass' : 'fail';
  const text = state === 'na' ? 'not checked' : state === 'pass' ? 'pass' : 'fail';
  return (
    <span className={`badge b-${state}`} title={checks.map((c) => c.detail).join(' ')}>
      <span className="b-src">{label}</span>
      <span className="b-what">{what}</span>
      <span className="b-res">{text}</span>
    </span>
  );
}

export function Tape({ events, agents }: { events: DeskEvent[]; agents: AgentAccount[] }) {
  const rows = buildRows(events);
  const names = new Map(agents.map((a) => [a.agentId, a.name]));
  const seen = useRef<Set<string> | null>(null);
  const fresh = (id: string): boolean => seen.current !== null && !seen.current.has(id);
  const freshIds = rows.map((r) => fresh(r.order.id));
  useEffect(() => {
    seen.current = new Set(rows.map((r) => r.order.id));
  });
  const rejected = rows.filter((r) => !r.decision.approved).length;

  return (
    <section className="panel tape" aria-label="Order tape">
      <div className="panel-head">
        <h2>Order tape</h2>
        <span className="muted small mono">{rows.length === 0 ? 'no orders yet' : `last ${rows.length} orders, ${rejected} rejected`}</span>
      </div>
      <div className="tape-rows">
        {rows.length === 0 && <p className="empty">Orders appear here as agents submit them. Every order is checked before it counts.</p>}
        {rows.map((r, i) => {
          const o = r.order;
          const ok = r.decision.approved;
          const failing = r.decision.checks.filter((c) => !c.pass);
          const desk = r.decision.checks.filter((c) => c.source === 'Desk');
          return (
            <article key={o.id} className={`order ${ok ? 'approved' : 'rejected'} ${freshIds[i] ? 'fresh' : ''}`}>
              <div className="o-main">
                <span className="mono muted o-time">{clock(r.ts)}</span>
                <span className="o-agent">{names.get(o.agentId) ?? o.agentId}</span>
                <span className={`o-side ${o.side}`}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span>
                <span className="mono o-sym">{o.symbol}</span>
                <span className="mono o-size">{usd(o.notionalUsd)}</span>
                <span className={`o-verdict ${ok ? 'ok' : 'no'}`}>{ok ? 'Approved' : 'Rejected'}</span>
              </div>
              <p className="o-why">{o.brain === 'llm' && <span className="brain">Claude</span>}{o.rationale}</p>
              {ok ? (
                <p className="o-pass small">
                  <span className="ok-txt">{SOURCES.filter((s) => r.decision.checks.some((c) => c.source === s.key)).map((s) => `${s.label} ${s.what}`).join(', ')}: pass</span>
                  {r.fill && <span className="muted mono">{` · filled at ${price(r.fill.price)}${costs(r.fill)}`}</span>}
                </p>
              ) : (
              <div className="o-badges">
                {SOURCES.map((s) => (
                  <Badge key={s.key} label={s.label} what={s.what} checks={r.decision.checks.filter((c) => c.source === s.key)} />
                ))}
                {desk.some((c) => !c.pass) && <Badge label="Desk" what="account rules" checks={desk} />}
              </div>
              )}
              {failing.length > 0 && (
                <ul className="o-fails">
                  {failing.map((c) => (
                    <li key={c.name}><span className="f-src">{c.source}</span> {c.detail}</li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function costs(f: Fill): string {
  const parts: string[] = [];
  if (f.slippagePct !== undefined) parts.push(`est. slippage ${f.slippagePct.toFixed(2)}%`);
  if (f.feePct !== undefined) parts.push(`pool fee ${f.feePct.toFixed(2)}%`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}
