import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import type { Hex, Instrument, PriceMark } from '../../../shared/src/types.js';

const singleAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const multiAbi = [
  {
    type: 'function',
    name: 'fetch',
    stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes4' }],
    outputs: [
      {
        name: 'priceSnapshot',
        type: 'tuple',
        components: [
          { name: 'price', type: 'uint80' },
          { name: 'aggregatedTs', type: 'uint48' },
          { name: 'onchainTs', type: 'uint48' },
        ],
      },
    ],
  },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: 'precision', type: 'uint8' }] },
] as const;

/** ATLAS_FEEDS JSON shape. */
export interface AtlasConfig {
  chainId: number;
  rpc: string;
  /** symbol -> SingleFeed (Chainlink AggregatorV3 compatible) address */
  feeds?: Record<string, Hex>;
  /** One MultiFeed address plus symbol -> 4-byte feed id (0x + 8 hex chars). */
  multiFeed?: { address: Hex; feedIds: Record<string, Hex> };
}

export interface AtlasReading {
  price: number;
  /** ms epoch of the on-chain update */
  ts: number;
  source: 'single' | 'multi';
  address: Hex;
}

export function parseAtlasConfig(raw: string | undefined): AtlasConfig | undefined {
  if (!raw || !raw.trim()) return undefined;
  const j = JSON.parse(raw);
  if (typeof j?.chainId !== 'number' || typeof j?.rpc !== 'string') throw new Error('ATLAS_FEEDS needs chainId (number) and rpc (string)');
  return { chainId: j.chainId, rpc: j.rpc, feeds: j.feeds ?? {}, multiFeed: j.multiFeed };
}

/**
 * Config precedence: ATLAS_FEEDS env, else the atlasFeed fields on INSTRUMENTS read from BNB Smart Chain mainnet
 * through BSC_MAINNET_RPC (Atlas BSC mainnet feeds, see INSTRUMENTS).
 */
export function resolveAtlasConfig(instruments: Instrument[], env: Record<string, string | undefined>): AtlasConfig | undefined {
  const fromEnv = parseAtlasConfig(env.ATLAS_FEEDS);
  if (fromEnv) return fromEnv;
  const feeds: Record<string, Hex> = {};
  for (const i of instruments) if (i.atlasFeed) feeds[i.symbol] = i.atlasFeed;
  if (!Object.keys(feeds).length) return undefined;
  return { chainId: 56, rpc: env.BSC_MAINNET_RPC || 'https://bsc-dataseed.bnbchain.org', feeds };
}

/** price = answer / 10^decimals; returns undefined for an empty or non-positive feed. */
export function scaleAnswer(answer: bigint, decimals: number): number | undefined {
  if (answer <= 0n) return undefined;
  // keep precision for 18-decimal answers: split integer and fractional parts
  const base = 10n ** BigInt(decimals);
  const whole = Number(answer / base);
  const frac = Number(answer % base) / Number(base);
  return whole + frac;
}

export class AtlasReader {
  private client: PublicClient;
  private decimalsCache = new Map<string, number>();
  lastErrors: Record<string, string> = {};

  constructor(readonly config: AtlasConfig) {
    this.client = createPublicClient({
      chain: { id: config.chainId, name: `chain-${config.chainId}`, nativeCurrency: { name: 'native', symbol: 'N', decimals: 18 }, rpcUrls: { default: { http: [config.rpc] } } },
      transport: http(config.rpc, { timeout: 10_000, retryCount: 1 }),
    }) as PublicClient;
  }

  has(symbol: string): boolean {
    return !!(this.config.feeds?.[symbol] || this.config.multiFeed?.feedIds[symbol]);
  }

  private async decimals(address: Hex, multi: boolean): Promise<number> {
    const cached = this.decimalsCache.get(address);
    if (cached !== undefined) return cached;
    const d = await this.client.readContract({ address, abi: multi ? multiAbi : singleAbi, functionName: 'decimals' } as any);
    this.decimalsCache.set(address, Number(d));
    return Number(d);
  }

  /** Plain eth_call, no account. Returns undefined when no feed is configured or the read fails. */
  async read(symbol: string): Promise<AtlasReading | undefined> {
    try {
      const single = this.config.feeds?.[symbol];
      if (single) {
        const [round, dec] = await Promise.all([
          this.client.readContract({ address: single, abi: singleAbi, functionName: 'latestRoundData' }),
          this.decimals(single, false),
        ]);
        const price = scaleAnswer(round[1], dec);
        if (price === undefined || round[3] === 0n) return undefined;
        return { price, ts: Number(round[3]) * 1000, source: 'single', address: single };
      }
      const multi = this.config.multiFeed;
      const id = multi?.feedIds[symbol];
      if (multi && id) {
        const [snap, dec] = await Promise.all([
          this.client.readContract({ address: multi.address, abi: multiAbi, functionName: 'fetch', args: [id as Hex] }),
          this.decimals(multi.address, true),
        ]);
        const price = scaleAnswer(BigInt(snap.price), dec);
        if (price === undefined || snap.onchainTs === 0) return undefined;
        return { price, ts: Number(snap.onchainTs) * 1000, source: 'multi', address: multi.address };
      }
      return undefined;
    } catch (e) {
      this.lastErrors[symbol] = (e as Error).message.split('\n')[0].slice(0, 200);
      return undefined;
    }
  }
}

/** Agreement between CoinMarketCap and Atlas for one symbol. */
export function computeAgreement(
  cmcPrice: number,
  atlasPrice: number | undefined,
  toleranceBps: number,
): Pick<PriceMark, 'agreement' | 'deviationBps'> {
  if (atlasPrice === undefined || !(cmcPrice > 0)) return { agreement: 'single' };
  const deviationBps = (Math.abs(cmcPrice - atlasPrice) / cmcPrice) * 10_000;
  return { agreement: deviationBps <= toleranceBps ? 'both' : 'disagree', deviationBps };
}

/** Max age of an Atlas on-chain update before the feed counts as stale. Env ATLAS_MAX_AGE_SEC, default 3600. */
export function atlasMaxAgeSec(env: Record<string, string | undefined>): number {
  const n = Number(env.ATLAS_MAX_AGE_SEC);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/**
 * Like computeAgreement, but a feed whose on-chain update is older than maxAgeSec is marked stale and
 * reported as 'single' (never 'disagree'). atlasStale is only set when stale.
 */
export function markAgreement(
  cmcPrice: number,
  atlas: { price: number; ts: number } | undefined,
  toleranceBps: number,
  nowMs: number,
  maxAgeSec: number,
): Pick<PriceMark, 'agreement' | 'deviationBps' | 'atlasStale'> {
  if (atlas && nowMs - atlas.ts > maxAgeSec * 1000) {
    const dev = cmcPrice > 0 ? (Math.abs(cmcPrice - atlas.price) / cmcPrice) * 10_000 : undefined;
    return { agreement: 'single', ...(dev !== undefined ? { deviationBps: dev } : {}), atlasStale: true };
  }
  return computeAgreement(cmcPrice, atlas?.price, toleranceBps);
}
