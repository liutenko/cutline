import type { AgentId, Instrument, Order, Sym } from '../../../../shared/src/types.ts';
import { grossExposure, positionValue, usd } from '../risk.ts';
import type { BrainContext, Candidate } from './types.ts';

/** Each buy tranche is this share of equity. */
export const TRANCHE_PCT = 12;
/** Target per-symbol weight, under the 40% concentration limit. */
export const TARGET_PCT = 36;
export const MIN_ORDER_USD = 250;
/** Largest estimated price impact a brain will accept on one order, in percent (impact = 2 x notional / liquidity). */
export const MAX_IMPACT_PCT = 0.5;

let seq = 0;
export function mkOrder(ctx: BrainContext, agentId: AgentId, symbol: Sym, side: 'buy' | 'sell', notionalUsd: number, rationale: string): Order {
  seq++;
  return {
    id: `${agentId}-t${ctx.tick}-${seq}`,
    agentId,
    symbol,
    side,
    notionalUsd: Math.round(notionalUsd * 100) / 100,
    rationale,
    ts: ctx.snapshot.ts,
    brain: 'rule',
  };
}

export const weightPct = (ctx: BrainContext, symbol: Sym) =>
  ctx.account.equityUsd > 0 ? (positionValue(ctx.account, ctx.snapshot, symbol) / ctx.account.equityUsd) * 100 : 0;

export function budgetUsd(ctx: BrainContext): number {
  return (ctx.account.equityUsd * ctx.config.baseRiskBudgetPct * ctx.eventMultiplier) / 100;
}

/** Largest buy that should pass every check, capped at one tranche and the target weight. */
export function buyRoom(ctx: BrainContext, symbol: Sym, targetPct = TARGET_PCT): number {
  const eq = ctx.account.equityUsd;
  const cur = positionValue(ctx.account, ctx.snapshot, symbol);
  const liq = ctx.snapshot.liquidity[symbol]?.dexLiquidityUsd ?? 0;
  const room = Math.min(
    (eq * TRANCHE_PCT) / 100,
    ctx.account.cashUsd - 1,
    budgetUsd(ctx) - grossExposure(ctx.account, ctx.snapshot) - 1,
    (eq * Math.min(targetPct, ctx.config.maxConcentrationPct - 1)) / 100 - cur,
    (liq * ctx.config.maxOrderPctOfLiquidity) / 100 * 0.95,
    (liq * MAX_IMPACT_PCT) / 100 / 2,
  );
  const r = Math.floor(room / 10) * 10;
  return r >= MIN_ORDER_USD ? r : 0;
}

/** If the event multiplier shrank the budget below current gross exposure, sell the excess from the largest position. */
export function trimCandidate(ctx: BrainContext, agentId: AgentId): Candidate | null {
  const gross = grossExposure(ctx.account, ctx.snapshot);
  const budget = budgetUsd(ctx);
  const excess = gross - budget;
  if (excess < MIN_ORDER_USD) return null;
  let best: { symbol: Sym; value: number } | null = null;
  for (const p of ctx.account.positions) {
    const v = positionValue(ctx.account, ctx.snapshot, p.symbol);
    if (!best || v > best.value) best = { symbol: p.symbol, value: v };
  }
  if (!best) return null;
  const liqCap = ((ctx.snapshot.liquidity[best.symbol]?.dexLiquidityUsd ?? 0) * ctx.config.maxOrderPctOfLiquidity) / 100;
  const amt = Math.min(best.value, excess + 50, liqCap * 0.95);
  if (amt < MIN_ORDER_USD) return null;
  return {
    key: `trim-${best.symbol}`,
    orders: [
      mkOrder(ctx, agentId, best.symbol, 'sell', amt,
        `The event multiplier is ${ctx.eventMultiplier.toFixed(2)}, so my risk budget is ${usd(budget)} against ${usd(gross)} of exposure; I sell ${usd(amt)} of ${best.symbol} to get back inside it.`),
    ],
  };
}

export function sellAll(ctx: BrainContext, agentId: AgentId, symbol: Sym, rationale: string): Order | null {
  const v = positionValue(ctx.account, ctx.snapshot, symbol);
  if (v < 1) return null;
  const liqCap = ((ctx.snapshot.liquidity[symbol]?.dexLiquidityUsd ?? 0) * ctx.config.maxOrderPctOfLiquidity) / 100;
  return mkOrder(ctx, agentId, symbol, 'sell', Math.min(v, liqCap * 0.95), rationale);
}

export function maxAdverseProb(ctx: BrainContext): { p: number; claim?: string } {
  let p = 0;
  let claim: string | undefined;
  // Assessments only, like the event multiplier: ranking rows are trading signals, not risk readings.
  for (const e of ctx.snapshot.eventRisk.filter((x) => x.origin !== 'ranking')) {
    const a = e.polarity === 'adverse' ? e.cournotProbability : 1 - e.cournotProbability;
    if (a > p) {
      p = a;
      claim = e.claim;
    }
  }
  return { p, claim };
}

export const fmtPct = (n: number | undefined) => (n === undefined ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
export const byKind = (ctx: BrainContext, kind: Instrument['kind']) =>
  ctx.instruments.filter((i) => i.kind === kind && ctx.snapshot.marks[i.symbol]);

/** Rogue mode: an oversized buy in a thin instrument that grows each attempt. */
export class RogueState {
  attempts = 0;
  candidate(ctx: BrainContext, agentId: AgentId): Candidate | null {
    const thin = byKind(ctx, 'thin')[0];
    if (!thin) return null;
    const liq = ctx.snapshot.liquidity[thin.symbol]?.dexLiquidityUsd ?? 0;
    const cap = (liq * ctx.config.maxOrderPctOfLiquidity) / 100;
    const size = Math.max(cap, 1000) * 2.5 * Math.pow(1.5, this.attempts);
    const mult = cap > 0 ? size / cap : Infinity;
    const text =
      this.attempts === 0
        ? `Rogue mode: I buy ${usd(size)} of ${thin.symbol}, ${mult.toFixed(1)} times the ${usd(cap)} size its DEX liquidity allows.`
        : `Rogue mode: order blocked, so I retry ${thin.symbol} larger at ${usd(size)}, ${mult.toFixed(1)} times the ${usd(cap)} liquidity cap.`;
    return { key: 'rogue', orders: [mkOrder(ctx, agentId, thin.symbol, 'buy', size, text)] };
  }
}
