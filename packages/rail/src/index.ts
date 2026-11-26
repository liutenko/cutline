import type { RailName, SettlementRail } from '../../../shared/src/types.js';
import { LocalRail } from './local.js';
import { VaultRail, type Env } from './vault.js';

export { LocalRail } from './local.js';
export { VaultRail, idToBytes32, describeError, DEPLOYMENT_FILE, type TxInfo, type VaultRailOptions } from './vault.js';

/**
 * Creates a settlement rail. 'local' is in-memory; 'bnb-testnet-vault' uses the DeskVault contract on
 * BNB Smart Chain testnet. Never falls back silently: a misconfigured vault rail throws here, and every
 * method rejects with a message prefixed by the rail name.
 */
export function createRail(name: RailName, env: Env = process.env): SettlementRail {
  switch (name) {
    case 'local':
      return new LocalRail();
    case 'bnb-testnet-vault':
      try {
        return new VaultRail(env);
      } catch (e) {
        throw new Error(`[rail:${name}] cannot create rail: ${e instanceof Error ? e.message : String(e)}`);
      }
    default:
      throw new Error(`[rail] unknown rail "${String(name)}"; expected local or bnb-testnet-vault`);
  }
}
