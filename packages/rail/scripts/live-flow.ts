// Live run on BNB Smart Chain testnet through the rail: open 10 tUSD, fund two agents with 3 each,
// one mark-to-market reallocation, one cut, close with a small profit payout to one agent.
// Usage: npm run test:live
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import { VaultRail } from '../src/vault.js';
import type { RailParticipant, RailReceipt } from '../../../shared/src/types.js';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const rail = new VaultRail(process.env);
const { privateKeyToAccount } = await import('viem/accounts');
const addrOf = (k: string) => privateKeyToAccount((process.env[k]!.startsWith('0x') ? process.env[k] : `0x${process.env[k]}`) as `0x${string}`).address;
const participants: RailParticipant[] = [
  { id: 'desk', role: 'desk', address: rail.deskAddress },
  { id: 'risk', role: 'risk', address: rail.riskAddress },
  { id: 'momentum', role: 'agent', address: addrOf('AGENT_MOMENTUM_KEY') },
  { id: 'rwa', role: 'agent', address: addrOf('AGENT_RWA_KEY') },
  { id: 'event', role: 'agent', address: addrOf('AGENT_EVENT_KEY') },
];
const show = (r: RailReceipt) => {
  const t = rail.txHistory().find((x) => x.txHash === r.txHash)!;
  console.log(`${r.kind.padEnd(10)} v${r.version} ${JSON.stringify(r.allocations)}`);
  console.log(`           ${r.explorerUrl}  gas ${t.gasUsed}  ${t.ms} ms  ${r.memo ?? ''}`);
};
console.log(`vault ${rail.vault}, token ${rail.token}`);
show(await rail.open({ participants, asset: 'usdt', amount: '10' }));
show(await rail.reallocate({ desk: '4', momentum: '3', rwa: '3' }, 'fund momentum and rwa, 3 tUSD each'));
show(await rail.reallocate({ desk: '4', momentum: '3.12', rwa: '2.88' }, 'mark to paper equity'));
show(await rail.reallocate({ desk: '6.88', momentum: '3.12' }, 'cut rwa: allocation returned to the desk'));
show(await rail.close({ desk: '6.904', momentum: '3.096' }));
const total = rail.txHistory().reduce((n, t) => n + t.gasUsed, 0n);
console.log(`transactions: ${rail.txHistory().map((t) => `${t.kind}=${t.gasUsed}gas/${t.ms}ms`).join(', ')}; total gas ${total}`);
const pub = (rail as unknown as { pub: { getGasPrice(): Promise<bigint> } }).pub;
console.log(`gas price now ${formatEther((await pub.getGasPrice()) * 10n ** 9n)} gwei-equivalent`);
process.exit(0);
