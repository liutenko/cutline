import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBrain, MomentumBrain, RwaBrain, eventRegime } from '../src/agents/RuleBrain.ts';
import Anthropic from '@anthropic-ai/sdk';
import { LlmBrain, LlmGate, type LlmClient } from '../src/agents/LlmBrain.ts';
import type { BrainContext } from '../src/agents/types.ts';
import { evaluateOrder } from '../src/risk.ts';
import { account, config, ev, instruments, mirrored, REAL_EVENTS, snap } from './fixtures.ts';

const ctx = (o: Partial<BrainContext> = {}): BrainContext => ({
  tick: 1, snapshot: snap(), account: account(), instruments, config, eventMultiplier: 1, rogue: false, ...o,
});
const passes = (c: BrainContext, o: ReturnType<typeof evaluateOrder> extends never ? never : Parameters<typeof evaluateOrder>[0]) =>
  evaluateOrder(o, { account: c.account, snapshot: c.snapshot, instruments: c.instruments, config: c.config, eventMultiplier: c.eventMultiplier }).approved;

test('momentum buys the strongest major in one tranche that passes risk, then exits on reversal', async () => {
  const b = new MomentumBrain();
  const c = ctx();
  const [o] = await b.propose(c);
  assert.equal(o.symbol, 'BNB');
  assert.equal(o.side, 'buy');
  assert.equal(o.notionalUsd, 3000);
  assert.match(o.rationale, /\+0\.50% over 1h and \+2\.00% over 24h/);
  assert.equal(o.brain, 'rule');
  assert.ok(passes(c, o));
  const s = snap();
  s.marks.BNB = { ...s.marks.BNB, pctChange1h: -0.4 };
  const held = ctx({ tick: 5, snapshot: s, account: account({ cashUsd: 16000, positions: [{ symbol: 'BNB', qty: 10, avgPrice: 900 }] }) });
  const [x] = await b.propose(held);
  assert.equal(x.side, 'sell');
  assert.match(x.rationale, /reversed \(1h -0\.40%/);
});

test('rwa rotates into RWA when fear is high and back to cash when risk is on', async () => {
  const b = new RwaBrain();
  const [o] = await b.propose(ctx({ snapshot: snap({ fearGreed: 30 }) }));
  assert.equal(o.symbol, 'PAXG');
  assert.equal(o.side, 'buy');
  assert.match(o.rationale, /Fear and greed is 30/);
  const s = snap({ fearGreed: 70 });
  const [x] = await b.propose(ctx({ tick: 9, snapshot: s, account: account({ cashUsd: 22000, positions: [{ symbol: 'PAXG', qty: 3000 / 2650, avgPrice: 2650 }] }) }));
  assert.equal(x.side, 'sell');
  assert.equal(x.symbol, 'PAXG');
});

test('agents trim to the event budget when it shrinks', async () => {
  const b = new MomentumBrain();
  const a = account({ cashUsd: 16000, positions: [{ symbol: 'BNB', qty: 10, avgPrice: 900 }] });
  const [o] = await b.propose(ctx({ account: a, eventMultiplier: 0.25 }));
  assert.equal(o.side, 'sell');
  assert.match(o.rationale, /multiplier is 0\.25/);
  assert.ok(o.notionalUsd >= 9000 - 6250);
});

test('rogue mode sends growing oversized orders in the thin instrument', async () => {
  const b = new EventBrain();
  const c1 = await b.propose(ctx({ rogue: true }));
  const c2 = await b.propose(ctx({ rogue: true, tick: 2 }));
  assert.equal(c1[0].symbol, 'THIN');
  assert.ok(c2[0].notionalUsd > c1[0].notionalUsd);
  const d = evaluateOrder(c1[0], { account: account(), snapshot: snap(), instruments, config, eventMultiplier: 1 });
  assert.equal(d.checks.find((x) => x.name === 'liquidity')!.pass, false);
});

const fakeClient = (reply: () => Promise<unknown>): LlmClient => ({ messages: { create: (() => reply()) as never } });
const answer = (text: string) => async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 }, content: [{ type: 'text', text }] });

