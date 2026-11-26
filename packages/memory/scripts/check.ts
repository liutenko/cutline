import { loadEnv } from '../src/env.js';
import { createDeskMemory } from '../src/index.js';
import type { AgentId } from '../../../shared/src/types.js';

loadEnv();
const mem = createDeskMemory(process.env);
if (!mem) {
  console.log('LIVINGBRAIN_API_KEY is empty: memory is off. Set LIVINGBRAIN_API_KEY and LIVINGBRAIN_SUBJECT_ID in the repo-root .env.');
  process.exit(0);
}

try {
  console.log('brain id:', await mem.brainId());
  const profile = await mem.profile().catch((e: Error) => `(not readable: ${e.message})`);
  console.log('profile:', typeof profile === 'string' ? profile : JSON.stringify(profile, null, 2));
  const stats = await mem.stats();
  console.log('pages:', stats.pageCount, 'sources:', stats.sourceCount, 'connections:', stats.connectionCount);
  const pending = await mem.pendingSources();
  console.log('pending sources:', pending.length, pending.map((s) => `${s.originRef ?? s.id}:${s.status}`).join(', '));
  const failed = await mem.listSources('failed');
  console.log('failed sources:', failed.length, failed.map((s) => `${s.originRef ?? s.id}: ${s.lastError ?? ''}`).join(', '));
  const agents: [AgentId, string][] = [['momentum', 'Momentum'], ['rwa', 'RWA Rotator'], ['event', 'Event Trader']];
  for (const [id, name] of agents) {
    const r = await mem.recallAgent(id, name);
    console.log(`recall ${name}:`, r ? JSON.stringify(r, null, 2) : 'null (no record)');
  }
} catch (e) {
  console.error('memory:check failed:', (e as Error).message);
  process.exit(1);
}
