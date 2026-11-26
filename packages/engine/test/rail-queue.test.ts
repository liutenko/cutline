// Rail pacing for an on-chain rail: a fake slow rail (300 ms per call) and the real LocalRail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import type { DeskEvent, RailName, RailParticipant, RailReceipt, SettlementRail } from '../../../shared/src/types.ts';
import { Desk, DEFAULT_AGENTS, type DeskDeps, type ScorecardPort } from '../src/desk.ts';
import { DevSimProvider } from '../src/dev/DevSimProvider.ts';
import { DevRail } from '../src/dev/DevRail.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { sumUnits, toUnits } from '../src/money.ts';
import { LocalRail } from '../../rail/src/local.ts';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call { kind: 'open' | 'reallocate' | 'close'; memo: string; alloc: Record<string, string>; start: number; end: number }

/** Behaves like the vault rail: every call is a transaction that takes `delayMs` to confirm. */
/** Stands in for the desk key: records every transaction window and fails on any overlap. */
class DeskKey {
  busy = false;
  overlaps = 0;
  readonly txs: { what: string; start: number; end: number }[] = [];
  async send<T>(what: string, ms: number, fn: () => Promise<T>): Promise<T> {
    if (this.busy) this.overlaps++;
    this.busy = true;
    const start = Date.now();
    try {
      await sleep(ms);
      return await fn();
    } finally {
      this.txs.push({ what, start, end: Date.now() });
      this.busy = false;
    }
  }
}

class SlowRail implements SettlementRail {
  readonly name: RailName = 'bnb-testnet-vault';
  readonly calls: Call[] = [];
  private inner = new DevRail();
  constructor(private delayMs = 300, private failOn?: (c: Omit<Call, 'start' | 'end'>) => boolean, readonly key = new DeskKey()) {}

  private async run(kind: Call['kind'], memo: string, alloc: Record<string, string>, fn: () => Promise<RailReceipt>): Promise<RailReceipt> {
    const start = Date.now();
    return this.key.send(`rail:${kind}`, this.delayMs, async () => {
      if (this.failOn?.({ kind, memo, alloc })) throw new Error('[rail:bnb-testnet-vault] execution reverted: test failure');
      const r = await fn();
      this.calls.push({ kind, memo, alloc, start, end: Date.now() });
      return { ...r, rail: this.name, offchain: false, txHash: `0x${this.calls.length.toString(16)}` as Hex };
    });
  }
  open(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }) {
    return this.run('open', 'open', {}, () => this.inner.open(p));
  }
  reallocate(next: Record<string, string>, memo: string) {
    return this.run('reallocate', memo, next, () => this.inner.reallocate(next, memo));
  }
  close(final: Record<string, string>) {
    return this.run('close', 'close', final, () => this.inner.close(final));
  }
  state() {
    return this.inner.state();
  }
}

function setup(rail: () => SettlementRail, railName: RailName, cfg: Partial<DeskDeps['config']> = {}, extra: Partial<DeskDeps> = {}) {
  const provider = new DevSimProvider({ seed: 7, eventJumpProb: 0 });
  provider.setEvent(0, 0.2, 0.0);
  provider.setEvent(1, 0.7, 0.08);
  provider.setFearGreed(35);
  for (const s of ['BNB', 'ETH', 'BTCB', 'CAKE']) provider.setTrend(s, 0.002);
  const config = { ...DEFAULT_CONFIG, evalTicks: 4, ...cfg };
  const desk = new Desk({
    provider, railFactory: rail, railName,
    agents: DEFAULT_AGENTS.map((a, i) => ({ ...a, address: addr(10 + i) })), deskAddress: addr(1), riskAddress: addr(2),
    config, mode: 'dev', manual: true, ...extra,
  });
  const pot = toUnits(config.realPot);
  const events: DeskEvent[] = [];
  desk.on('event', (e: DeskEvent) => {
    events.push(e);
    if (e.type === 'rail') assert.equal(sumUnits(e.receipt.allocations), pot, `rail ${e.receipt.kind} receipt must sum to the pot`);
  });
  return { desk, events, pot };
}

