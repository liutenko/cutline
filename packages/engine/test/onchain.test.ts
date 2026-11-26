import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadOnchainLinks } from '../src/onchain.ts';
import { DevSimProvider } from '../src/dev/DevSimProvider.ts';

test('onchain links: empty when files are missing, filled from yellow proofs and deployments', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-onchain-'));
  assert.deepEqual(loadOnchainLinks(root), []);
  mkdirSync(path.join(root, 'data/proofs/yellow'), { recursive: true });
  mkdirSync(path.join(root, 'contracts/deployments'), { recursive: true });
  writeFileSync(path.join(root, 'data/proofs/yellow/onchain.json'), JSON.stringify([
    { label: 'Deposit 10 USDT', explorerUrl: 'https://bscscan.com/tx/0x1', txHash: '0x1' },
    { label: 'bad entry' },
  ]));
  writeFileSync(path.join(root, 'contracts/deployments/bscTestnet.json'), JSON.stringify({ address: '0xabc', chainId: 97, txHash: '0x2' }));
  writeFileSync(path.join(root, 'contracts/deployments/broken.json'), '{not json');
  const links = loadOnchainLinks(root);
  assert.equal(links.length, 2);
  assert.equal(links[0].label, 'Deposit 10 USDT');
  assert.equal(links[1].explorerUrl, 'https://testnet.bscscan.com/tx/0x2');
  assert.match(links[1].label, /Scorecard contract deployed on BNB Smart Chain testnet at 0xabc/);
});

test('dev simulation snapshots are labeled mode dev', async () => {
  assert.equal((await new DevSimProvider().snapshot()).mode, 'dev');
});
