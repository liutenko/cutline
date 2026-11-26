// Risk manager: pure functions. Every order passes these checks before it can fill.
import type {
  AgentAccount,
  DeskConfig,
  EventRisk,
  Instrument,
  MarketSnapshot,
  Order,
  RiskCheck,
  RiskDecision,
} from '../../../shared/src/types.ts';

export const usd = (n: number): string =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const pct = (n: number, digits = 1): string => `${n.toFixed(digits)}%`;
/** Price with sensible precision: 2 decimals above $1, 6 significant digits below. */
export const px = (n: number | undefined): string =>
  n === undefined ? 'n/a' : n >= 1 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Number(n.toPrecision(6)).toString();

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Gross exposure: sum of |position value| at current marks. Spot only, so all longs. */
export function grossExposure(account: AgentAccount, snapshot: MarketSnapshot): number {
  let g = 0;
  for (const p of account.positions) {
    const px = snapshot.marks[p.symbol]?.cmcPrice ?? p.avgPrice;
    g += Math.abs(p.qty * px);
  }
  return g;
}

export function positionValue(account: AgentAccount, snapshot: MarketSnapshot, symbol: string): number {
  const p = account.positions.find((x) => x.symbol === symbol);
  if (!p) return 0;
  const px = snapshot.marks[symbol]?.cmcPrice ?? p.avgPrice;
  return p.qty * px;
}

export interface EventMultiplierResult {
  multiplier: number;
  /** One sentence naming the driving claim and its probability. */
  reason: string;
  /** The event with the highest adverse probability, if any. */
  driver?: EventRisk;
  adverseProb: number;
  divergencePenalty: boolean;
}

/**
 * multiplier = clamp(1 - highest adverse probability, min, 1), using only full Cournot assessments with
 * polarity 'adverse'. Favorable claims never reduce the budget; with no adverse assessment it is 1.
 * Times 0.8 if any assessment's |divergence| >= 0.10. Clamped to [minEventMultiplier, 1] again after the
 * penalty, and rounded to 2 decimals so tiny probability moves do not spam events.
 */
export function eventMultiplier(events: EventRisk[], config: Pick<DeskConfig, 'minEventMultiplier'>): EventMultiplierResult {
  // Only full Cournot assessments (with evidence) move the multiplier; ranking rows are trading signals only.
  events = events.filter((e) => e.origin !== 'ranking');
  if (!events.length) {
    return { multiplier: 1, reason: 'No Cournot assessments are loaded, so risk budgets are at 100%.', adverseProb: 0, divergencePenalty: false };
  }
  const { p: maxAdverse, driver } = topAdverse(events);
  const divergent = events.find((e) => typeof e.divergence === 'number' && Math.abs(e.divergence) >= 0.1);
  let m = clamp(1 - maxAdverse, config.minEventMultiplier, 1);
  if (divergent) m = m * 0.8;
  m = clamp(m, config.minEventMultiplier, 1);
  m = Math.round(m * 100) / 100;

  let reason = driver
    ? `Cournot puts the adverse claim "${driver.claim}" at ${(maxAdverse * 100).toFixed(1)}%, so every risk budget is scaled to ${(m * 100).toFixed(0)}%`
    : `No adverse Cournot claim is loaded (favorable claims do not reduce budgets), so risk budgets are at ${(m * 100).toFixed(0)}%`;
  if (divergent) {
    reason += `, including a 0.8 penalty because Cournot and the venue differ by ${(Math.abs(divergent.divergence!) * 100).toFixed(0)} points on "${divergent.claim}"`;
  }
  reason += '.';
  return { multiplier: m, reason, driver, adverseProb: maxAdverse, divergencePenalty: !!divergent };
}

/**
 * The highest Cournot probability among full assessments with polarity 'adverse' (ranking rows and
 * favorable claims excluded). The single definition of "top adverse event probability".
 */
export function topAdverse(events: EventRisk[]): { p: number; driver?: EventRisk } {
  let p = 0;
  let driver: EventRisk | undefined;
  for (const e of events) {
    if (e.origin === 'ranking' || e.polarity !== 'adverse') continue;
    if (!driver || e.cournotProbability > p) {
      p = e.cournotProbability;
      driver = e;
    }
  }
  return { p, driver };
}

export interface RiskContext {
  account: AgentAccount;
  snapshot: MarketSnapshot;
  instruments: Instrument[];
  config: DeskConfig;
  eventMultiplier: number;
}

