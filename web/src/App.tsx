import { useEffect, useMemo } from 'react';
import { assetLabel } from './format';
import { PRODUCT_NAME } from './config';
import { Economics } from './components/Economics';
import { createEngineSource, ENGINE_URL } from './source';
import { createMockSource } from './mock/mockEngine';
import { useDesk } from './useDesk';
import { Header } from './components/Header';
import { Leaderboard } from './components/Leaderboard';
import { Tape } from './components/Tape';
import { EventRiskPanel } from './components/EventRisk';
import { MarketStrip } from './components/Market';
import { SettlementPanel } from './components/Settlement';
import { Controls } from './components/Controls';

const params = new URLSearchParams(window.location.search);
const MOCK = params.get('mock') === '1';
const SPEED = Math.max(0.25, Math.min(10, Number(params.get('speed')) || 1));

export default function App() {
  const source = useMemo(() => (MOCK ? createMockSource(SPEED) : createEngineSource()), []);
  const { desk, offline, history, cutAt } = useDesk(source);
  useEffect(() => { document.title = PRODUCT_NAME; }, []);

  if (!desk) {
    return (
      <div className="shell">
        <div className="offline-full">
          <h1>{PRODUCT_NAME}</h1>
          {offline ? (
            <>
              <h2>Engine offline</h2>
              <p>The dashboard could not reach the engine at <span className="mono">{ENGINE_URL}</span>. Start it and this page will connect on its own. No data is shown until it does.</p>
              <p className="muted small mono">{offline}</p>
            </>
          ) : <p className="muted">Connecting to the engine</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      {offline && <div className="offline-bar" role="alert"><strong>Engine offline.</strong> Showing the last state received. <span className="mono small">{offline}</span></div>}
      <Header desk={desk} mock={MOCK} />
      <MarketStrip snapshot={desk.snapshot} />
      <main className={`board ${offline ? 'stale' : ''}`}>
        <div className="col-left">
          <Economics desk={desk} />
          <Leaderboard agents={desk.agents} config={desk.config} phase={desk.round.phase} asset={assetLabel(desk)} history={history} cutAt={cutAt} />
        </div>
        <div className="col-main">
          <Tape events={desk.events} agents={desk.agents} />
        </div>
        <div className="col-side">
          <EventRiskPanel events={desk.snapshot?.eventRisk ?? []} multiplier={desk.eventMultiplier} />
          <SettlementPanel desk={desk} />
        </div>
      </main>
      <footer className="foot">
        <p>{desk.rail === 'bnb-testnet-vault' ? 'Trades are paper trades at live prices. Capital (test tokens on BNB Smart Chain testnet), cut-offs, payouts and scorecards are on-chain.' : 'Trades are paper trades at live prices. Capital is a local ledger in this mode.'}</p>
        <Controls desk={desk} send={source.control} />
      </footer>
    </div>
  );
}
