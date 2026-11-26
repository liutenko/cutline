import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadOnchainLinks } from '../src/onchain.ts';
import { DevSimProvider } from '../src/dev/DevSimProvider.ts';

test('onchain links: empty when files are missing, filled from the Scorecard and DeskVault deployments', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-onchain-'));
  assert.deepEqual(loadOnchainLinks(root), []);
  mkdirSync(path.join(root, 'contracts/deployments'), { recursive: true });
  writeFileSync(path.join(root, 'contracts/deployments/bscTestnet.json'), JSON.stringify({ address: '0xabc', chainId: 97, txHash: '0x2' }));
  writeFileSync(path.join(root, 'contracts/deployments/other.json'), JSON.stringify({ address: '0xdef', chainId: 97, txHash: '0x9' }));
  let links = loadOnchainLinks(root);
  assert.equal(links.length, 1);
  assert.equal(links[0].explorerUrl, 'https://testnet.bscscan.com/tx/0x2');
  assert.match(links[0].label, /^Scorecard contract deployed on BNB Smart Chain testnet at 0xabc$/);
  writeFileSync(path.join(root, 'contracts/deployments/bscTestnet-vault.json'), JSON.stringify({
    chainId: 97, vault: { address: '0xv', txHash: '0x3' }, token: { address: '0xt', txHash: '0x4' },
  }));
  links = loadOnchainLinks(root);
  assert.deepEqual(links.map((l) => l.label.split(' deployed')[0]), ['Scorecard contract', 'DeskVault contract', 'Test USD token']);
  assert.equal(links[2].explorerUrl, 'https://testnet.bscscan.com/tx/0x4');
  writeFileSync(path.join(root, 'contracts/deployments/bscTestnet-vault.json'), '{not json');
  assert.equal(loadOnchainLinks(root).length, 1);
});

test('dev simulation snapshots are labeled mode dev', async () => {
  assert.equal((await new DevSimProvider().snapshot()).mode, 'dev');
});
