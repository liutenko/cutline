import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentId, ScorecardTx } from '../../shared/src/types.js';
import { scorecardAbi } from './abi.js';
import { chainFor, NETWORKS, type NetworkName } from './chains.js';

/** agentId string ('momentum') -> bytes32, via keccak256 of the UTF-8 string. */
export function agentIdToBytes32(id: AgentId | string): Hex {
  return keccak256(toBytes(id));
}

export interface AgentInput {
  agentId: AgentId | string;
  name: string;
  address: Hex;
  strategy: string;
}

export interface RoundResult {
  agentId: AgentId | string;
  pnlBps: number;
  status: 'evaluating' | 'funded' | 'cut';
}

export interface CloseRoundInput {
  roundId: number;
  results: RoundResult[];
  /** Hash of the final settlement allocation. */
  stateHash: Hex;
  feeds: Hex[];
  /** Price read off-chain for each feed, same order. Scaled by the caller (e.g. 8 decimals). */
  offchainPrices: bigint[];
}

export interface ScorecardRecord {
  roundsPlayed: number;
  roundsFunded: number;
  timesCut: number;
  cumulativePnlBps: bigint;
  bestPnlBps: bigint;
  lastRoundId: bigint;
}

export interface ScorecardClient {
  address: Hex;
  chainId: number;
  registerAgents(agents: AgentInput[]): Promise<Hex[]>;
  closeRound(input: CloseRoundInput): Promise<ScorecardTx>;
  getRecord(agentId: AgentId | string): Promise<ScorecardRecord>;
}

const STATUS = { evaluating: 0, funded: 1, cut: 2 } as const;

/**
 * Reads SCORECARD_ADDRESS, DESK_KEY, SCORECARD_NETWORK (bscTestnet | bsc, default bscTestnet)
 * and BSC_TESTNET_RPC / BSC_MAINNET_RPC. Returns null when SCORECARD_ADDRESS is empty,
 * so the engine can run without a chain.
 */
export function createScorecardClient(env: Record<string, string | undefined>): ScorecardClient | null {
  const address = env.SCORECARD_ADDRESS?.trim();
  if (!address) return null;
  const network = (env.SCORECARD_NETWORK?.trim() || 'bscTestnet') as NetworkName;
  const net = NETWORKS[network];
  if (!net) throw new Error(`Unknown SCORECARD_NETWORK "${network}"`);
  const rpc = env[net.rpcEnv]?.trim() || net.defaultRpc;
  const key = env.DESK_KEY?.trim();
  if (!key) throw new Error('DESK_KEY is required to write to the Scorecard');
  const chain = chainFor(network, rpc);
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const addr = address as Hex;

  async function send(fn: 'registerAgent' | 'closeRound', args: readonly unknown[]): Promise<Hex> {
    const { request } = await pub.simulateContract({ account, address: addr, abi: scorecardAbi, functionName: fn, args } as never);
    const hash = await wallet.writeContract(request as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${fn} reverted in ${hash}`);
    return hash;
  }

  return {
    address: addr,
    chainId: net.chainId,
    async registerAgents(agents) {
      const hashes: Hex[] = [];
      for (const a of agents) {
        hashes.push(await send('registerAgent', [agentIdToBytes32(a.agentId), a.name, a.address, a.strategy]));
      }
      return hashes;
    },
    async closeRound(i) {
      const hash = await send('closeRound', [
        BigInt(i.roundId),
        i.results.map((r) => agentIdToBytes32(r.agentId)),
        i.results.map((r) => BigInt(Math.round(r.pnlBps))),
        i.results.map((r) => STATUS[r.status]),
        i.stateHash,
        i.feeds,
        i.offchainPrices,
      ]);
      return { roundId: i.roundId, txHash: hash, explorerUrl: `${net.explorer}/tx/${hash}`, chainId: net.chainId };
    },
    async getRecord(agentId) {
      const r = (await pub.readContract({ address: addr, abi: scorecardAbi, functionName: 'getRecord', args: [agentIdToBytes32(agentId)] })) as ScorecardRecord;
      return { ...r };
    },
  };
}
