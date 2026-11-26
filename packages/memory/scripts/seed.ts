import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/env.js';
import { createDeskMemory, type RoundReport } from '../src/index.js';

loadEnv();
const file = process.argv[2];
if (!file) {
  console.error('usage: npm run memory:seed -- <path to a JSON round report>');
  process.exit(2);
}
const mem = createDeskMemory(process.env);
if (!mem) {
  console.error('LIVINGBRAIN_API_KEY is empty: nothing to seed.');
  process.exit(1);
}
try {
  const report = JSON.parse(readFileSync(file, 'utf8')) as RoundReport;
  const sources = await mem.rememberRound(report);
  for (const s of sources) console.log(`captured ${s.originRef} -> source ${s.id} status ${s.status}`);
  console.log('Captures compile in the background. Run "npm run memory:check" in a minute; do not search for them right away.');
} catch (e) {
  console.error('memory:seed failed:', (e as Error).message);
  process.exit(1);
}
