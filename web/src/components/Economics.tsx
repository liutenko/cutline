import type { DeskState } from '../types';
import { amount, money2, money3, assetLabel } from '../format';

export function Economics({ desk }: { desk: DeskState }) {
  const e = desk.economics;
  const asset = assetLabel(desk);
  const fig = (v: string | undefined, d = money3): string => (v === undefined ? '-' : `${d(amount(v))} ${asset}`);
  const items: [string, string][] = [
    ['Pot', `${money2(amount(desk.config.realPot))} ${asset}`],
    ['Capital at risk this round', fig(e?.capitalAtRisk)],
    ['Paid to agents', fig(e?.paidToAgents)],
    ['Losses absorbed', fig(e?.lossesAbsorbed)],
  ];
  return (
    <section className="economics" aria-label="Desk economics">
      <dl>
        {items.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>
        ))}
      </dl>
      <p className="muted small">
        {e ? `A prize pool is spent once. Capital at risk at the cut limits this round: ${money3(amount(e.capitalAtRisk))} ${asset}. A sudden move can carry a loss past its limit before the cut lands.` : 'Desk economics are not reported by the engine yet.'}
      </p>
    </section>
  );
}