/** Ticks (timing each one) until the first agent is funded. */
async function tickUntilFunded(desk: Desk, max = 20): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < max; i++) {
    const t0 = Date.now();
    await desk.tick();
    times.push(Date.now() - t0);
    if (desk.state().agents.some((a) => a.status === 'funded')) return times;
  }
  assert.fail('no agent was funded');
}

/** Shocks the largest position of a funded agent hard enough to breach its drawdown limit. */
async function cutOne(desk: Desk): Promise<string> {
  const st = desk.state();
  const a = st.agents.find((x) => x.status === 'funded' && x.positions.length)!;
  assert.ok(a, 'a funded agent should hold a position');
  const p = [...a.positions].sort((x, y) => y.qty * st.snapshot!.marks[y.symbol].cmcPrice - x.qty * st.snapshot!.marks[x.symbol].cmcPrice)[0];
  await desk.control({ action: 'shock', symbol: p.symbol, pct: -90 });
  assert.equal(desk.state().agents.find((x) => x.agentId === a.agentId)!.status, 'cut');
  return a.agentId;
}

test('slow rail: ticks never wait for a pending transaction, and railPending counts it', async () => {
  const rail = new SlowRail(300);
  const { desk } = setup(() => rail, 'bnb-testnet-vault', { reallocMinTicks: 1, reallocMinDrift: 0 });
  await desk.control({ action: 'start' });
  const times = await tickUntilFunded(desk);
  assert.ok(desk.state().railPending! >= 1, 'the funding transaction is pending');
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await desk.tick();
  const dt = Date.now() - t0;
  assert.ok(Math.max(...times) < 150 && dt < 250, `ticks blocked on the rail: ${times.join(',')} / ${dt} ms for 5 ticks`);
  assert.ok(desk.state().railPending! >= 1);
  await desk.whenRailIdle();
  assert.equal(desk.state().railPending, 0);
  desk.dispose();
});

test('slow rail: drift updates coalesce to the latest target while a transaction is pending', async () => {
  const rail = new SlowRail(300);
  const { desk, events } = setup(() => rail, 'bnb-testnet-vault', { reallocMinTicks: 1, reallocMinDrift: 0 });
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk);
  for (let i = 0; i < 8; i++) await desk.tick(); // 8 drift updates queued while the funding tx is in flight
  await desk.whenRailIdle();
  const realloc = rail.calls.filter((c) => c.kind === 'reallocate');
  assert.match(realloc[0].memo, /^Funded /);
  const drifts = realloc.filter((c) => c.memo.startsWith('Mark to market'));
  assert.equal(drifts.length, 1, `expected the 8 drift updates to coalesce into 1, got ${drifts.length}`);
  // The coalesced update is the latest target: the confirmed allocation now matches the last receipt.
  const last = events.filter((e): e is Extract<DeskEvent, { type: 'rail' }> => e.type === 'rail').at(-1)!;
  assert.deepEqual(last.receipt.allocations, drifts[0].alloc);
  desk.dispose();
});

test('slow rail: drift is throttled by REALLOC_MIN_TICKS and REALLOC_MIN_DRIFT (defaults 10 and 0.02)', async () => {
  const rail = new SlowRail(5);
  const { desk } = setup(() => rail, 'bnb-testnet-vault');
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk);
  for (let i = 0; i < 25; i++) {
    await desk.tick();
    await desk.whenRailIdle();
  }
  const drifts = rail.calls.filter((c) => c.memo.startsWith('Mark to market'));
  assert.ok(drifts.length <= 3, `at most one drift update per 10 ticks, got ${drifts.length}`);
  desk.dispose();
});

