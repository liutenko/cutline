// Paper broker: fills approved orders at the CoinMarketCap mark. Spot only.
import type { AgentAccount, DeskConfig, Fill, MarketSnapshot, Order } from '../../../shared/src/types.ts';

const DUST_USD = 0.01;
export const DEFAULT_POOL_FEE_PCT = 0.25;

export function newAccount(
  base: Pick<AgentAccount, 'agentId' | 'name' | 'strategy' | 'address'>,
  config: DeskConfig,
): AgentAccount {
  const e = config.paperAccountUsd;
  return {
    ...base,
    status: 'evaluating',
    startEquityUsd: e,
    cashUsd: e,
    positions: [],
    equityUsd: e,
    peakEquityUsd: e,
    dayStartEquityUsd: e,
    pnlUsd: 0,
    pnlPct: 0,
    drawdownPct: 0,
    dailyLossPct: 0,
    riskBudgetUsd: (e * config.baseRiskBudgetPct) / 100,
    realAllocation: '0',
    equityHistory: [e],
  };
}

/** Estimated execution costs: impact = 2 x notional / DEX liquidity, plus the pool fee. Returned as fractions. */
export function costs(snapshot: MarketSnapshot, symbol: string, notionalUsd: number, feePct: number): { impact: number; fee: number } {
  const liq = snapshot.liquidity[symbol]?.dexLiquidityUsd ?? 0;
  const impact = liq > 0 ? (2 * notionalUsd) / liq : 0;
  const fee = feePct / 100;
  // Never let costs take a fill to zero or below (forced closes in very thin pools).
  const total = Math.min(impact + fee, 0.9);
  return { impact: total - fee > 0 ? total - fee : 0, fee: Math.min(fee, total) };
}

/** Fills an approved order: buys at mid x (1 + impact + fee), sells at mid x (1 - impact - fee). Mutates the account. */
export function fillOrder(account: AgentAccount, order: Order, snapshot: MarketSnapshot, feePct = DEFAULT_POOL_FEE_PCT): Fill | null {
  const mark = snapshot.marks[order.symbol];
  if (!mark || !(mark.cmcPrice > 0)) return null;
  const mid = mark.cmcPrice;
  let qty: number;
  let price: number;
  let c: { impact: number; fee: number };
  if (order.side === 'buy') {
    const notional = Math.min(order.notionalUsd, account.cashUsd);
    if (notional <= DUST_USD) return null;
    c = costs(snapshot, order.symbol, notional, feePct);
    price = mid * (1 + c.impact + c.fee);
    qty = notional / price;
    const pos = account.positions.find((p) => p.symbol === order.symbol);
    if (pos) {
      pos.avgPrice = (pos.avgPrice * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
    } else {
      account.positions.push({ symbol: order.symbol, qty, avgPrice: price });
    }
    account.cashUsd -= notional;
  } else {
    const pos = account.positions.find((p) => p.symbol === order.symbol);
    if (!pos || pos.qty <= 0) return null;
    qty = Math.min(order.notionalUsd / mid, pos.qty);
    // Treat a sell within 0.1% of the full position as a full close (no dust left behind).
    if (qty >= pos.qty * 0.999) qty = pos.qty;
    c = costs(snapshot, order.symbol, qty * mid, feePct);
    price = mid * (1 - c.impact - c.fee);
    pos.qty -= qty;
    account.cashUsd += qty * price;
    if (pos.qty * mid <= DUST_USD || pos.qty <= 0) {
      account.positions = account.positions.filter((p) => p !== pos);
    }
  }
  return {
    orderId: order.id,
    agentId: order.agentId,
    symbol: order.symbol,
    side: order.side,
    qty,
    price,
    notionalUsd: qty * price,
    midPrice: mid,
    slippagePct: c.impact * 100,
    feePct: c.fee * 100,
    ts: snapshot.ts,
  };
}

/** Re-marks the account: equity, peak, pnl, drawdown, daily loss, risk budget. */
export function markAccount(
  account: AgentAccount,
  snapshot: MarketSnapshot,
  config: DeskConfig,
  eventMultiplier: number,
): void {
  let value = 0;
  for (const p of account.positions) {
    const px = snapshot.marks[p.symbol]?.cmcPrice ?? p.avgPrice;
    value += p.qty * px;
  }
  const equity = account.cashUsd + value;
  account.equityUsd = equity;
  account.peakEquityUsd = Math.max(account.peakEquityUsd, equity);
  account.pnlUsd = equity - account.startEquityUsd;
  account.pnlPct = (account.pnlUsd / account.startEquityUsd) * 100;
  account.drawdownPct = account.peakEquityUsd > 0 ? Math.max(0, ((account.peakEquityUsd - equity) / account.peakEquityUsd) * 100) : 0;
  account.dailyLossPct = Math.max(0, ((account.dayStartEquityUsd - equity) / account.dayStartEquityUsd) * 100);
  account.riskBudgetUsd = (equity * config.baseRiskBudgetPct * eventMultiplier) / 100;
}

/** Closes every position at the mark (forced, bypasses the risk manager), paying the same costs. Returns the fills. */
export function closeAllPositions(account: AgentAccount, snapshot: MarketSnapshot, reasonTag: string, feePct = DEFAULT_POOL_FEE_PCT): Fill[] {
  const fills: Fill[] = [];
  for (const p of [...account.positions]) {
    const mid = snapshot.marks[p.symbol]?.cmcPrice ?? p.avgPrice;
    const qty = p.qty;
    const c = costs(snapshot, p.symbol, qty * mid, feePct);
    const price = mid * (1 - c.impact - c.fee);
    account.cashUsd += qty * price;
    fills.push({
      orderId: `${account.agentId}-${reasonTag}-${p.symbol}`,
      agentId: account.agentId,
      symbol: p.symbol,
      side: 'sell',
      qty,
      price,
      notionalUsd: qty * price,
      midPrice: mid,
      slippagePct: c.impact * 100,
      feePct: c.fee * 100,
      ts: snapshot.ts,
    });
  }
  account.positions = [];
  return fills;
}

export const EQUITY_HISTORY_CAP = 240;

/** Appends the current paper equity to equityHistory (oldest first, capped). Call once per tick. */
export function sampleEquity(account: AgentAccount): void {
  const h = (account.equityHistory ??= []);
  h.push(Math.round(account.equityUsd * 100) / 100);
  if (h.length > EQUITY_HISTORY_CAP) h.splice(0, h.length - EQUITY_HISTORY_CAP);
}
