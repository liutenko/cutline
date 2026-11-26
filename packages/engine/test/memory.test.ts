import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import type { AgentAccount, DeskEvent } from '../../../shared/src/types.ts';
import { Desk, DEFAULT_AGENTS, type DeskDeps, type MemoryPort, type RoundReport, type SafeFn } from '../src/desk.ts';
import { DevSimProvider } from '../src/dev/DevSimProvider.ts';
import { DevRail } from '../src/dev/DevRail.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;

// Same contract as packages/memory safe(): never throws, logs, returns null.
const safe: SafeFn = async (label, fn, log = () => {}) => {
  try {
    return await fn();
  } catch (e) {
    log(`[memory] ${label} failed, continuing without memory: ${(e as Error).message}`);
    return null;
  }
};

type Recall = NonNullable<AgentAccount['memory']>;
const recallOf = (probation: boolean, slug: string): Recall => ({
  source: 'Living Brain', summary: `Momentum was cut in round 1 for a drawdown breach.`, pages: [{ slug, version: 2 }], probation, recalledAt: 1,
});

function fakeMemory(over: Partial<MemoryPort> = {}) {
  const reports: RoundReport[] = [];
  let release!: () => void;
  const written = new Promise<void>((r) => (release = r));
  const client: MemoryPort = {
    async recallAgent(agentId) {
      return agentId === 'momentum' ? recallOf(true, 'momentum-agent') : null;
    },
    async rememberRound(report) {
      reports.push(report);
      await written; // the test decides when the write completes
      return report.agents.map((a) => ({ id: a.agentId }));
    },
    async pendingSources() {
      return [{ id: 'x' }];
    },
    ...over,
  };
  return { client, reports, release };
}

function makeDesk(memory: DeskDeps['memory'], extra: Partial<DeskDeps> = {}) {
  const provider = new DevSimProvider({ seed: 7, eventJumpProb: 0 });
  provider.setEvent(0, 0.2, 0.0);
  provider.setEvent(1, 0.7, 0.08);
  provider.setFearGreed(35);
  for (const s of ['BNB', 'ETH', 'BTCB', 'CAKE']) provider.setTrend(s, 0.002);
  const desk = new Desk({
    provider, railFactory: () => new DevRail(), railName: 'local',
    agents: DEFAULT_AGENTS.map((a, i) => ({ ...a, address: addr(10 + i) })), deskAddress: addr(1), riskAddress: addr(2),
    config: { ...DEFAULT_CONFIG, evalTicks: 4 }, mode: 'dev', manual: true, memory, memoryRecallLimitMs: 200, ...extra,
  });
  const events: DeskEvent[] = [];
  desk.on('event', (e: DeskEvent) => events.push(e));
  return { desk, events };
}

test('memory off: status disabled, no memory fields, recall control refused', async () => {
  const { desk } = makeDesk(null);
  await desk.control({ action: 'start' });
  for (let i = 0; i < 3; i++) await desk.tick();
  const st = desk.state();
  assert.deepEqual(st.memoryStatus, { enabled: false, pendingCaptures: 0 });
  for (const a of st.agents) assert.equal(a.memory, undefined);
  await desk.control({ action: 'close-round' });
  await assert.rejects(desk.control({ action: 'recall' }), /memory is off/);
  desk.dispose();
});