test('slow rail: a cut is never coalesced away and reaches the rail as its own reallocation, in order', async () => {
  const rail = new SlowRail(300);
  const { desk } = setup(() => rail, 'bnb-testnet-vault', { reallocMinTicks: 1, reallocMinDrift: 0 });
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk);
  await desk.tick(); // a drift update queues behind the funding tx
  const cutId = await cutOne(desk);
  for (let i = 0; i < 4; i++) await desk.tick(); // more drift after the cut
  await desk.whenRailIdle();
  const memos = rail.calls.filter((c) => c.kind === 'reallocate').map((c) => c.memo);
  const iFund = memos.findIndex((m) => m.startsWith('Funded '));
  const iCut = memos.findIndex((m) => m.startsWith(`Cut ${cutId}:`));
  assert.ok(iFund === 0 && iCut > iFund, memos.join(' | '));
  assert.equal(rail.calls.filter((c) => c.kind === 'reallocate')[iCut].alloc[cutId], '0');
  assert.equal(memos.filter((m) => m.startsWith('Cut ')).length, 1);
  desk.dispose();
});

test('slow rail: close-round drains the queue, then closes, then calls the scorecard', async () => {
  const rail = new SlowRail(300);
  let scorecardAt = 0;
  const scorecard: ScorecardPort = {
    async closeRound(i) {
      scorecardAt = Date.now();
      return { roundId: i.roundId, txHash: '0xfeed' as Hex, explorerUrl: 'x', chainId: 97 };
    },
  };
  const { desk, pot } = setup(() => rail, 'bnb-testnet-vault', { reallocMinTicks: 1, reallocMinDrift: 0 }, { scorecard });
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk);
  await desk.tick();
  const cutId = await cutOne(desk);
  assert.ok(desk.state().railPending! >= 2, 'funding and cut are still pending when the close is requested');
  await desk.control({ action: 'close-round' });
  const st = desk.state();
  assert.equal(st.round.phase, 'settled');
  assert.equal(st.railPending, 0);
  const close = rail.calls.at(-1)!;
  assert.equal(close.kind, 'close');
  for (const c of rail.calls.slice(0, -1)) assert.ok(c.end <= close.start, 'every queued tx confirms before the close is sent');
  assert.ok(rail.calls.some((c) => c.memo.startsWith(`Cut ${cutId}:`)));
  assert.ok(scorecardAt >= close.end, 'the scorecard call comes after the close confirms');
  for (const c of rail.calls.filter((x) => x.kind !== 'open')) assert.equal(sumUnits(c.alloc), pot);
  for (const r of st.receipts) assert.equal(sumUnits(r.allocations), pot);
  desk.dispose();
});

test('slow rail: a failed transaction is a loud error, pauses the desk, and only reset clears it', async () => {
  const rail = new SlowRail(20, (c) => c.kind === 'reallocate' && c.memo.startsWith('Funded '));
  const { desk, events } = setup(() => rail, 'bnb-testnet-vault');
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk);
  await desk.whenRailIdle();
  const err = events.find((e) => e.type === 'log' && e.level === 'error');
  assert.ok(err && err.type === 'log' && /Rail reallocation failed \(Funded .*execution reverted.*reset the desk/.test(err.message), JSON.stringify(err));
  assert.equal(desk.state().running, false);
  assert.equal(desk.state().railPending, 0);
  const n = rail.calls.length;
  await desk.tick();
  await desk.whenRailIdle();
  assert.equal(rail.calls.length, n, 'no silent retry');
  await assert.rejects(desk.control({ action: 'start' }), /rail is halted/);
  await assert.rejects(desk.control({ action: 'close-round' }), /rail is halted/);
  await desk.control({ action: 'reset' });
  await desk.control({ action: 'start' });
  assert.equal(desk.state().round.phase, 'evaluation');
  desk.dispose();
});

test('LocalRail: full round through the queue, every receipt sums to the pot', async () => {
  const { desk, events, pot } = setup(() => new LocalRail(), 'local');
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk);
  for (let i = 0; i < 3; i++) await desk.tick();
  await cutOne(desk);
  await desk.control({ action: 'close-round' });
  const st = desk.state();
  assert.equal(st.round.phase, 'settled');
  assert.equal(st.railState!.status, 'closed');
  const kinds = events.filter((e): e is Extract<DeskEvent, { type: 'rail' }> => e.type === 'rail').map((e) => e.receipt.kind);
  assert.equal(kinds[0], 'open');
  assert.equal(kinds.at(-1), 'close');
  for (const r of st.receipts) assert.equal(sumUnits(r.allocations), pot);
  desk.dispose();
});

