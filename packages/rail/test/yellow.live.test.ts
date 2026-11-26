// Live sandbox test. Needs network and the repo-root .env. Run: npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { YellowRail } from '../src/yellow.js';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

test('sandbox: connect, config lists yusd; full flow when the desk is funded', { timeout: 180_000 }, async (t) => {
  const rail = new YellowRail('yellow-sandbox', process.env);
  try {
    const c = await rail.connect();
    const cfg = await c.getConfig();
    assert.ok(cfg.blockchains.length > 0);
    const assets = await c.getAssets();
    assert.ok(assets.some((a) => a.symbol === 'yusd'), 'sandbox lists yusd');
    const bal = (await rail.balances(['desk'])).desk ?? {};
    if (!bal.yusd || Number(bal.yusd) < 1) {
      t.skip(`desk ${rail.addressOf('desk')} has no sandbox yusd; fund it via the faucet to run the full flow`);
      return;
    }
    const open = await rail.open({ participants: rail.defaultParticipants(), asset: 'usdt', amount: '1' });
    assert.equal(open.allocations.desk, '1');
    const r = await rail.reallocate({ desk: '0.4', momentum: '0.3', rwa: '0.3' }, 'live test');
    assert.equal(r.version, open.version + 1);
    const closed = await rail.close({ desk: '0.7', momentum: '0.3' });
    assert.equal(closed.kind, 'close');
    assert.equal(rail.state()!.status, 'closed');
  } finally {
    await rail.disconnect();
  }
});
