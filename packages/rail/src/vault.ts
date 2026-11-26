import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  keccak256,
  maxUint256,
  parseUnits,
  toBytes,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Account,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex, RailParticipant, RailReceipt, RailState, SettlementRail } from '../../../shared/src/types.js';
import { deskVaultAbi, testUsdAbi } from '../../../contracts/src/vaultAbi.js';
import { normalizeAllocations, parseAmount, validateParticipants } from './amounts.js';

export type Env = Record<string, string | undefined>;

export const DECIMALS = 6;
export const BSC_TESTNET_CHAIN_ID = 97;
export const DEFAULT_TESTNET_RPC = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
export const TESTNET_EXPLORER = 'https://testnet.bscscan.com';
export const DEPLOYMENT_FILE = fileURLToPath(new URL('../../../contracts/deployments/bscTestnet-vault.json', import.meta.url));

/** Participant id -> bytes32, keccak256 of the UTF-8 id (same scheme as the Scorecard client). */
export const idToBytes32 = (id: string): Hex => keccak256(toBytes(id));

export interface VaultRailOptions {
  rpcUrl?: string;
  vault?: Hex;
  token?: Hex;
  /** Expected chain id. Defaults to 97 (BNB Smart Chain testnet). Tests pass 31337 for a local node. */
  chainId?: number;
  /** Explorer base for tx links, e.g. https://testnet.bscscan.com. Omit for a local node. */
  explorer?: string | null;
  confirmations?: number;
}

export interface TxInfo {
  kind: string;
  txHash: Hex;
  gasUsed: bigint;
  blockNumber: bigint;
  /** Wall time from building the transaction to the confirmed receipt, in ms. */
  ms: number;
}

function normKey(v: string | undefined, name: string): Hex {
  if (!v) throw new Error(`missing ${name} in .env`);
  const k = (v.trim().startsWith('0x') ? v.trim() : `0x${v.trim()}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex private key`);
  return k;
}

function readDeployment(): { vault?: Hex; token?: Hex } {
  if (!existsSync(DEPLOYMENT_FILE)) return {};
  try {
    const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8'));
    return { vault: d.vault?.address, token: d.token?.address };
  } catch {
    return {};
  }
}

/** True for nonce races caused by another sender using the same key. */
export function isNonceError(e: unknown): boolean {
  const text = [e instanceof BaseError ? e.details : '', e instanceof Error ? e.message : String(e)].join(' ').toLowerCase();
  return /nonce too low|nonce provided for the transaction .* is lower|already known|replacement transaction underpriced/.test(text);
}

/** Turns a viem error into one readable line, decoding the vault's custom errors. */
export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) {
      const args = (rev.data.args ?? []).map((a) => String(a)).join(', ');
      return `contract reverted with ${rev.data.errorName}(${args})`;
    }
    return e.shortMessage || e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Settlement rail backed by the DeskVault contract on BNB Smart Chain testnet, holding tUSD (a test token).
 * Every step is an on-chain transaction sent by the desk; every allocation change carries the risk
 * manager's EIP-712 signature, which the contract checks.
 *
 * CUSTODIAL DEMO: this one process holds both the desk key and the risk manager key. In production the
 * risk manager signs the typed data in its own process and returns only the signature to the desk.
 */
export class VaultRail implements SettlementRail {
  readonly name = 'bnb-testnet-vault' as const;
  readonly vault: Hex;
  readonly token: Hex;
  readonly chainId: number;
  readonly explorer: string | null;
  private readonly confirmations: number;
  private readonly desk: PrivateKeyAccount;
  private readonly risk: PrivateKeyAccount;
  private readonly pub: PublicClient<Transport, Chain>;
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private st: RailState | null = null;
  private order: RailParticipant[] = [];
  private roundId = 0n;
  private pot = 0n;
  private checked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly txLog: TxInfo[] = [];

