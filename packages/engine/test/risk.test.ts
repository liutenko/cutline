import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBreach, eventMultiplier, evaluateOrder } from '../src/risk.ts';
import { account, config, ev, instruments, order, snap } from './fixtures.ts';

const ctx = (o: Partial<Parameters<typeof evaluateOrder>[1]> = {}) => ({
  account: account(), snapshot: snap(), instruments, config, eventMultiplier: 1, ...o,
});
const check = (d: ReturnType<typeof evaluateOrder>, name: string) => d.checks.find((c) => c.name === name)!;

test('a normal buy passes all six checks with numbers in each detail', () => {
  const d = evaluateOrder(order(), ctx());
  assert.equal(d.approved, true);
  assert.equal(d.checks.length, 6);
  for (const c of d.checks) assert.ok(c.detail.length > 10 && /\d/.test(c.detail) || c.name === 'agent-status', c.detail);
});

test('agent-status fails for a cut agent', () => {
  const d = evaluateOrder(order(), ctx({ account: account({ status: 'cut', cutReason: 'drawdown' }) }));
  assert.equal(d.approved, false);
  assert.equal(check(d, 'agent-status').pass, false);
});

test('liquidity caps order notional at 2% of DEX liquidity', () => {
  const d = evaluateOrder(order({ symbol: 'THIN', notionalUsd: 3001 }), ctx());
  const c = check(d, 'liquidity');
  assert.equal(c.pass, false);
  assert.match(c.detail, /\$3,001 exceeds the \$3,000 cap \(2% of \$150,000/);
  assert.equal(check(evaluateOrder(order({ symbol: 'THIN', notionalUsd: 3000 }), ctx()), 'liquidity').pass, true);
});

test('price-agreement: both passes, single passes only for major/rwa and says "single source", disagree fails', () => {
  assert.equal(check(evaluateOrder(order(), ctx()), 'price-agreement').pass, true);
  const rwa = check(evaluateOrder(order({ symbol: 'PAXG', notionalUsd: 1000 }), ctx()), 'price-agreement');
  assert.equal(rwa.pass, true);
  assert.match(rwa.detail, /single source/i);
  const thin = check(evaluateOrder(order({ symbol: 'THIN', notionalUsd: 100 }), ctx()), 'price-agreement');
  assert.equal(thin.pass, false);
  assert.match(thin.detail, /single source/i);
  assert.match(rwa.detail, /^Single source: no Atlas feed for PAXG/);
  const st = snap();
  st.marks.BNB = { ...st.marks.BNB, agreement: 'single', atlasStale: true, atlasTs: 1000 - 12 * 60000 };
  const stale = check(evaluateOrder(order(), ctx({ snapshot: { ...st, ts: 1000 } })), 'price-agreement');
  assert.equal(stale.pass, true);
  assert.match(stale.detail, /^Single source: the Atlas price is 12 minutes old/);
  const s = snap();
  s.marks.BNB = { ...s.marks.BNB, agreement: 'disagree', deviationBps: 80 };
  const dis = check(evaluateOrder(order(), ctx({ snapshot: s })), 'price-agreement');
  assert.equal(dis.pass, false);
  assert.match(dis.detail, /80\.0 bps/);
});

test('event-budget: gross exposure after the order vs equity x base% x multiplier', () => {
  const a = account({ cashUsd: 15000, positions: [{ symbol: 'BNB', qty: 10, avgPrice: 900 }] }); // 9000 exposure, equity 24000
  a.equityUsd = 24000;
  const ok = check(evaluateOrder(order({ notionalUsd: 3000 }), ctx({ account: a, eventMultiplier: 0.5 })), 'event-budget');
  assert.equal(ok.pass, true); // 12000 <= 12000
  const bad = check(evaluateOrder(order({ notionalUsd: 3001 }), ctx({ account: a, eventMultiplier: 0.5 })), 'event-budget');
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /\$12,001.*\$12,000 budget.*0\.50/);
  const sell = check(evaluateOrder(order({ side: 'sell', notionalUsd: 3000 }), ctx({ account: a, eventMultiplier: 0.25 })), 'event-budget');
  assert.equal(sell.pass, true);
});

