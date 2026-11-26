import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

for (const name of ['DESK_KEY', 'RISK_KEY', 'AGENT_MOMENTUM_KEY', 'AGENT_RWA_KEY', 'AGENT_EVENT_KEY']) {
  const k = process.env[name]?.trim();
  if (!k) {
    console.log(`${name.replace(/_KEY$/, '').padEnd(16)} (not set)`);
    continue;
  }
  const addr = privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex).address;
  console.log(`${name.replace(/_KEY$/, '').padEnd(16)} ${addr}`);
}
