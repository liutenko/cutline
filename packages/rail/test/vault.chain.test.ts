// VaultRail against a throwaway local Hardhat node (offline). Needs `npm run compile` in contracts/ first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { VaultRail, isNonceError } from '../src/vault.js';
import type { RailParticipant } from '../../../shared/src/types.js';

// Hardhat's public default test accounts #0..#4 (well-known fixture keys, never funded anywhere real).
const HH_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b05a8c4f7b2bfa3b7d0d4c0b',
];
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const contractsDir = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const artifact = (n: string) => JSON.parse(readFileSync(`${contractsDir}artifacts/contracts/${n}.sol/${n}.json`, 'utf8'));
const env = { DESK_KEY: HH_KEYS[0], RISK_KEY: HH_KEYS[1] };
const addr = (i: number) => privateKeyToAccount(HH_KEYS[i]!).address;
const participants: RailParticipant[] = [
  { id: 'desk', role: 'desk', address: addr(0) },
  { id: 'risk', role: 'risk', address: addr(1) },
  { id: 'momentum', role: 'agent', address: addr(2) },
  { id: 'rwa', role: 'agent', address: addr(3) },
  { id: 'event', role: 'agent', address: addr(4) },
];

let node: ChildProcess;
let vault: Hex;
let token: Hex;
const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
const balanceOf = (a: Hex) =>
  pub.readContract({ address: token, abi: artifact('TestUSD').abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const rail = () => new VaultRail(env, { rpcUrl: RPC, vault, token, chainId: 31337, explorer: null });

before(async () => {
  node = spawn('npx', ['hardhat', 'node', '--port', String(PORT)], { cwd: contractsDir, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hardhat node did not start')), 30_000);
    node.stdout!.on('data', (b: Buffer) => {
      if (b.toString().includes('Started HTTP')) {
        clearTimeout(t);
        resolve();
      }
    });
    node.on('exit', (c) => reject(new Error(`hardhat node exited ${c}`)));
  });
  const desk = createWalletClient({ account: privateKeyToAccount(HH_KEYS[0]!), chain: hardhat, transport: http(RPC) });
  const deploy = async (n: string, args: unknown[]) => {
    const a = artifact(n);
    const hash = await desk.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress as Hex;
  };
  token = await deploy('TestUSD', [addr(0)]);
  vault = await deploy('DeskVault', [token, addr(0), addr(1)]);
  const h = await desk.writeContract({ address: token, abi: artifact('TestUSD').abi, functionName: 'mint', args: [addr(0), parseUnits('1000', 6)] });
  await pub.waitForTransactionReceipt({ hash: h });
});

after(() => {
  node?.kill('SIGTERM');
});

test('full flow: open, fund two agents, mark, cut, close with payout', { timeout: 60_000 }, async () => {
  const r = rail();
  const deskBefore = await balanceOf(addr(0));
  const open = await r.open({ participants, asset: 'usdt', amount: '10' });
  assert.equal(open.offchain, false);
  assert.match(open.txHash!, /^0x[0-9a-f]{64}$/);
  assert.equal(open.explorerUrl, undefined); // local node: no explorer
  assert.equal(open.version, 1);
  assert.equal(r.state()!.asset, 'tusd');
  assert.deepEqual(open.allocations, { desk: '10', risk: '0', momentum: '0', rwa: '0', event: '0' });
  assert.equal(await balanceOf(vault), parseUnits('10', 6));

  const a = await r.reallocate({ desk: '4', momentum: '3', rwa: '3' }, 'fund momentum and rwa');
  assert.equal(a.version, 2);
  assert.equal(a.memo, 'fund momentum and rwa');
  const b = await r.reallocate({ desk: '4', momentum: '3.2', rwa: '2.8' }, 'mark to paper equity');
  assert.equal(b.version, 3);
  const c = await r.reallocate({ desk: '6.8', momentum: '3.2' }, 'cut rwa');
  assert.equal(c.allocations.rwa, '0');
  const z = await r.close({ desk: '6.84', momentum: '3.16' });
  assert.equal(z.kind, 'close');
  assert.equal(z.version, 5);
  assert.equal(r.state()!.status, 'closed');
  assert.equal(await balanceOf(vault), 0n);
  assert.equal(await balanceOf(addr(2)), parseUnits('3.16', 6));
  assert.equal(deskBefore - (await balanceOf(addr(0))), parseUnits('3.16', 6));
  assert.equal(r.txHistory().filter((t) => t.kind === 'reallocate').length, 3);
});

test('rejects a non-conserving map before sending anything', { timeout: 30_000 }, async () => {
  const r = rail();
  await r.open({ participants, asset: 'usdt', amount: '10' });
  const n = r.txHistory().length;
  await assert.rejects(r.reallocate({ desk: '4', momentum: '3' }, 'bad'), /\[rail:bnb-testnet-vault\] reallocate failed: .*does not equal the session total 10/);
  await assert.rejects(r.reallocate({ desk: '9.9999999', momentum: '0.0000001' }, 'bad'), /more than 6 decimal places/);
  assert.equal(r.txHistory().length, n);
  await r.close({ desk: '10' });
});

test('open fails clearly on a stale on-chain round; closeStale returns it to the desk', { timeout: 30_000 }, async () => {
  const crashed = rail();
  await crashed.open({ participants, asset: 'usdt', amount: '5' });
  await crashed.reallocate({ desk: '2', momentum: '3' }, 'fund');
  // a new process starts while the round is still open
  const fresh = rail();
  await assert.rejects(fresh.open({ participants, asset: 'usdt', amount: '5' }), /still open on-chain at version 2.*vault:close-stale/);
  const deskBefore = await balanceOf(addr(0));
  const res = await fresh.closeStale();
  assert.ok(res);
  assert.equal((await balanceOf(addr(0))) - deskBefore, parseUnits('5', 6));
  assert.equal(await fresh.closeStale(), null);
  const ok = await fresh.open({ participants, asset: 'usdt', amount: '1' });
  assert.equal(ok.version, 1);
  await fresh.close({ desk: '1' });
});

test('rejects a risk key that is not the vault risk manager', { timeout: 30_000 }, async () => {
  const r = new VaultRail({ DESK_KEY: HH_KEYS[0], RISK_KEY: HH_KEYS[2] }, { rpcUrl: RPC, vault, token, chainId: 31337, explorer: null });
  await assert.rejects(r.open({ participants, asset: 'usdt', amount: '1' }), /vault risk manager is .* but RISK_KEY is/);
});

test('rejects a wrong expected chain id', { timeout: 30_000 }, async () => {
  const r = new VaultRail(env, { rpcUrl: RPC, vault, token, chainId: 97 });
  await assert.rejects(r.open({ participants, asset: 'usdt', amount: '1' }), /RPC is on chain 31337, expected 97/);
  assert.throws(() => new VaultRail(env, { rpcUrl: RPC, vault, token, chainId: 56 }), /never runs on BNB Chain mainnet/);
});

test('a second rail instance cannot act on a round it did not open', { timeout: 30_000 }, async () => {
  const a = rail();
  await a.open({ participants, asset: 'usdt', amount: '2' });
  const b = rail();
  await assert.rejects(b.reallocate({ desk: '2' }, 'x'), /no round is open/);
  await a.close({ desk: '2' });
});

test('an unrelated desk transaction between rail calls does not break the rail (fresh nonce)', { timeout: 30_000 }, async () => {
  const r = rail();
  const desk = createWalletClient({ account: privateKeyToAccount(HH_KEYS[0]!), chain: hardhat, transport: http(RPC) });
  const other = () => desk.sendTransaction({ to: addr(4), value: 1n });
  await r.open({ participants, asset: 'usdt', amount: '3' });
  await pub.waitForTransactionReceipt({ hash: await other() });
  await r.reallocate({ desk: '1', momentum: '2' }, 'after an outside tx');
  await pub.waitForTransactionReceipt({ hash: await other() });
  await pub.waitForTransactionReceipt({ hash: await other() });
  // and through runExclusive, as the engine does for Scorecard calls
  const h = await r.runExclusive(async () => {
    const hash = await other();
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  });
  assert.match(h, /^0x/);
  const z = await r.close({ desk: '1', momentum: '2' });
  assert.equal(z.version, 3);
});

test('runExclusive never overlaps a rail call', { timeout: 30_000 }, async () => {
  const r = rail();
  const events: string[] = [];
  const p1 = r.open({ participants, asset: 'usdt', amount: '1' }).then(() => events.push('open done'));
  const p2 = r.runExclusive(async () => {
    events.push('exclusive start');
    await new Promise((res) => setTimeout(res, 50));
    events.push('exclusive end');
  });
  const p3 = r.close({ desk: '1' }).then(() => events.push('close done'));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(events, ['open done', 'exclusive start', 'exclusive end', 'close done']);
  await assert.rejects(r.runExclusive(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(r.state()!.status, 'closed');
});

test('isNonceError recognises nonce races only', () => {
  assert.ok(isNonceError(new Error('Nonce provided for the transaction (15) is lower than the current nonce of the account')));
  assert.ok(isNonceError(new Error('nonce too low')));
  assert.ok(isNonceError(new Error('already known')));
  assert.ok(isNonceError(new Error('replacement transaction underpriced')));
  assert.ok(!isNonceError(new Error('insufficient funds for gas')));
});