test('exposure: buys limited by cash, sells limited by holdings', () => {
  const a = account({ cashUsd: 1000 });
  assert.equal(check(evaluateOrder(order({ notionalUsd: 1001 }), ctx({ account: a })), 'exposure').pass, false);
  assert.equal(check(evaluateOrder(order({ side: 'sell', notionalUsd: 10 }), ctx()), 'exposure').pass, false);
  const h = account({ positions: [{ symbol: 'BNB', qty: 2, avgPrice: 900 }] });
  assert.equal(check(evaluateOrder(order({ side: 'sell', notionalUsd: 1800 }), ctx({ account: h })), 'exposure').pass, true);
});

test('concentration: one symbol <= 40% of equity after the order', () => {
  assert.equal(check(evaluateOrder(order({ notionalUsd: 10000 }), ctx()), 'concentration').pass, true);
  const c = check(evaluateOrder(order({ notionalUsd: 10001 }), ctx()), 'concentration');
  assert.equal(c.pass, false);
  assert.match(c.detail, /40\.0% of \$25,000/);
});

test('eventMultiplier follows the spec formula', () => {
  assert.equal(eventMultiplier([], config).multiplier, 1);
  // adverse p=0.3 -> 0.7
  assert.equal(eventMultiplier([ev({ cournotProbability: 0.3 })], config).multiplier, 0.7);
  // favorable claims never reduce the budget, however unlikely they are
  assert.equal(eventMultiplier([ev({ polarity: 'favorable', cournotProbability: 0.2 })], config).multiplier, 1);
  assert.match(eventMultiplier([ev({ polarity: 'favorable', cournotProbability: 0.027 })], config).reason, /No adverse Cournot claim/);
  // highest adverse prob wins; favorable rows are ignored either way
  const r = eventMultiplier([ev({ cournotProbability: 0.4, claim: 'Rates up' }), ev({ polarity: 'favorable', cournotProbability: 0.01 })], config);
  assert.equal(r.multiplier, 0.6);
  assert.match(r.reason, /adverse claim "Rates up" at 40\.0%/);
  // divergence penalty: 0.7 * 0.8 = 0.56
  const d = eventMultiplier([ev({ cournotProbability: 0.3, divergence: -0.12 })], config);
  assert.equal(d.multiplier, 0.56);
  assert.match(d.reason, /0\.8 penalty/);
  // ranking rows never move the multiplier
  assert.equal(eventMultiplier([ev({ cournotProbability: 0.3 }), ev({ origin: 'ranking', cournotProbability: 0.9, divergence: 0.3 })], config).multiplier, 0.7);
  assert.equal(eventMultiplier([ev({ origin: 'ranking', cournotProbability: 0.9 })], config).multiplier, 1);
  // penalty never pushes below the floor
  assert.equal(eventMultiplier([ev({ cournotProbability: 0.9, divergence: 0.2 })], config).multiplier, 0.25);
});

test('checkBreach: daily loss and max drawdown', () => {
  assert.equal(checkBreach(account(), config), null);
  const dl = checkBreach(account({ equityUsd: 24200, dailyLossPct: 3.2 }), config);
  assert.equal(dl?.kind, 'daily-loss');
  assert.match(dl!.reason, /3\.20%.*3% limit/);
  const dd = checkBreach(account({ peakEquityUsd: 27000, equityUsd: 25300, drawdownPct: 6.3, dailyLossPct: 0 }), config);
  assert.equal(dd?.kind, 'max-drawdown');
  assert.match(dd!.reason, /6\.30% from the \$27,000 peak/);
});

test('eventMultiplier with the three live Cournot assessments of 26 Nov is 0.51, set by the $55,000 claim', () => {
  const live = [
    ev({ claim: 'Bitcoin below $55,000', polarity: 'adverse', cournotProbability: 0.487, divergence: 0 }),
    ev({ claim: 'Bitcoin below $50,000', polarity: 'adverse', cournotProbability: 0.279, divergence: 0 }),
    ev({ claim: 'Ethereum above $3,000', polarity: 'favorable', cournotProbability: 0.027, divergence: 0 }),
  ];
  const r = eventMultiplier(live, config);
  assert.equal(r.multiplier, 0.51);
  assert.equal(r.driver?.claim, 'Bitcoin below $55,000');
  assert.equal(r.adverseProb, 0.487);
  assert.match(r.reason, /adverse claim "Bitcoin below \$55,000" at 48\.7%, so every risk budget is scaled to 51%/);
  assert.doesNotMatch(r.reason, /97/);
});
