import type { DeskConfig } from '../../../shared/src/types.ts';

/** DeskConfig plus engine-only settings. Served as DeskState.config (extra fields are harmless). */
export type EngineConfig = DeskConfig & {
  /** Pool fee charged on every paper fill, in percent. */
  poolFeePct: number;
  /** Fills an agent needs during evaluation before it can be funded. */
  evalMinTrades: number;
  /** Lowest paper P&L (percent of the account, after costs) that still passes evaluation. */
  evalMinPnlPct: number;
};

export const DEFAULT_CONFIG: EngineConfig = {
  paperAccountUsd: 25000,
  realPot: '10',
  realAllocationPerAgent: '3',
  asset: 'usdt',
  profitSplitAgent: 0.8,
  maxDrawdownPct: 6,
  dailyLossLimitPct: 3,
  maxOrderPctOfLiquidity: 2,
  priceToleranceBps: 50,
  maxConcentrationPct: 40,
  baseRiskBudgetPct: 100,
  minEventMultiplier: 0.25,
  evalTicks: 6,
  tickMs: 5000,
  poolFeePct: 0.25,
  evalMinTrades: 2,
  evalMinPnlPct: -0.5,
};

function num(v: string | undefined, d: number): number {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Overrides from env: EVAL_TICKS, TICK_MS, REAL_POT, REAL_ALLOCATION, ASSET, POOL_FEE_PCT, EVAL_MIN_TRADES, EVAL_MIN_PNL_PCT. */
export function configFromEnv(env: Record<string, string | undefined>): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    evalTicks: num(env.EVAL_TICKS, DEFAULT_CONFIG.evalTicks),
    tickMs: num(env.TICK_MS, DEFAULT_CONFIG.tickMs),
    realPot: env.REAL_POT?.trim() || DEFAULT_CONFIG.realPot,
    realAllocationPerAgent: env.REAL_ALLOCATION?.trim() || DEFAULT_CONFIG.realAllocationPerAgent,
    asset: env.ASSET === 'usdc' ? 'usdc' : 'usdt',
    poolFeePct: num(env.POOL_FEE_PCT, DEFAULT_CONFIG.poolFeePct),
    evalMinTrades: num(env.EVAL_MIN_TRADES, DEFAULT_CONFIG.evalMinTrades),
    evalMinPnlPct: num(env.EVAL_MIN_PNL_PCT, DEFAULT_CONFIG.evalMinPnlPct),
  };
}
