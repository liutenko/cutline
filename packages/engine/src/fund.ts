// DeskFund (depositor vault) state for the dashboard: read from BNB Smart Chain testnet every few seconds.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, defineChain, formatUnits, http, type Hex } from 'viem';
import { DESK_FUND_ABI } from '../../../contracts/src/fundAbi.ts';
import type { DeskState } from '../../../shared/src/types.ts';

type Fund = NonNullable<DeskState['fund']>;
const TOKEN_DECIMALS = 6;
const SHARE_DECIMALS = 9;

/** Reads contracts/deployments/bscTestnet-fund.json and polls fundState(). Returns null when there is no deployment. */
export function startFundReader(repoRoot: string, rpcUrl: string, onError: (m: string) => void, everyMs = 8000): (() => Fund | undefined) | null {
  let address: Hex | undefined;
  try {
    const d = JSON.parse(readFileSync(path.join(repoRoot, 'contracts', 'deployments', 'bscTestnet-fund.json'), 'utf8'));
    address = d.fund?.address;
  } catch {
    return null;
  }
  if (!address) return null;
  const chain = defineChain({ id: 97, name: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  let cache: Fund | undefined;
  let lastErr = '';
  const read = async () => {
    try {
      const r = (await pub.readContract({ address: address!, abi: DESK_FUND_ABI, functionName: 'fundState' } as never)) as readonly [bigint, bigint, bigint, bigint, boolean, bigint, bigint];
      const [assets, shares, reserve, fees, active, pot] = r;
      const a = Number(formatUnits(assets, TOKEN_DECIMALS));
      const s = Number(formatUnits(shares, SHARE_DECIMALS));
      cache = {
        address: address!,
        explorerUrl: `https://testnet.bscscan.com/address/${address}`,
        totalAssets: formatUnits(assets, TOKEN_DECIMALS),
        totalShares: formatUnits(shares, SHARE_DECIMALS),
        sharePrice: s > 0 ? (a / s).toFixed(6) : '1.000000',
        reserve: formatUnits(reserve, TOKEN_DECIMALS),
        protocolFees: formatUnits(fees, TOKEN_DECIMALS),
        roundActive: active,
        roundPot: formatUnits(pot, TOKEN_DECIMALS),
        updatedAt: Date.now(),
      };
      lastErr = '';
    } catch (e) {
      const m = e instanceof Error ? e.message.split('\n')[0] : String(e);
      if (m !== lastErr) onError(`DeskFund read failed: ${m.slice(0, 160)}`);
      lastErr = m;
    }
  };
  void read();
  setInterval(() => void read(), everyMs).unref();
  return () => cache;
}