/** A context where momentum has two distinct candidates (BNB and ETH both trending). */
function twoChoices(over: Partial<BrainContext> = {}): BrainContext {
  const s = snap();
  s.marks.ETH = { symbol: 'ETH', cmcPrice: 3500, cmcTs: 1000, agreement: 'both', pctChange1h: 0.3, pctChange24h: 1 };
  s.liquidity.ETH = { symbol: 'ETH', dexLiquidityUsd: 2e7, dexVolume24hUsd: 1, source: 't', ts: 1 };
  return ctx({ snapshot: s, instruments: [...instruments, { symbol: 'ETH', name: 'Ethereum', cmcId: 1027, kind: 'major' }], ...over });
}

test('LlmBrain uses the chosen candidate and its rationale, and can do nothing', async () => {
  const pick = new LlmBrain(new MomentumBrain(), { client: fakeClient(answer('{"choice":2,"rationale":"ETH is up 0.3% in 1h, so I add $3,000."}')) });
  const [o] = await pick.propose(twoChoices());
  assert.equal(o.symbol, 'ETH');
  assert.equal(o.rationale, 'ETH is up 0.3% in 1h, so I add $3,000.');
  assert.equal(o.brain, 'llm');
  assert.equal(pick.gate.inputTokens, 300);
  const none = new LlmBrain(new MomentumBrain(), { client: fakeClient(answer('{"choice":0,"rationale":"Waiting for 2 more ticks."}')) });
  assert.deepEqual(await none.propose(twoChoices()), []);
});

test('LlmBrain falls back to rules on error, bad output, cut-off answers and timeout', async () => {
  const warns: string[] = [];
  const err = new LlmBrain(new MomentumBrain(), { client: fakeClient(async () => { throw new Error('boom'); }), warn: (m) => warns.push(m) });
  assert.equal((await err.propose(twoChoices()))[0].brain, 'rule');
  assert.match(warns[0], /boom/);
  const bad = new LlmBrain(new MomentumBrain(), { client: fakeClient(answer('{"choice":9,"rationale":"x"}')) });
  assert.equal((await bad.propose(twoChoices()))[0].symbol, 'BNB');
  const cut = new LlmBrain(new MomentumBrain(), { client: fakeClient(async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"choice":1,' }] })) });
  assert.equal((await cut.propose(twoChoices()))[0].brain, 'rule');
  const slow = new LlmBrain(new MomentumBrain(), { client: fakeClient(() => new Promise(() => {})), timeoutMs: 50 });
  const t0 = Date.now();
  const [o] = await slow.propose(twoChoices());
  assert.equal(o.symbol, 'BNB');
  assert.ok(Date.now() - t0 < 1000);
});

test('LlmGate: no call with one candidate, throttled per agent, hard cap with one notice', async () => {
  let calls = 0;
  const client = fakeClient(async () => { calls++; return answer('{"choice":1,"rationale":"BNB leads at 0.5% in 1h."}')(); });
  const notices: string[] = [];
  const gate = new LlmGate(2, 3, (m) => notices.push(m));
  // One candidate only: straight through the rules.
  const single = new LlmBrain(new MomentumBrain(), { client, gate });
  assert.equal((await single.propose(ctx()))[0].brain, 'rule');
  assert.equal(calls, 0);
  const b = new LlmBrain(new MomentumBrain(), { client, gate });
  await b.propose(twoChoices({ tick: 1 }));
  await b.propose(twoChoices({ tick: 2 })); // throttled: within 3 ticks
  assert.equal(calls, 1);
  // Later, with both symbols off cooldown again, the second call uses up the cap.
  await b.propose(twoChoices({ tick: 10 }));
  assert.equal(calls, 2);
  assert.equal(gate.active, false);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /cap of 2 reached/);
  await b.propose(twoChoices({ tick: 20 }));
  assert.equal(calls, 2);
  assert.deepEqual(gate.stats(), { calls: 2, cap: 2, active: false });
});

test('LlmGate: a billing error turns the layer off with one notice', async () => {
  let calls = 0;
  const notices: string[] = [];
  const gate = new LlmGate(5, 1, (m) => notices.push(m));
  const billing = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'Your credit balance is too low', new Headers());
  const b = new LlmBrain(new MomentumBrain(), { client: fakeClient(async () => { calls++; throw billing; }), gate });
  assert.equal((await b.propose(twoChoices({ tick: 1 })))[0].brain, 'rule');
  await b.propose(twoChoices({ tick: 50 }));
  assert.equal(calls, 1);
  assert.equal(gate.stats().active, false);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /turned off/);
});

