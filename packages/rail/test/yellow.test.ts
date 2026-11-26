import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { YellowRail, weightsFor, networkConfig } from '../src/yellow.js';
import { createRail } from '../src/index.js';
import type { RailParticipant } from '../../../shared/src/types.js';

// Offline: random throwaway keys, no network. Every check here fails before connect().
const env: Record<string, string> = {
  DESK_KEY: generatePrivateKey(),
  RISK_KEY: generatePrivateKey(),
  AGENT_MOMENTUM_KEY: generatePrivateKey(),
  AGENT_RWA_KEY: generatePrivateKey(),
  AGENT_EVENT_KEY: generatePrivateKey(),
  BSC_MAINNET_RPC: 'http://127.0.0.1:1',
};

test('quorum: only coalitions containing both desk and risk reach quorum', () => {
  const rail = new YellowRail('yellow-sandbox', env);
  const ps = rail.defaultParticipants();
  const { weights, quorum } = weightsFor(ps);
  assert.deepEqual(Object.fromEntries(weights), { desk: 4, risk: 4, momentum: 1, rwa: 1, event: 1 });
  assert.equal(quorum, 8);
  const ids = ps.map((p) => p.id);
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const set = ids.filter((_, i) => mask & (1 << i));
    const w = set.reduce((n, id) => n + weights.get(id)!, 0);
    const hasBoth = set.includes('desk') && set.includes('risk');
    assert.equal(w >= quorum, hasBoth, `coalition ${set.join('+')} weight ${w}`);
  }
});

test('network config: sandbox maps to yusd, mainnet is chain 56 usdt/usdc', () => {
  const sb = networkConfig('yellow-sandbox', {});
  assert.equal(sb.assetSymbol.usdt, 'yusd');
  assert.match(sb.wsUrl, /sandbox/);
  const mn = networkConfig('yellow-mainnet', { BSC_MAINNET_RPC: 'x' });
  assert.equal(mn.chainId, 56n);
  assert.equal(mn.assetSymbol.usdt, 'usdt');
  assert.equal(mn.rpcUrl, 'x');
  assert.equal(mn.explorerTxBase, 'https://bscscan.com/tx/');
});

test('createRail rejects missing keys and mainnet without an RPC', () => {
  assert.throws(() => createRail('yellow-sandbox', { ...env, RISK_KEY: '' }), /RISK_KEY/);
  assert.throws(() => createRail('yellow-mainnet', { ...env, BSC_MAINNET_RPC: '' }), /BSC_MAINNET_RPC/);
  assert.equal(createRail('yellow-sandbox', env).name, 'yellow-sandbox');
});

test('mainnet keys prefer <NAME>_MAINNET', () => {
  const k = generatePrivateKey();
  const rail = new YellowRail('yellow-mainnet', { ...env, DESK_KEY_MAINNET: k });
  assert.equal(rail.addressOf('desk'), privateKeyToAccount(k).address);
  assert.equal(new YellowRail('yellow-sandbox', { ...env, DESK_KEY_MAINNET: k }).addressOf('desk'), privateKeyToAccount(env.DESK_KEY as `0x${string}`).address);
});

test('open rejects a participant whose address does not match its key', async () => {
  const rail = new YellowRail('yellow-sandbox', env);
  const ps: RailParticipant[] = rail.defaultParticipants().map((p) =>
    p.id === 'rwa' ? { ...p, address: '0x1000000000000000000000000000000000000004' } : p,
  );
  await assert.rejects(rail.open({ participants: ps, asset: 'usdt', amount: '10' }), /\[rail:yellow-sandbox\] open failed: participant "rwa" address .* does not match AGENT_RWA_KEY/);
});

test('mainnet open refuses without the explicit confirmation variable', async () => {
  const rail = new YellowRail('yellow-mainnet', env);
  await assert.rejects(
    rail.open({ participants: rail.defaultParticipants(), asset: 'usdt', amount: '10' }),
    /YELLOW_MAINNET_CONFIRM=real-funds/,
  );
});

test('reallocate and close reject before open', async () => {
  const rail = new YellowRail('yellow-sandbox', env);
  await assert.rejects(rail.reallocate({ desk: '1' }, 'x'), /no session is open/);
  await assert.rejects(rail.close({ desk: '1' }), /no session is open/);
  assert.equal(rail.state(), null);
});
