import type { RailName, SettlementRail } from '../../../shared/src/types.js';
import { LocalRail } from './local.js';
import { YellowRail, type Env } from './yellow.js';

export { LocalRail } from './local.js';
export { YellowRail, weightsFor, networkConfig, explorerTxUrl, KEY_ENV } from './yellow.js';

/**
 * Creates a settlement rail. 'local' is in-memory; 'yellow-sandbox' and 'yellow-mainnet' use
 * Yellow Network app sessions. Never falls back silently: a misconfigured Yellow rail throws here,
 * and every method rejects with a message prefixed by the rail name.
 */
export function createRail(name: RailName, env: Env = process.env): SettlementRail {
  switch (name) {
    case 'local':
      return new LocalRail();
    case 'yellow-sandbox':
    case 'yellow-mainnet':
      try {
        return new YellowRail(name, env);
      } catch (e) {
        throw new Error(`[rail:${name}] cannot create rail: ${e instanceof Error ? e.message : String(e)}`);
      }
    default:
      throw new Error(`[rail] unknown rail "${String(name)}"; expected local, yellow-sandbox or yellow-mainnet`);
  }
}
