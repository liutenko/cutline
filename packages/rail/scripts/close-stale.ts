// Recovery: closes a round left open in DeskVault on BNB Smart Chain testnet, returning the whole pot to the desk.
// Usage: npm run vault:close-stale
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'viem';
import { VaultRail } from '../src/vault.js';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const rail = new VaultRail(process.env);
const s = await rail.onchain();
if (!s.open) {
  console.log(`no open round in ${rail.vault} (last round ${s.roundId}); nothing to do`);
  process.exit(0);
}
console.log(`round ${s.roundId} is open at version ${s.version}, pot ${formatUnits(s.pot, 6)} tUSD; closing it with everything to the desk`);
const res = await rail.closeStale();
if (res) console.log(`closed round ${res.roundId}: ${rail.explorer}/tx/${res.receipt.txHash} (gas ${res.receipt.gasUsed}, ${res.receipt.ms} ms)`);
process.exit(0);