export function checkAgentStatus(order: Order, ctx: RiskContext): RiskCheck {
  const ok = ctx.account.status !== 'cut';
  return {
    name: 'agent-status',
    source: 'Desk',
    pass: ok,
    detail: ok
      ? `${ctx.account.name} is ${ctx.account.status} and allowed to trade.`
      : `${ctx.account.name} was cut (${ctx.account.cutReason ?? 'risk breach'}) and cannot trade.`,
  };
}

export function checkLiquidity(order: Order, ctx: RiskContext): RiskCheck {
  const liq = ctx.snapshot.liquidity[order.symbol];
  if (!liq || !(liq.dexLiquidityUsd > 0)) {
    return {
      name: 'liquidity',
      source: 'CoinMarketCap',
      pass: false,
      detail: `No BNB Chain DEX liquidity reading for ${order.symbol}, so the ${usd(order.notionalUsd)} order cannot be sized.`,
    };
  }
  const cap = (liq.dexLiquidityUsd * ctx.config.maxOrderPctOfLiquidity) / 100;
  const ok = order.notionalUsd <= cap;
  return {
    name: 'liquidity',
    source: 'CoinMarketCap',
    pass: ok,
    detail: ok
      ? `${usd(order.notionalUsd)} is within the ${usd(cap)} cap (${ctx.config.maxOrderPctOfLiquidity}% of ${usd(liq.dexLiquidityUsd)} DEX liquidity for ${order.symbol}).`
      : `${usd(order.notionalUsd)} exceeds the ${usd(cap)} cap (${ctx.config.maxOrderPctOfLiquidity}% of ${usd(liq.dexLiquidityUsd)} DEX liquidity for ${order.symbol}).`,
  };
}

export function checkPriceAgreement(order: Order, ctx: RiskContext): RiskCheck {
  const mark = ctx.snapshot.marks[order.symbol];
  const inst = ctx.instruments.find((i) => i.symbol === order.symbol);
  const base = { name: 'price-agreement' as const, source: 'Atlas' as const };
  if (!mark) return { ...base, pass: false, detail: `No price mark for ${order.symbol}.` };
  const tol = ctx.config.priceToleranceBps;
  if (mark.agreement === 'both') {
    const dev = mark.deviationBps !== undefined ? `${mark.deviationBps.toFixed(1)} bps` : 'within tolerance';
    return {
      ...base,
      pass: true,
      detail: `CoinMarketCap ${px(mark.cmcPrice)} and Atlas ${px(mark.atlasPrice)} agree for ${order.symbol} (${dev}, tolerance ${tol} bps).`,
    };
  }
  if (mark.agreement === 'single') {
    const kind = inst?.kind ?? 'unknown';
    const ok = kind === 'major' || kind === 'rwa';
    const why = mark.atlasStale
      ? mark.atlasTs !== undefined
        ? `Single source: the Atlas price is ${Math.max(0, Math.round((ctx.snapshot.ts - mark.atlasTs) / 60000))} minutes old`
        : 'Single source: the Atlas price is stale'
      : `Single source: no Atlas feed for ${order.symbol}`;
    return {
      ...base,
      pass: ok,
      detail: `${why}, so ${order.symbol} is priced by CoinMarketCap alone at ${px(mark.cmcPrice)}, ${ok ? 'accepted' : 'not accepted'} for a ${kind} instrument.`,
    };
  }
  return {
    ...base,
    pass: false,
    detail: `CoinMarketCap ${px(mark.cmcPrice)} and Atlas ${px(mark.atlasPrice)} disagree for ${order.symbol} by ${mark.deviationBps?.toFixed(1) ?? '?'} bps, above the ${tol} bps tolerance.`,
  };
}

export function checkEventBudget(order: Order, ctx: RiskContext): RiskCheck {
  const equity = ctx.account.equityUsd;
  const budget = (equity * ctx.config.baseRiskBudgetPct * ctx.eventMultiplier) / 100;
  const gross = grossExposure(ctx.account, ctx.snapshot);
  const base = { name: 'event-budget' as const, source: 'Cournot' as const };
  if (order.side === 'sell') {
    const after = Math.max(0, gross - Math.min(order.notionalUsd, positionValue(ctx.account, ctx.snapshot, order.symbol)));
    return {
      ...base,
      pass: true,
      detail: `Sell lowers gross exposure from ${usd(gross)} to ${usd(after)} against a ${usd(budget)} budget (multiplier ${ctx.eventMultiplier.toFixed(2)}).`,
    };
  }
  const after = gross + order.notionalUsd;
  const ok = after <= budget + 1e-6;
  return {
    ...base,
    pass: ok,
    detail: ok
      ? `Gross exposure after the order is ${usd(after)}, within the ${usd(budget)} budget (equity ${usd(equity)} x ${ctx.config.baseRiskBudgetPct}% x multiplier ${ctx.eventMultiplier.toFixed(2)}).`
      : `Gross exposure after the order would be ${usd(after)}, above the ${usd(budget)} budget (equity ${usd(equity)} x ${ctx.config.baseRiskBudgetPct}% x multiplier ${ctx.eventMultiplier.toFixed(2)}).`,
  };
}

