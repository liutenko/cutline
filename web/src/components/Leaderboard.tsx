import type { AccountView } from './types';
import type { AgentAccount, DeskConfig, DeskState } from '../types';
import { amount, money3, pct, signedUsd, usd } from '../format';
import { Sparkline } from './Sparkline';

const STATUS: Record<AgentAccount['status'], string> = { evaluating: 'Evaluating', funded: 'Funded', cut: 'Cut' };

function Meter({ label, value, limit }: { label: string; value: number; limit: number }) {
  const ratio = Math.min(1, value / limit);
  const tone = ratio >= 0.85 ? 'hot' : ratio >= 0.6 ? 'warm' : 'ok';
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><span className="mono">{value.toFixed(2)}% of {limit}%</span></div>
      <div className="track"><div className={`fill ${tone}`} style={{ width: `${ratio * 100}%` }} /></div>
    </div>
  );
}

export function Leaderboard({ agents, config, phase, memoryOn, asset, history, cutAt }: { agents: AgentAccount[]; config: DeskConfig; phase: DeskState['round']['phase']; memoryOn: boolean; asset: string } & AccountView) {
  const order: Record<AgentAccount['status'], number> = { funded: 0, evaluating: 1, cut: 2 };
  const rank = [...agents].sort((a, b) => order[a.status] - order[b.status] || b.pnlPct - a.pnlPct);
  const rules = [
    `Funded after ${config.evalTicks} ticks`
      + (config.evalMinTrades !== undefined ? ` with at least ${config.evalMinTrades} trades` : '')
      + (config.evalMinPnlPct !== undefined ? `${config.evalMinTrades !== undefined ? ' and' : ' with'} P&L no worse than ${config.evalMinPnlPct}%` : '')
      + '.',
    `Cut at ${config.maxDrawdownPct}% drawdown or ${config.dailyLossLimitPct}% daily loss.`,
  ].join(' ');
  return (
    <section className="panel leaderboard" aria-label="Agent leaderboard">
      <div className="panel-head">
        <h2>Agent leaderboard</h2>
        <span className="muted small">Paper accounts of {usd(config.paperAccountUsd)}</span>
      </div>
      <p className="muted small rules">{rules}</p>
      <div className="agents">
        {rank.map((a, i) => {
          const hist = a.equityHistory && a.equityHistory.length > 0 ? a.equityHistory : (history[a.agentId] ?? []);
          const scale = amount(config.realAllocationPerAgent) / config.paperAccountUsd;
          const realAmt = amount(a.realAllocation);
          const flash = cutAt[a.agentId] !== undefined && a.status === 'cut' ? 'just-cut' : '';
          const tone = a.pnlUsd > 0.5 ? 'up' : a.pnlUsd < -0.5 ? 'down' : 'flat';
          return (
            <article key={a.agentId} className={`agent st-${a.status} ${flash} ${a.rogue ? 'rogue' : ''}`}>
              <div className="a-l1">
                <span className="rank mono">{i + 1}</span>
                <h3>{a.name}</h3>
                <span className="a-strat muted small" title={a.strategy}>{a.strategy}</span>
                {a.memory?.probation && <span className="status s-probation">Probation</span>}
                <span className={`status s-${a.status}`}>{STATUS[a.status]}</span>
              </div>
              {a.memory ? (
                <div className="a-mem">
                  <p className="mem-line"><span className="mem-label">Desk memory</span><em title={a.memory.summary}>{a.memory.summary}</em>{a.memory.pages[0] && <span className="mono small muted mem-page"> page {a.memory.pages[0].slug}{a.memory.pages[0].version !== undefined ? ` v${a.memory.pages[0].version}` : ''}</span>}</p>
                  {a.memory.probation && <p className="small prob-note">Risk budget at {Math.round((config.probationBudgetFactor ?? 0.5) * 100)}% this round: an earlier cut is on record.</p>}
                </div>
              ) : memoryOn ? <p className="small muted a-mem">Desk memory: no record yet</p> : null}
              <div className="a-l2">
                <div className="eq-fig">
                  <span className="big">{usd(a.equityUsd)}</span>
                  <span className={`mono pnl ${tone}`}>{pct(a.pnlPct, 2, true)} <span className="small">{signedUsd(a.pnlUsd)}</span></span>
                </div>
                <Sparkline values={hist} baseline={a.startEquityUsd} tone={tone} width={150} height={28} />
              </div>
              <div className="a-l3">
                <Meter label="Drawdown" value={a.drawdownPct} limit={config.maxDrawdownPct} />
                <Meter label="Daily loss" value={a.dailyLossPct} limit={config.dailyLossLimitPct} />
              </div>
              <dl className="a-l4">
                <div><dt>Risk budget</dt><dd className="mono">{a.status === 'cut' ? 'none' : usd(a.riskBudgetUsd)}</dd></div>
                <div><dt>{phase === 'settled' ? 'Paid out' : 'Real capital'}</dt><dd className="mono">{money3(realAmt)} {asset}{scale > 0 && <span className="muted small"> = {usd(realAmt / scale)} paper</span>}</dd></div>
              </dl>
              {a.status === 'cut' && <p className="cut-reason"><strong>Cut.</strong> {a.cutReason ?? 'Reason not reported by the engine.'}</p>}
              {a.status !== 'cut' && a.evalNote && <p className="cut-reason warn">{a.evalNote}</p>}
              {a.rogue && a.status !== 'cut' && <p className="cut-reason warn"><strong>Rogue mode on.</strong> Oversized orders will be blocked.</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