test('maintenance: take profit on a third after a band move, then re-enter after the cooldown', async () => {
  const b = new RwaBrain({ rwaBandPct: 0.6, reentryTicks: 3 });
  const fear = (price: number) => {
    const s = snap({ fearGreed: 30 });
    s.marks.PAXG = { ...s.marks.PAXG, cmcPrice: price };
    return s;
  };
  // Holding 3 PAXG bought at 2650; price up 0.8%.
  const a = account({ cashUsd: 25000 - 3 * 2650, positions: [{ symbol: 'PAXG', qty: 3, avgPrice: 2650 }] });
  a.equityUsd = a.cashUsd + 3 * 2671.2;
  const [tp] = await b.propose(ctx({ tick: 10, snapshot: fear(2671.2), account: a }));
  assert.equal(tp.side, 'sell');
  assert.ok(Math.abs(tp.notionalUsd - 2671.2) < 1);
  assert.match(tp.rationale, /\+0\.80% above my last reference price of 2,650\.00, past my 0\.6% band/);
  // Simulate the fill.
  a.positions[0].qty = 2;
  a.cashUsd += 2671.2;
  // Within the re-entry wait: no buy of PAXG.
  const during = await b.propose(ctx({ tick: 11, snapshot: fear(2671.2), account: a }));
  assert.ok(!during.some((o) => o.symbol === 'PAXG' && o.side === 'buy'));
  // After it: the signal is still on, so it buys back toward target.
  const after = await b.propose(ctx({ tick: 13, snapshot: fear(2671.2), account: a }));
  assert.ok(after.some((o) => o.side === 'buy'), JSON.stringify(after));
});

test('maintenance: rebalance back to the target weight when a position drifts above it', async () => {
  const b = new EventBrain({ rebalancePp: 2 });
  const s = snap({ eventRisk: [ev({ polarity: 'favorable', cournotProbability: 0.7, venuePrice: 0.6, divergence: 0.1 })] });
  // 11 BNB at 900 = 9,900 of 25,000 = 39.6% (> 36 + 2).
  const a = account({ cashUsd: 15100, positions: [{ symbol: 'BNB', qty: 11, avgPrice: 900 }] });
  const [o] = await b.propose(ctx({ snapshot: s, account: a }));
  assert.equal(o.side, 'sell');
  assert.equal(o.notionalUsd, 900);
  assert.match(o.rationale, /drifted to 39\.6% of equity, more than 2 points over my 36% target/);
});

test('event regimes on the real Cournot rows', () => {
  const real = eventRegime(REAL_EVENTS);
  assert.equal(real.regime, 'range');
  assert.ok(Math.abs(real.upGap - -0.0552457) < 1e-6);
  assert.ok(Math.abs(real.downGap - -0.0355795) < 1e-6);
  assert.equal(real.top!.claim, 'Will Bitcoin exceed $85,000 before Jan 1, 2027?');
  assert.equal(real.count, 5); // the assessment's zero gap is ignored
  assert.equal(eventRegime(mirrored('favorable')).regime, 'trend');
  assert.equal(eventRegime(mirrored('adverse')).regime, 'risk-off');
  assert.equal(eventRegime(REAL_EVENTS.filter((e) => e.polarity === 'favorable')).regime, 'neutral'); // no downside rows
  assert.equal(eventRegime([]).regime, 'neutral');
});

