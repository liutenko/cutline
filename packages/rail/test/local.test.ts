import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRail } from '../src/local.js';
import { createRail } from '../src/index.js';
import type { RailParticipant } from '../../../shared/src/types.js';

const participants: RailParticipant[] = [
  { id: 'desk', role: 'desk', address: '0x1000000000000000000000000000000000000001' },
  { id: 'risk', role: 'risk', address: '0x1000000000000000000000000000000000000002' },
  { id: 'momentum', role: 'agent', address: '0x1000000000000000000000000000000000000003' },
  { id: 'rwa', role: 'agent', address: '0x1000000000000000000000000000000000000004' },
  { id: 'event', role: 'agent', address: '0x1000000000000000000000000000000000000005' },
];

test('open puts the full amount with the desk', async () => {
  const rail = new LocalRail();
  const r = await rail.open({ participants, asset: 'usdt', amount: '10' });
  assert.equal(r.kind, 'open');
  assert.equal(r.rail, 'local');
  assert.equal(r.offchain, true);
  assert.equal(r.txHash, undefined);
  assert.equal(r.version, 1);
  assert.deepEqual(r.allocations, { desk: '10', risk: '0', momentum: '0', rwa: '0', event: '0' });
  const st = rail.state()!;
  assert.equal(st.status, 'open');
  assert.equal(st.asset, 'usdt');
  assert.equal(st.sessionId, r.sessionId);
});

test('reallocate conserves the total and bumps the version', async () => {
  const rail = new LocalRail();
  await rail.open({ participants, asset: 'usdt', amount: '10' });
  const r1 = await rail.reallocate({ desk: '4', momentum: '3', rwa: '3' }, 'fund two agents');
  assert.equal(r1.version, 2);
  assert.equal(r1.kind, 'reallocate');
  assert.equal(r1.memo, 'fund two agents');
  assert.deepEqual(r1.allocations, { desk: '4', risk: '0', momentum: '3', rwa: '3', event: '0' });
  const r2 = await rail.reallocate({ desk: '4.15', momentum: '2.85', rwa: '3' }, 'mark to paper');
  assert.equal(r2.version, 3);
  assert.equal(rail.state()!.allocations.desk, '4.15');
});

test('reallocate rejects a map that does not conserve the total', async () => {
  const rail = new LocalRail();
  await rail.open({ participants, asset: 'usdt', amount: '10' });
  await assert.rejects(rail.reallocate({ desk: '4', momentum: '3' }, 'bad'), /does not equal the session total 10/);
  assert.equal(rail.state()!.version, 1, 'failed reallocate must not bump the version');
});

test('reallocate rejects unknown ids, negatives and junk', async () => {
  const rail = new LocalRail();
  await rail.open({ participants, asset: 'usdt', amount: '10' });
  await assert.rejects(rail.reallocate({ desk: '9', stranger: '1' }, 'x'), /not a participant/);
  await assert.rejects(rail.reallocate({ desk: '11', momentum: '-1' }, 'x'), /not a non-negative decimal/);
  await assert.rejects(rail.reallocate({ desk: 'ten' }, 'x'), /not a non-negative decimal/);
});

test('close settles the final split and marks closed; later calls reject', async () => {
  const rail = new LocalRail();
  await rail.open({ participants, asset: 'usdc', amount: '10' });
  await rail.reallocate({ desk: '4', momentum: '3', rwa: '3' }, 'fund');
  const c = await rail.close({ desk: '6.2', momentum: '3.8' });
  assert.equal(c.kind, 'close');
  assert.equal(c.version, 3);
  assert.equal(c.offchain, true);
  assert.equal(rail.state()!.status, 'closed');
  assert.deepEqual(rail.state()!.allocations, { desk: '6.2', risk: '0', momentum: '3.8', rwa: '0', event: '0' });
  await assert.rejects(rail.reallocate({ desk: '10' }, 'x'), /closed/);
  await assert.rejects(rail.close({ desk: '10' }), /closed/);
});

test('close rejects a split that does not conserve the total', async () => {
  const rail = new LocalRail();
  await rail.open({ participants, asset: 'usdt', amount: '10' });
  await assert.rejects(rail.close({ desk: '9' }), /does not equal/);
  assert.equal(rail.state()!.status, 'open');
});

test('a new session can open after close', async () => {
  const rail = new LocalRail();
  const a = await rail.open({ participants, asset: 'usdt', amount: '10' });
  await rail.close({ desk: '10' });
  const b = await rail.open({ participants, asset: 'usdt', amount: '5' });
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(rail.state()!.allocations.desk, '5');
});

test('open validates input', async () => {
  const rail = new LocalRail();
  await assert.rejects(rail.open({ participants, asset: 'usdt', amount: '0' }), /greater than zero/);
  await assert.rejects(rail.open({ participants: participants.slice(2), asset: 'usdt', amount: '1' }), /desk/);
  await assert.rejects(
    rail.open({ participants: [...participants, { ...participants[2]!, id: 'dup' }], asset: 'usdt', amount: '1' }),
    /duplicate address/,
  );
  await rail.open({ participants, asset: 'usdt', amount: '1' });
  await assert.rejects(rail.open({ participants, asset: 'usdt', amount: '1' }), /already open/);
  await assert.rejects(new LocalRail().reallocate({}, 'x'), /no session is open/);
});

test('state() returns a copy', async () => {
  const rail = new LocalRail();
  assert.equal(rail.state(), null);
  await rail.open({ participants, asset: 'usdt', amount: '10' });
  rail.state()!.allocations.desk = '999';
  assert.equal(rail.state()!.allocations.desk, '10');
});

test('createRail returns the right implementation and rejects unknown names', () => {
  assert.equal(createRail('local', {}).name, 'local');
  assert.throws(() => createRail('nope' as never, {}), /unknown rail/);
  assert.throws(() => createRail('yellow-sandbox', {}), /DESK_KEY/);
});
