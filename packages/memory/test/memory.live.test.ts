import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';
import { createDeskMemory } from '../src/index.js';

loadEnv();
const mem = createDeskMemory(process.env);
const skip = mem ? false : 'LIVINGBRAIN_API_KEY not set';

// Read-only against the real API: resolves the brain, reads stats, lists sources, recalls an agent.
// It does not capture, so it never pollutes the brain. Use `npm run memory:seed` for a write.
test('live: brain resolves and stats are readable', { skip }, async () => {
  const id = await mem!.brainId();
  assert.ok(id);
  const s = await mem!.stats();
  assert.equal(typeof s.pageCount, 'number');
});

test('live: pendingSources and recallAgent run without throwing', { skip }, async () => {
  const p = await mem!.pendingSources();
  assert.ok(Array.isArray(p));
  const r = await mem!.recallAgent('momentum', 'Momentum');
  assert.ok(r === null || (typeof r.summary === 'string' && typeof r.probation === 'boolean'));
});
