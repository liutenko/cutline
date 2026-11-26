import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes, type Hex } from 'viem';
import type { DeskEvent, ScorecardTx } from '../../../shared/src/types.ts';
import { Desk, DEFAULT_AGENTS, type ScorecardPort } from '../src/desk.ts';
import { DevSimProvider } from '../src/dev/DevSimProvider.ts';
import { DevRail } from '../src/dev/DevRail.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { canonicalJson, sumUnits, toUnits } from '../src/money.ts';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

test('full round on dev stand-ins: evaluate, fund, rogue blocked, shock cut, close and pay out', async () => {
  const provider = new DevSimProvider({ seed: 7, eventJumpProb: 0 });
  // Keep the run deterministic and give agents something to do: favorable divergence for the event agent,
  // low fear for the RWA agent, uptrends for momentum.
  provider.setEvent(0, 0.2, 0.0);
  provider.setEvent(1, 0.7, 0.08);
  provider.setFearGreed(35);
  for (const s of ['BNB', 'ETH', 'BTCB', 'CAKE']) provider.setTrend(s, 0.002);

  let rail: DevRail | null = null;
  const closeCalls: Parameters<ScorecardPort['closeRound']>[0][] = [];
  const scorecard: ScorecardPort = {
    async closeRound(input) {
      closeCalls.push(input);
      return { roundId: input.roundId, txHash: '0xabc' as Hex, explorerUrl: 'https://testnet.bscscan.com/tx/0xabc', chainId: 97 } satisfies ScorecardTx;
    },
  };
  const config = { ...DEFAULT_CONFIG, evalTicks: 4 };
  const desk = new Desk({
    provider,
    railFactory: () => (rail = new DevRail()),
    railName: 'local',
    agents: DEFAULT_AGENTS.map((a, i) => ({ ...a, address: addr(10 + i) })),
    deskAddress: addr(1),
    riskAddress: addr(2),
    config,
    mode: 'dev',
    scorecard,
    scorecardFeeds: { ETH: addr(0xe7), BNB: addr(0xb1) },
    manual: true,
  });
  const pot = toUnits(config.realPot);
  const events: DeskEvent[] = [];
  desk.on('event', (e: DeskEvent) => {
    events.push(e);
    if (e.type === 'rail') assert.equal(sumUnits(e.receipt.allocations), pot, `rail ${e.receipt.kind} must sum to the pot`);
  });
  const checkRail = () => {
    const st = rail!.state()!;
    assert.equal(sumUnits(st.allocations), pot);
    assert.equal(sumUnits(desk.state().railState!.allocations), pot);
  };

  await desk.control({ action: 'start' });
  assert.equal(desk.state().round.phase, 'evaluation');
  checkRail();

  // Evaluation.
  for (let i = 0; i < config.evalTicks; i++) {
    await desk.tick();
    checkRail();
  }
  await desk.whenRailIdle();
  const st1 = desk.state();
  assert.equal(st1.round.phase, 'funded');
  for (const a of st1.agents) assert.equal(a.equityHistory!.length, config.evalTicks + 1);
  // Every order produces a decision with all six checks and the right sources.
  const orderIds = events.filter((e) => e.type === 'order').map((e) => (e as Extract<DeskEvent, { type: 'order' }>).order.id);
  const decisions = events.filter((e): e is Extract<DeskEvent, { type: 'decision' }> => e.type === 'decision');
  assert.deepEqual(decisions.map((d) => d.order.id), orderIds);
  for (const d of decisions) {
    assert.deepEqual(d.decision.checks.map((c) => `${c.name}:${c.source}`), [
      'agent-status:Desk', 'liquidity:CoinMarketCap', 'price-agreement:Atlas', 'event-budget:Cournot', 'exposure:Desk', 'concentration:Desk',
    ]);
  }
  assert.ok('desk' in st1.railState!.allocations);
  for (const e of events) if (e.type === 'fill') assert.ok(e.fill.feePct === 0.25 && e.fill.midPrice! > 0 && e.fill.slippagePct! >= 0);
  assert.equal(st1.agents.length, 3);
  const funded = st1.agents.filter((a) => a.status === 'funded');
  assert.ok(funded.length >= 1, `expected at least one funded agent, got ${st1.agents.map((a) => `${a.agentId}:${a.status}:${a.pnlUsd.toFixed(0)}`).join(' ')}`);
  for (const a of funded) assert.equal(a.realAllocation, '3');
  for (const a of st1.agents) {
    if (a.status === 'evaluating') assert.match(a.evalNote ?? '', /Needs \d+ trades|below the -0\.5% bar/);
    else assert.equal(a.evalNote, undefined);
  }
  assert.equal((st1.config as { evalMinTrades?: number }).evalMinTrades, 2);
  assert.equal(st1.economics!.fundedAllocations, String(3 * funded.length));
  assert.equal(st1.economics!.capitalAtRisk, (3 * funded.length * 0.06).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

  assert.ok(events.some((e) => e.type === 'funded'));
  assert.ok(events.some((e) => e.type === 'budget'));
  assert.ok(events.filter((e) => e.type === 'fill').length >= 3, 'agents should trade during evaluation');
  for (const e of events) if (e.type === 'order') assert.ok(/\d/.test(e.order.rationale), e.order.rationale);

  // Rogue mode on one agent: every rogue order is rejected by the liquidity check, and sizes grow.
  const rogueId = 'rwa';
  await desk.control({ action: 'rogue', agentId: rogueId });
  assert.equal(desk.state().agents.find((a) => a.agentId === rogueId)!.rogue, true);
  const before = events.length;
  for (let i = 0; i < 3; i++) {
    await desk.tick();
    checkRail();
  }
  const rogueDecisions = events.slice(before).filter((e): e is Extract<DeskEvent, { type: 'decision' }> => e.type === 'decision' && e.order.agentId === rogueId);
  assert.ok(rogueDecisions.length >= 3);
  for (const d of rogueDecisions) {
    assert.equal(d.decision.approved, false);
    assert.equal(d.decision.checks.find((c) => c.name === 'liquidity')!.pass, false);
    assert.equal(d.order.symbol, 'THIN');
  }
  assert.ok(rogueDecisions[2].order.notionalUsd > rogueDecisions[0].order.notionalUsd);
  assert.ok(!events.slice(before).some((e) => e.type === 'fill' && e.fill.agentId === rogueId));

  // Shock the largest position of a funded agent hard enough to breach max drawdown.
  const st2 = desk.state();
  const target = st2.agents
    .filter((a) => a.status === 'funded' && a.positions.length)
    .map((a) => {
      const p = [...a.positions].sort((x, y) => y.qty * st2.snapshot!.marks[y.symbol].cmcPrice - x.qty * st2.snapshot!.marks[x.symbol].cmcPrice)[0];
      return { a, p, w: (p.qty * st2.snapshot!.marks[p.symbol].cmcPrice) / a.equityUsd };
    })
    .sort((x, y) => y.w - x.w)[0];
  assert.ok(target, 'a funded agent should hold a position');
  const shockPct = -Math.min(90, Math.ceil((8 / target.w)));
  await desk.control({ action: 'shock', symbol: target.p.symbol, pct: shockPct });
  await desk.whenRailIdle();
  checkRail();
  const cutEv = events.find((e) => e.type === 'cut' && e.agentId === target.a.agentId);
  assert.ok(cutEv, `expected ${target.a.agentId} to be cut after a ${shockPct}% shock on ${target.p.symbol}`);
  const st3 = desk.state();
  const cutAcc = st3.agents.find((a) => a.agentId === target.a.agentId)!;
  assert.equal(cutAcc.status, 'cut');
  assert.ok(cutAcc.cutReason && /\d/.test(cutAcc.cutReason));
  assert.equal(cutAcc.positions.length, 0);
  assert.equal(cutAcc.realAllocation, '0');
  assert.equal(st3.railState!.allocations[target.a.agentId], '0');
  assert.equal(st3.snapshot!.marks[target.p.symbol].synthetic, true);
  assert.ok(events.some((e) => e.type === 'shock'));

  // A cut agent's orders never fill again.
  await desk.tick();
  checkRail();

  // Close the round.
  await desk.control({ action: 'close-round' });
  const st4 = desk.state();
  assert.equal(st4.round.phase, 'settled');
  const closeR = st4.receipts.at(-1)!;
  assert.equal(closeR.kind, 'close');
  assert.equal(rail!.state()!.status, 'closed');
  assert.equal(sumUnits(closeR.allocations), pot);
  assert.equal(closeR.allocations[cutAcc.agentId], '0');
  for (const a of st4.agents) assert.equal(a.positions.length, 0);
  // Payout rule: 80% of positive real profit; everything else to the desk.
  const scale = 3 / 25000;
  for (const a of st4.agents) {
    if (a.status !== 'funded') {
      assert.equal(closeR.allocations[a.agentId], '0');
      continue;
    }
    const pay = Number(closeR.allocations[a.agentId]);
    assert.ok(pay >= 0 && pay < 3 * 0.8);
  }
  assert.ok(Number(closeR.allocations.desk) >= 10 - 3 * 3 * scale * 25000);
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].stateHash, keccak256(toBytes(canonicalJson(closeR.allocations))));
  assert.equal(closeCalls[0].results.length, 3);
  // Feeds in symbol order, prices from the unshocked marks at 18 decimals.
  assert.deepEqual(closeCalls[0].feeds, [addr(0xb1), addr(0xe7)]);
  assert.equal(closeCalls[0].offchainPrices.length, 2);
  assert.ok(closeCalls[0].offchainPrices[0] > 100n * 10n ** 18n);
  assert.ok(events.some((e) => e.type === 'scorecard'));
  // Economics: paid equals the agents' close allocations; the cut agent's loss is absorbed.
  const paid = st4.agents.reduce((x, a) => x + toUnits(closeR.allocations[a.agentId]), 0n);
  assert.equal(toUnits(st4.economics!.paidToAgents), paid);
  assert.ok(toUnits(st4.economics!.lossesAbsorbed) > 0n);
  assert.equal(st4.economics!.fundedAllocations, '0');
  assert.ok(st4.events.length <= 200);
  desk.dispose();
});