  constructor(env: Env, opts: VaultRailOptions = {}) {
    this.desk = privateKeyToAccount(normKey(env.DESK_KEY, 'DESK_KEY'));
    this.risk = privateKeyToAccount(normKey(env.RISK_KEY, 'RISK_KEY'));
    const dep = readDeployment();
    const vault = opts.vault ?? (env.VAULT_ADDRESS?.trim() as Hex | undefined) ?? dep.vault;
    const token = opts.token ?? (env.TEST_USD_ADDRESS?.trim() as Hex | undefined) ?? dep.token;
    if (!vault || !/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error(`missing VAULT_ADDRESS (and none in ${DEPLOYMENT_FILE})`);
    if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error(`missing TEST_USD_ADDRESS (and none in ${DEPLOYMENT_FILE})`);
    this.vault = vault;
    this.token = token;
    this.chainId = opts.chainId ?? BSC_TESTNET_CHAIN_ID;
    if (this.chainId === 56) throw new Error('the vault rail never runs on BNB Chain mainnet (56)');
    this.explorer = opts.explorer === undefined ? TESTNET_EXPLORER : opts.explorer;
    this.confirmations = opts.confirmations ?? 1;
    const rpc = opts.rpcUrl ?? (env.BSC_TESTNET_RPC?.trim() || DEFAULT_TESTNET_RPC);
    const chain = defineChain({
      id: this.chainId,
      name: this.chainId === BSC_TESTNET_CHAIN_ID ? 'BNB Smart Chain Testnet' : `chain ${this.chainId}`,
      nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    this.pub = createPublicClient({ chain, transport: http(rpc, { timeout: 30_000, retryCount: 2 }) });
    this.wallet = createWalletClient({ account: this.desk, chain, transport: http(rpc, { timeout: 30_000, retryCount: 0 }) });
  }

  get deskAddress(): Hex {
    return this.desk.address;
  }

  get riskAddress(): Hex {
    return this.risk.address;
  }

  state(): RailState | null {
    return this.st ? { ...this.st, allocations: { ...this.st.allocations } } : null;
  }

  /** Every transaction this rail sent, with gas used and confirmation time. */
  txHistory(): TxInfo[] {
    return [...this.txLog];
  }

  open(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt> {
    return this.serial('open', () => this.doOpen(p));
  }

  reallocate(next: Record<string, string>, memo: string): Promise<RailReceipt> {
    return this.serial('reallocate', () => this.doUpdate('reallocate', next, memo));
  }

  close(final: Record<string, string>): Promise<RailReceipt> {
    return this.serial('close', () => this.doUpdate('close', final, 'final split paid out'));
  }

  /** Reads the vault's on-chain round state. */
  async onchain(): Promise<{ roundId: bigint; version: bigint; pot: bigint; open: boolean; ids: readonly Hex[]; payouts: readonly Hex[]; allocations: readonly bigint[] }> {
    const c = { address: this.vault, abi: deskVaultAbi } as const;
    const [roundId, version, pot, open, parts, allocations] = await Promise.all([
      this.pub.readContract({ ...c, functionName: 'currentRoundId' }),
      this.pub.readContract({ ...c, functionName: 'version' }),
      this.pub.readContract({ ...c, functionName: 'pot' }),
      this.pub.readContract({ ...c, functionName: 'roundOpen' }),
      this.pub.readContract({ ...c, functionName: 'participants' }),
      this.pub.readContract({ ...c, functionName: 'allocations' }),
    ]);
    return { roundId, version, pot, open, ids: parts[0], payouts: parts[1], allocations };
  }

  /**
   * Recovery helper: closes a round left open on-chain (for example after a crash), returning the whole
   * pot to the desk. Never called automatically; run it via `npm run vault:close-stale`.
   */
  closeStale(): Promise<{ roundId: bigint; receipt: TxInfo } | null> {
    return this.serial('close-stale', async () => {
      await this.preflight();
      const s = await this.onchain();
      if (!s.open) return null;
      const finalAlloc = s.allocations.map((_, i) => (i === 0 ? s.pot : 0n));
      const version = s.version + 1n;
      const sig = await this.signRisk('CloseRound', s.roundId, version, finalAlloc);
      const info = await this.send('close-stale', 'closeRound', [s.roundId, version, finalAlloc, sig]);
      if (this.st && this.st.status === 'open') this.st.status = 'closed';
      return { roundId: s.roundId, receipt: info };
    });
  }

  // ---------- internals ----------

  /**
   * Runs `fn` inside this rail's serialized queue, so it never overlaps a rail transaction. Use it for
   * any other transaction sent with the desk key (for example Scorecard calls). Errors pass through unchanged.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private serial<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn).catch((e: unknown) => {
      throw new Error(`[rail:${this.name}] ${op} failed: ${describeError(e)}`);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Checks chain id and that the configured keys match the vault's desk and risk manager. Once. */
  private async preflight(): Promise<void> {
    if (this.checked) return;
    const id = await this.pub.getChainId();
    if (id !== this.chainId) throw new Error(`RPC is on chain ${id}, expected ${this.chainId}`);
    const c = { address: this.vault, abi: deskVaultAbi } as const;
    const [desk, risk, token] = await Promise.all([
      this.pub.readContract({ ...c, functionName: 'desk' }),
      this.pub.readContract({ ...c, functionName: 'riskManager' }),
      this.pub.readContract({ ...c, functionName: 'token' }),
    ]);
    if (desk.toLowerCase() !== this.desk.address.toLowerCase()) throw new Error(`vault desk is ${desk}, but DESK_KEY is ${this.desk.address}`);
    if (risk.toLowerCase() !== this.risk.address.toLowerCase()) throw new Error(`vault risk manager is ${risk}, but RISK_KEY is ${this.risk.address}`);
    if (token.toLowerCase() !== this.token.toLowerCase()) throw new Error(`vault token is ${token}, but TEST_USD_ADDRESS is ${this.token}`);
    this.checked = true;
  }

  private async doOpen(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt> {
    if (this.st && this.st.status === 'open') throw new Error(`round ${this.roundId} is already open; close it first`);
    validateParticipants(p.participants);
    const amountDec = parseAmount(p.amount, 'amount');
    if (amountDec.decimalPlaces() > DECIMALS) throw new Error(`amount has more than ${DECIMALS} decimals`);
    const amount = parseUnits(p.amount.trim(), DECIMALS);
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    const desk = p.participants.find((x) => x.role === 'desk')!;
    if (desk.address.toLowerCase() !== this.desk.address.toLowerCase()) {
      throw new Error(`desk participant address ${desk.address} does not match DESK_KEY (${this.desk.address})`);
    }
    const order = [desk, ...p.participants.filter((x) => x !== desk)];

    await this.preflight();
    const s = await this.onchain();
    if (s.open) {
      throw new Error(
        `round ${s.roundId} is still open on-chain at version ${s.version} with pot ${formatUnits(s.pot, DECIMALS)} tUSD; ` +
          'run `npm run vault:close-stale` in packages/rail to return it to the desk, then open again',
      );
    }
    const bal = await this.pub.readContract({ address: this.token, abi: testUsdAbi, functionName: 'balanceOf', args: [this.desk.address] });
    if (bal < amount) throw new Error(`desk holds ${formatUnits(bal, DECIMALS)} tUSD, needs ${p.amount}`);
    const allowance = await this.pub.readContract({ address: this.token, abi: testUsdAbi, functionName: 'allowance', args: [this.desk.address, this.vault] });
    if (allowance < amount) await this.send('approve', 'approve', [this.vault, maxUint256], this.token);

    let roundId = s.roundId + 1n;
    while (await this.pub.readContract({ address: this.vault, abi: deskVaultAbi, functionName: 'roundUsed', args: [roundId] })) roundId += 1n;

    const info = await this.send('open', 'openRound', [roundId, order.map((x) => idToBytes32(x.id)), order.map((x) => x.address), amount]);
    this.order = order;
    this.roundId = roundId;
    this.pot = amount;
    const after = await this.onchain();
    this.st = {
      sessionId: `round-${roundId}`,
      version: Number(after.version),
      asset: 'tusd', // the vault always holds tUSD, whatever logical asset the desk config names
      allocations: this.toMap(after.allocations),
      status: 'open',
    };
    return this.receipt('open', info, `desk deposited ${p.amount} tUSD into DeskVault round ${roundId}`);
  }

  private async doUpdate(kind: 'reallocate' | 'close', next: Record<string, string>, memo: string): Promise<RailReceipt> {
    const st = this.st;
    if (!st) throw new Error('no round is open; call open() first');
    if (st.status !== 'open') throw new Error(`${st.sessionId} is closed`);
    const ids = this.order.map((x) => x.id);
    const target = normalizeAllocations(next, ids, parseAmount(formatUnits(this.pot, DECIMALS), 'pot'), DECIMALS);
    const arr = ids.map((id) => parseUnits(target[id]!.toFixed(), DECIMALS));
    const s = await this.onchain();
    if (!s.open || s.roundId !== this.roundId) throw new Error(`round ${this.roundId} is no longer open on-chain`);
    const version = s.version + 1n;
    const primary = kind === 'close' ? 'CloseRound' : 'Reallocate';
    const sig = await this.signRisk(primary, this.roundId, version, arr);
    const info =
      kind === 'close'
        ? await this.send('close', 'closeRound', [this.roundId, version, arr, sig])
        : await this.send('reallocate', 'reallocate', [this.roundId, version, arr, memo.slice(0, 280), sig]);
    const after = await this.onchain();
    st.version = Number(after.version);
    st.allocations = this.toMap(after.allocations);
    if (kind === 'close') st.status = 'closed';
    return this.receipt(kind, info, memo);
  }

  private signRisk(primaryType: 'Reallocate' | 'CloseRound', roundId: bigint, version: bigint, allocations: readonly bigint[]): Promise<Hex> {
    const fields = [
      { name: 'roundId', type: 'uint256' },
      { name: 'version', type: 'uint256' },
      { name: 'allocations', type: 'uint256[]' },
    ] as const;
    return this.risk.signTypedData({
      domain: { name: 'DeskVault', version: '1', chainId: this.chainId, verifyingContract: this.vault },
      types: primaryType === 'Reallocate' ? { Reallocate: fields } : { CloseRound: fields },
      primaryType,
      message: { roundId, version, allocations: [...allocations] },
    } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
  }

  /** Simulates (to surface revert reasons before spending gas), sends with an explicit nonce, waits for confirmation. */
  private async send(kind: string, functionName: string, args: readonly unknown[], address: Hex = this.vault): Promise<TxInfo> {
    const t0 = Date.now();
    const abi = address === this.vault ? deskVaultAbi : testUsdAbi;
    const { request } = await this.pub.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: this.desk,
    } as Parameters<typeof this.pub.simulateContract>[0]);
    // The desk key is shared with other senders (the Scorecard client), so never cache the nonce:
    // read the pending nonce fresh for every transaction, and retry nonce races with a fresh read.
    let hash: Hex;
    for (let attempt = 0; ; attempt++) {
      const nonce = await this.pub.getTransactionCount({ address: this.desk.address, blockTag: 'pending' });
      try {
        hash = await this.wallet.writeContract({ ...(request as Parameters<typeof this.wallet.writeContract>[0]), nonce });
        break;
      } catch (e) {
        if (attempt >= 2 || !isNonceError(e)) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    const rc = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: 120_000 });
    if (rc.status !== 'success') throw new Error(`${kind} transaction ${hash} reverted${this.explorer ? ` (${this.explorer}/tx/${hash})` : ''}`);
    const info: TxInfo = { kind, txHash: hash, gasUsed: rc.gasUsed, blockNumber: rc.blockNumber, ms: Date.now() - t0 };
    this.txLog.push(info);
    return info;
  }

  private toMap(allocs: readonly bigint[]): Record<string, string> {
    const out: Record<string, string> = {};
    this.order.forEach((x, i) => (out[x.id] = formatUnits(allocs[i] ?? 0n, DECIMALS)));
    return out;
  }

  private receipt(kind: RailReceipt['kind'], info: TxInfo, memo: string): RailReceipt {
    const st = this.st!;
    return {
      kind,
      rail: this.name,
      sessionId: st.sessionId,
      version: st.version,
      offchain: false,
      txHash: info.txHash,
      explorerUrl: this.explorer ? `${this.explorer}/tx/${info.txHash}` : undefined,
      memo,
      allocations: { ...st.allocations },
      ts: Date.now(),
    };
  }
}