test('probation: recalled cut halves the risk budget, says so in the check, and needs one more trade', async () => {
  const mem = fakeMemory();
  const { desk, events } = makeDesk({ client: mem.client, safe });
  await desk.control({ action: 'start' });
  const st0 = desk.state();
  const m = st0.agents.find((a) => a.agentId === 'momentum')!;
  assert.equal(m.memory?.probation, true);
  assert.equal(m.memory?.pages[0].slug, 'momentum-agent');
  assert.equal(st0.agents.find((a) => a.agentId === 'rwa')!.memory, undefined);
  assert.ok(events.some((e) => e.type === 'log' && /Momentum starts on probation: the desk's memory \(Living Brain page momentum-agent\)/.test(e.message)));
  assert.equal(st0.memoryStatus!.enabled, true);
  assert.equal(st0.memoryStatus!.brainName, 'cutline-desk');
  assert.equal(st0.memoryStatus!.pendingCaptures, 1);
  assert.ok(st0.memoryStatus!.lastRecallAt);
  for (let i = 0; i < 4; i++) await desk.tick();
  const st = desk.state();
  const mm = st.agents.find((a) => a.agentId === 'momentum')!;
  const other = st.agents.find((a) => a.agentId === 'event')!;
  assert.ok(Math.abs(mm.riskBudgetUsd / mm.equityUsd - (other.riskBudgetUsd / other.equityUsd) * 0.5) < 1e-9);
  const dec = events.find((e): e is Extract<DeskEvent, { type: 'decision' }> => e.type === 'decision' && e.order.agentId === 'momentum' && e.order.side === 'buy');
  assert.ok(dec, 'momentum should trade');
  assert.match(dec.decision.checks.find((c) => c.name === 'event-budget')!.detail, /x probation factor 0\.5: the desk's memory records an earlier cut/);
  const nonProb = events.find((e): e is Extract<DeskEvent, { type: 'decision' }> => e.type === 'decision' && e.order.agentId === 'event');
  if (nonProb) assert.doesNotMatch(nonProb.decision.checks.find((c) => c.name === 'event-budget')!.detail, /probation/);
  if (mm.status === 'evaluating') assert.match(mm.evalNote ?? '', /Needs 3 trades|bar/);
  desk.dispose();
});

test('close-round does not wait for the memory write; the report carries the round facts', async () => {
  const mem = fakeMemory();
  const { desk, events } = makeDesk({ client: mem.client, safe }, {
    scorecard: { async closeRound(i) { return { roundId: i.roundId, txHash: '0xfeed' as Hex, explorerUrl: 'x', chainId: 97 }; } },
  });
  await desk.control({ action: 'start' });
  for (let i = 0; i < 4; i++) await desk.tick();
  await desk.control({ action: 'rogue', agentId: 'rwa' });
  for (let i = 0; i < 3; i++) await desk.tick();
  // Close resolves while rememberRound is still pending.
  await desk.control({ action: 'close-round' });
  assert.equal(desk.state().round.phase, 'settled');
  assert.equal(mem.reports.length, 1);
  assert.equal(desk.state().memoryStatus!.lastWriteAt, undefined);
  const r = mem.reports[0];
  assert.equal(r.roundId, desk.state().round.id);
  assert.equal(r.scorecardTx, '0xfeed');
  assert.equal(r.eventMultiplier, desk.state().eventMultiplier);
  const fills = events.filter((e) => e.type === 'fill' && !e.fill.orderId.includes('-close-'));
  for (const a of r.agents) {
    const st = desk.state().agents.find((x) => x.agentId === a.agentId)!;
    assert.equal(a.status, st.status);
    assert.equal(a.trades, fills.filter((e) => e.type === 'fill' && e.fill.agentId === a.agentId).length);
  }
  const rwa = r.agents.find((a) => a.agentId === 'rwa')!;
  assert.equal(rwa.rogue, true);
  assert.ok(rwa.rejectedOrders >= 3);
  assert.ok(rwa.notableRejections.length >= 1 && rwa.notableRejections.length <= 3);
  assert.match(rwa.notableRejections[0], /exceeds the .* cap/);
  // Now the write completes.
  mem.release();
  for (let i = 0; i < 20 && !desk.state().memoryStatus!.lastWriteAt; i++) await new Promise((x) => setTimeout(x, 5));
  assert.ok(desk.state().memoryStatus!.lastWriteAt);
  assert.ok(events.some((e) => e.type === 'log' && e.message === 'Round written to desk memory: 3 captures sent to Living Brain.'));
  desk.dispose();
});

test('slow or failing recall: round starts on time, memory stays undefined, error is recorded; recall control works outside a round', async () => {
  const mem = fakeMemory({
    async recallAgent(agentId) {
      if (agentId === 'momentum') return new Promise(() => {}); // never answers
      if (agentId === 'rwa') throw new Error('503 from Living Brain');
      return recallOf(false, 'event-agent');
    },
  });
  const { desk } = makeDesk({ client: mem.client, safe });
  const t0 = Date.now();
  await desk.control({ action: 'start' });
  assert.ok(Date.now() - t0 < 2000);
  const st = desk.state();
  assert.equal(st.round.phase, 'evaluation');
  assert.equal(st.agents.find((a) => a.agentId === 'momentum')!.memory, undefined);
  assert.equal(st.agents.find((a) => a.agentId === 'rwa')!.memory, undefined);
  assert.equal(st.agents.find((a) => a.agentId === 'event')!.memory?.probation, false);
  assert.match(st.memoryStatus!.error ?? '', /recallAgent failed.*503/);
  await assert.rejects(desk.control({ action: 'recall' }), /outside a round/);
  await desk.control({ action: 'close-round' });
  await desk.control({ action: 'recall' });
  desk.dispose();
});
