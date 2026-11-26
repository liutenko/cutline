import type { AgentId, AgentStatus, ScorecardTx } from '../../../shared/src/types.js';

export interface RoundAgentReport {
  agentId: AgentId;
  name: string;
  strategy: string;
  status: AgentStatus;
  pnlPct: number;
  trades: number;
  rejectedOrders: number;
  cutReason?: string;
  rogue?: boolean;
  notableRejections: string[];
}

export interface RoundReport {
  roundId: number;
  closedAt: number;
  agents: RoundAgentReport[];
  eventMultiplier: number;
  scorecardTx?: string;
}

export function originRefFor(roundId: number, agentId: string): string {
  return `cutline:round:${roundId}:agent:${agentId}`;
}

const pct = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const stripEnd = (s: string): string => s.trim().replace(/[.\s]+$/, '');

/**
 * One short, factual document per agent per round. Plain sentences, one fact each, so the
 * brain's compiler keeps them. The word "cut" appears only when the agent was actually cut.
 */
export function agentDocument(report: RoundReport, a: RoundAgentReport): string {
  const result = a.status === 'cut' ? 'CUT' : a.status === 'funded' ? 'FUNDED' : 'still evaluating, not funded';
  const parts: string[] = [
    `Round ${report.roundId} on the Cutline desk.`,
    `Agent ${a.name} (strategy: ${stripEnd(a.strategy)}).`,
    `Result: ${result}.`,
  ];
  if (a.status === 'cut' && a.cutReason) parts.push(`Reason: ${stripEnd(a.cutReason)}.`);
  parts.push(`Paper P&L ${pct(a.pnlPct)}.`);
  parts.push(`Trades: ${a.trades}.`);
  const rej = a.notableRejections.map(stripEnd).filter(Boolean);
  parts.push(
    a.rejectedOrders > 0
      ? `Rejected orders: ${a.rejectedOrders}${rej.length ? `, including ${rej.join('; ')}` : ''}.`
      : 'Rejected orders: 0.',
  );
  if (a.rogue) parts.push(`Rogue demo mode was switched on for ${a.name} in this round.`);
  parts.push(`Event risk multiplier for the round: ${report.eventMultiplier.toFixed(2)}.`);
  if (report.scorecardTx) parts.push(`Scorecard transaction: ${report.scorecardTx}.`);
  parts.push(`Round closed at ${new Date(report.closedAt).toISOString()}.`);
  return parts.join(' ');
}

export type { ScorecardTx };