export function checkExposure(order: Order, ctx: RiskContext): RiskCheck {
  const base = { name: 'exposure' as const, source: 'Desk' as const };
  if (order.side === 'buy') {
    const ok = order.notionalUsd <= ctx.account.cashUsd + 1e-6;
    return {
      ...base,
      pass: ok,
      detail: ok
        ? `Buy of ${usd(order.notionalUsd)} is covered by ${usd(ctx.account.cashUsd)} cash (spot only, no leverage).`
        : `Buy of ${usd(order.notionalUsd)} exceeds ${usd(ctx.account.cashUsd)} cash (spot only, no leverage).`,
    };
  }
  const held = positionValue(ctx.account, ctx.snapshot, order.symbol);
  // Allow a tiny tolerance so "sell everything" orders pass despite float rounding.
  const ok = held > 0 && order.notionalUsd <= held * 1.001 + 0.01;
  return {
    ...base,
    pass: ok,
    detail: ok
      ? `Sell of ${usd(order.notionalUsd)} is covered by the ${usd(held)} ${order.symbol} position (no shorts).`
      : `Sell of ${usd(order.notionalUsd)} exceeds the ${usd(held)} ${order.symbol} position (no shorts).`,
  };
}

export function checkConcentration(order: Order, ctx: RiskContext): RiskCheck {
  const base = { name: 'concentration' as const, source: 'Desk' as const };
  const equity = ctx.account.equityUsd;
  const cur = positionValue(ctx.account, ctx.snapshot, order.symbol);
  const after = order.side === 'buy' ? cur + order.notionalUsd : Math.max(0, cur - order.notionalUsd);
  const share = equity > 0 ? (after / equity) * 100 : Infinity;
  const ok = order.side === 'sell' || share <= ctx.config.maxConcentrationPct + 1e-9;
  return {
    ...base,
    pass: ok,
    detail: ok
      ? `${order.symbol} would be ${pct(share)} of ${usd(equity)} equity, within the ${ctx.config.maxConcentrationPct}% limit.`
      : `${order.symbol} would be ${pct(share)} of ${usd(equity)} equity, above the ${ctx.config.maxConcentrationPct}% limit.`,
  };
}

/** Runs all six checks. The order is approved only if every check passes. */
export function evaluateOrder(order: Order, ctx: RiskContext): RiskDecision {
  const checks: RiskCheck[] = [
    checkAgentStatus(order, ctx),
    checkLiquidity(order, ctx),
    checkPriceAgreement(order, ctx),
    checkEventBudget(order, ctx),
    checkExposure(order, ctx),
    checkConcentration(order, ctx),
  ];
  return { orderId: order.id, approved: checks.every((c) => c.pass), checks };
}

export interface Breach {
  kind: 'daily-loss' | 'max-drawdown';
  reason: string;
}

/** Returns the first breach found (daily loss, then max drawdown), or null. */
export function checkBreach(
  account: AgentAccount,
  config: Pick<DeskConfig, 'dailyLossLimitPct' | 'maxDrawdownPct'>,
): Breach | null {
  if (account.dailyLossPct >= config.dailyLossLimitPct) {
    return {
      kind: 'daily-loss',
      reason: `Daily loss of ${pct(account.dailyLossPct, 2)} (${usd(account.dayStartEquityUsd - account.equityUsd)}) breached the ${config.dailyLossLimitPct}% limit.`,
    };
  }
  if (account.drawdownPct >= config.maxDrawdownPct) {
    return {
      kind: 'max-drawdown',
      reason: `Drawdown of ${pct(account.drawdownPct, 2)} from the ${usd(account.peakEquityUsd)} peak breached the ${config.maxDrawdownPct}% limit.`,
    };
  }
  return null;
}
