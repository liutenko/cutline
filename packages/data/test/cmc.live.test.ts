import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CmcClient } from '../src/cmc.js';
import { loadEnv } from '../src/env.js';
import { INSTRUMENTS } from '../src/instruments.js';

loadEnv();
const client = new CmcClient({ apiKey: process.env.CMC_API_KEY, logDir: mkdtempSync(path.join(os.tmpdir(), 'cmclog-')) });

test('live: quotes, fear and greed, DEX token liquidity from CoinMarketCap', async () => {
  const quotes = await client.quotes([1839, 5176]);
  assert.ok(quotes.find((q) => q.cmcId === 1839)!.price > 10);
  const fg = await client.fearGreed();
  assert.ok(fg !== undefined && fg >= 0 && fg <= 100);
  const thin = INSTRUMENTS.find((i) => i.kind === 'thin')!;
  const dex = await client.dexToken(thin.bscAddress!);
  assert.ok(dex && dex.liquidityUsd > 0 && dex.liquidityUsd < 100_000, 'thin token liquidity under $100k');
});
