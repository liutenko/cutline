import type { DeskState } from '../types';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '../config';
import { amount, clock, dateTime, money2 } from '../format';

const PHASE: Record<DeskState['round']['phase'], string> = {
  idle: 'Not started', evaluation: 'Evaluation', funded: 'Funded trading', settled: 'Settled',
};
const RAIL: Record<DeskState['rail'], string> = {
  local: 'Local rail', 'yellow-sandbox': 'Yellow sandbox rail', 'yellow-mainnet': 'Yellow mainnet rail',
};

export function Header({ desk, mock }: { desk: DeskState; mock: boolean }) {
  const pot = amount(desk.config.realPot);
  const asset = desk.config.asset.toUpperCase();
  const deployed = desk.agents.reduce((t, a) => t + amount(a.realAllocation), 0);
  const reserveRaw = desk.railState?.allocations.desk;
  const reserve = reserveRaw !== undefined ? amount(reserveRaw) : pot - deployed;
  const replayTs = desk.snapshot?.ts;
  return (
    <header className="masthead">
      <div className="mast-title">
        <h1>{PRODUCT_NAME}</h1>
        <p>{PRODUCT_TAGLINE}</p>
      </div>
      <div className="mast-meta">
        <div className="tags">
          {mock && <span className="tag tag-mock">MOCK DATA</span>}
          {mock ? null : desk.mode === 'dev' ? (
            <span className="tag tag-mock">DEV SIMULATION</span>
          ) : desk.mode === 'live' ? (
            <span className="tag tag-live"><i className="dot" />LIVE</span>
          ) : (
            <span className="tag">Replay of live data recorded {replayTs ? dateTime(replayTs) : 'earlier'}</span>
          )}
          <span className="tag">{RAIL[desk.rail]}</span>
        </div>
        <div className="round">
          <span className="label" title={`Round id ${desk.round.id}`}>{desk.round.startedAt ? `Round started ${clock(desk.round.startedAt)}` : 'Round not started'}</span>
          <strong>{PHASE[desk.round.phase]}</strong>
          <span className="muted mono">tick {desk.round.tick}{desk.round.phase !== 'idle' && desk.round.phase !== 'settled' ? (desk.running ? '' : ', paused') : ''}</span>
        </div>
      </div>
      <div className="pot">
        <span className="label">Pot</span>
        <div className="pot-fig"><span className="big">{money2(pot)}</span> <span className="unit">{asset}</span></div>
        <div className="muted mono small">desk reserve {money2(reserve)} · with agents {money2(Math.max(0, pot - reserve))}</div>
      </div>
    </header>
  );
}