test('event agent in range: starter tranche, then mean reversion around the reference price', async () => {
  const b = new EventBrain({ bandPct: 1.2 });
  const notes: string[] = [];
  const at = (price: number) => {
    const s = snap({ eventRisk: REAL_EVENTS });
    s.marks.BNB = { ...s.marks.BNB, cmcPrice: price };
    return s;
  };
  const [o] = await b.propose(ctx({ snapshot: at(900), note: (m) => notes.push(m) }));
  assert.equal(o.side, 'buy');
  assert.equal(o.rationale, 'Regime range: Cournot rates upside claims -5.5 points and downside claims -3.6 points against the venues; the largest gap is "Will Bitcoin exceed $85,000 before Jan 1, 2027?", where Cournot says 0.6% against a venue price of 7.0%, so I open a starter position with $3,000 of BNB.');
  assert.match(notes[0], /^Event Trader regime is now range\./);
  const a = account({ cashUsd: 22000, positions: [{ symbol: 'BNB', qty: 3000 / 900, avgPrice: 900 }] });
  // Small move: hold, no new regime note.
  assert.deepEqual(await b.propose(ctx({ tick: 5, snapshot: at(905), account: a, note: (m) => notes.push(m) })), []);
  assert.equal(notes.length, 1);
  // 1.3% below the 900 reference: buy a tranche.
  const [buy] = await b.propose(ctx({ tick: 10, snapshot: at(888.3), account: a }));
  assert.equal(buy.side, 'buy');
  assert.match(buy.rationale, /BNB is -1\.30% below my 900\.00 reference price, past my 1\.2% band, and I buy \$3,000 of BNB\.$/);
  // 1.3% above the average entry: sell a tranche.
  const [sell] = await b.propose(ctx({ tick: 20, snapshot: at(911.7), account: a }));
  assert.equal(sell.side, 'sell');
  assert.match(sell.rationale, /BNB is \+1\.30% above my 900\.00 average entry/);
});

test('event agent: trend adds, risk-off trims, neutral holds', async () => {
  const s = (ev: typeof REAL_EVENTS) => snap({ eventRisk: ev });
  const [t] = await new EventBrain().propose(ctx({ snapshot: s(mirrored('favorable')) }));
  assert.equal(t.side, 'buy');
  assert.match(t.rationale, /^Regime trend: Cournot rates upside claims \+5\.5 points/);
  const held = account({ cashUsd: 16000, positions: [{ symbol: 'BNB', qty: 10, avgPrice: 900 }] });
  const [r] = await new EventBrain().propose(ctx({ snapshot: s(mirrored('adverse')), account: held }));
  assert.equal(r.side, 'sell');
  assert.equal(r.notionalUsd, 3000);
  assert.match(r.rationale, /^Regime risk-off: .*downside claims \+3\.6 points.*so I trim \$3,000 of BNB\.$/);
  assert.deepEqual(await new EventBrain().propose(ctx({ snapshot: s(REAL_EVENTS.filter((e) => e.polarity === 'favorable')) })), []);
});

test('rwa prefers gold over tokenized stock in risk-off', async () => {
  const insts = [...instruments, { symbol: 'TSLAB', name: 'Tesla Tokenized bStocks (tokenized stock)', cmcId: 2, kind: 'rwa' as const }];
  const s = snap({ fearGreed: 10 });
  s.marks.TSLAB = { symbol: 'TSLAB', cmcPrice: 400, cmcTs: 1000, agreement: 'both', pctChange24h: 5 };
  s.liquidity.TSLAB = { symbol: 'TSLAB', dexLiquidityUsd: 5e6, dexVolume24hUsd: 1, source: 't', ts: 1 };
  const instsGold = insts.map((i) => (i.symbol === 'PAXG' ? { ...i, name: 'PAX Gold (tokenized gold)' } : i));
  const [o] = await new RwaBrain().propose(ctx({ snapshot: s, instruments: instsGold }));
  assert.equal(o.symbol, 'PAXG');
  assert.match(o.rationale, /Fear and greed is 10/);
});
