import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeAllPositions, fillOrder as fillWithCosts, markAccount } from '../src/broker.ts';
import type { AgentAccount, MarketSnapshot, Order } from '../../../shared/src/types.ts';

// Exact-number tests run without costs (fee 0, no liquidity so impact is 0); costs are tested separately.
const noLiq = (s: MarketSnapshot): MarketSnapshot => ({ ...s, liquidity: {} });
const fillOrder = (a: AgentAccount, o: Order, s: MarketSnapshot) => fillWithCosts(a, o, noLiq(s), 0);
import { account, config, order, snap } from './fixtures.ts';

test('buys update cash, qty and average price; sells reduce qty and keep avg', () => {
  const a = account();
  const s = snap();
  const f1 = fillOrder(a, order({ notionalUsd: 9000 }), s)!;
  assert.equal(f1.qty, 10);
  assert.equal(a.cashUsd, 16000);
  s.marks.BNB = { ...s.marks.BNB, cmcPrice: 1000 };
  fillOrder(a, order({ id: 'o2', notionalUsd: 10000 }), s);
  assert.equal(a.positions[0].qty, 20);
  assert.equal(a.positions[0].avgPrice, 950);
  const f3 = fillOrder(a, order({ id: 'o3', side: 'sell', notionalUsd: 5000 }), s)!;
  assert.equal(f3.qty, 5);
  assert.equal(a.positions[0].qty, 15);
  assert.equal(a.positions[0].avgPrice, 950);
  assert.equal(a.cashUsd, 11000);
  // sell slightly more than held closes fully
  fillOrder(a, order({ id: 'o4', side: 'sell', notionalUsd: 15010 }), s);
  assert.equal(a.positions.length, 0);
  assert.equal(a.cashUsd, 26000);
});

test('markAccount computes equity, peak, pnl, drawdown and daily loss', () => {
  const a = account();
  const s = snap();
  fillOrder(a, order({ notionalUsd: 9000 }), s);
  s.marks.BNB = { ...s.marks.BNB, cmcPrice: 1000 };
  markAccount(a, s, config, 1);
  assert.equal(a.equityUsd, 26000);
  assert.equal(a.peakEquityUsd, 26000);
  assert.equal(a.pnlUsd, 1000);
  assert.equal(a.pnlPct, 4);
  s.marks.BNB = { ...s.marks.BNB, cmcPrice: 740 };
  markAccount(a, s, config, 0.5);
  assert.equal(a.equityUsd, 23400);
  assert.equal(a.peakEquityUsd, 26000);
  assert.equal(Number(a.drawdownPct.toFixed(4)), 10);
  assert.equal(Number(a.dailyLossPct.toFixed(4)), 6.4);
  assert.equal(a.riskBudgetUsd, 11700);
});

test('closeAllPositions liquidates at mark', () => {
  const a = account();
  const s = snap();
  fillOrder(a, order({ notionalUsd: 9000 }), s);
  s.marks.BNB = { ...s.marks.BNB, cmcPrice: 800 };
  const fills = closeAllPositions(a, noLiq(s), 'cut', 0);
  assert.equal(fills.length, 1);
  assert.equal(a.positions.length, 0);
  assert.equal(a.cashUsd, 24000);
});

test('fills pay impact (2 x notional / liquidity) and the pool fee, on both sides and on forced closes', () => {
  const a = account();
  const s = snap(); // BNB mid 900, liquidity 40,000,000
  const f = fillWithCosts(a, order({ notionalUsd: 10000 }), s, 0.25)!;
  assert.equal(f.midPrice, 900);
  assert.ok(Math.abs(f.slippagePct! - 0.05) < 1e-9); // 2 x 10,000 / 40,000,000 = 0.05%
  assert.equal(f.feePct, 0.25);
  assert.ok(Math.abs(f.price - 900 * 1.003) < 1e-9);
  assert.ok(Math.abs(f.qty - 10000 / (900 * 1.003)) < 1e-9);
  assert.equal(a.cashUsd, 15000);
  const sell = fillWithCosts(a, order({ id: 'o2', side: 'sell', notionalUsd: 900 }), s, 0.25)!;
  assert.equal(sell.qty, 1);
  assert.ok(Math.abs(sell.slippagePct! - 0.0045) < 1e-9);
  assert.ok(Math.abs(sell.price - 900 * (1 - 0.000045 - 0.0025)) < 1e-9);
  // Thin pool: forced close pays large impact but never a non-positive price.
  const t = account({ positions: [{ symbol: 'THIN', qty: 100000, avgPrice: 0.04 }] });
  const [c] = closeAllPositions(t, s, 'cut', 0.25);
  assert.ok(c.price > 0 && c.price < 0.04);
  assert.ok(Math.abs(c.slippagePct! - (2 * 4000 / 150000) * 100) < 1e-9);
});

import { scalePrice } from '../src/money.ts';
import { parseFeeds } from '../src/wiring.ts';
test('scalePrice scales to 18 decimals exactly; parseFeeds tolerates bad input', () => {
  assert.equal(scalePrice(556.2314), 556231400000000000000n);
  assert.equal(scalePrice(60555.0254), 60555025400000000000000n);
  assert.equal(scalePrice(0), 0n);
  const warns: string[] = [];
  assert.deepEqual(parseFeeds('not json', (m) => warns.push(m)), {});
  assert.deepEqual(parseFeeds('', () => {}), {});
  assert.deepEqual(parseFeeds('{"BNB":"0x' + 'a'.repeat(40) + '","X":"nope"}', (m) => warns.push(m)), { BNB: '0x' + 'a'.repeat(40) });
  assert.equal(warns.length, 2);
});