/** A Scorecard that sends with the same desk key as the rail. */
function sharedKeyScorecard(key: DeskKey, onchain: Record<string, boolean> = {}) {
  const registered: string[][] = [];
  const sc: ScorecardPort = {
    async readAgent(agentId) {
      const a = DEFAULT_AGENTS.find((x) => x.agentId === agentId)!;
      const i = DEFAULT_AGENTS.indexOf(a);
      return onchain[agentId] ? { name: a.name, address: addr(10 + i), strategy: a.strategy, exists: true } : { name: '', address: addr(0), strategy: '', exists: false };
    },
    async registerAgents(agents) {
      for (const a of agents) await key.send(`scorecard:register:${a.agentId}`, 150, async () => undefined);
      registered.push(agents.map((a) => a.agentId));
    },
    async closeRound(i) {
      return key.send('scorecard:closeRound', 150, async () => ({ roundId: i.roundId, txHash: '0xfeed' as Hex, explorerUrl: 'x', chainId: 97 }));
    },
  };
  return { sc, registered };
}

test('scorecard and rail share one queue: desk-key transactions never overlap', async () => {
  const key = new DeskKey();
  const rail = new SlowRail(300, undefined, key);
  const { sc, registered } = sharedKeyScorecard(key);
  const { desk, events } = setup(() => rail, 'bnb-testnet-vault', { reallocMinTicks: 1, reallocMinDrift: 0 }, { scorecard: sc });
  await desk.control({ action: 'start' });
  await tickUntilFunded(desk); // funding queues while the 3 registrations are in flight
  await desk.tick();
  await cutOne(desk);
  await desk.control({ action: 'close-round' });
  await desk.whenRailIdle();
  assert.equal(key.overlaps, 0, JSON.stringify(key.txs));
  const sorted = [...key.txs].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, `${sorted[i - 1].what} overlaps ${sorted[i].what}`);
  const order = sorted.map((t) => t.what);
  assert.equal(order[0], 'rail:open');
  assert.deepEqual(order.slice(1, 4), ['scorecard:register:momentum', 'scorecard:register:rwa', 'scorecard:register:event']);
  assert.deepEqual(order.slice(-2), ['rail:close', 'scorecard:closeRound']);
  assert.deepEqual(registered, [['momentum', 'rwa', 'event']]);
  assert.equal(desk.state().scorecards.length, 1);
  assert.ok(events.some((e) => e.type === 'log' && /Round \d+ opened: 10 tUSD pot/.test(e.message)));
  desk.dispose();
});

test('scorecard registration is skipped when the contract already has the agents, partial when some are missing', async () => {
  for (const [onchain, expected] of [
    [{ momentum: true, rwa: true, event: true }, []],
    [{ momentum: true, rwa: true }, [['event']]],
  ] as const) {
    const key = new DeskKey();
    const { sc, registered } = sharedKeyScorecard(key, onchain);
    const { desk, events } = setup(() => new SlowRail(5, undefined, key), 'bnb-testnet-vault', {}, { scorecard: sc });
    await desk.control({ action: 'start' });
    await desk.whenRailIdle();
    assert.deepEqual(registered, expected);
    if (!expected.length) {
      assert.ok(events.some((e) => e.type === 'log' && e.message === 'Agents already registered on the Scorecard contract; no transaction sent.'));
      assert.equal(key.txs.filter((t) => t.what.startsWith('scorecard')).length, 0);
    }
    desk.dispose();
  }
});

test('scorecard calls go through rail.runExclusive when the rail has it', async () => {
  class ExclusiveRail extends SlowRail {
    exclusive = 0;
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      this.exclusive++;
      return fn();
    }
  }
  const key = new DeskKey();
  const rail = new ExclusiveRail(5, undefined, key);
  const { sc } = sharedKeyScorecard(key);
  const { desk } = setup(() => rail, 'bnb-testnet-vault', {}, { scorecard: sc });
  await desk.control({ action: 'start' });
  await desk.tick();
  await desk.control({ action: 'close-round' });
  assert.equal(rail.exclusive, 2, 'registerAgents and closeRound');
  desk.dispose();
});
