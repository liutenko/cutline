import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import {
  AppSessionWalletSignerV1,
  AppStateUpdateIntent,
  Client,
  EthereumMsgSigner,
  createSigners,
  isFinal,
  packAppStateUpdateV1,
  packCreateAppSessionRequestV1,
  withBlockchainRPC,
  type AppAllocationV1,
  type AppDefinitionV1,
  type AppSessionInfoV1,
  type AppStateUpdateV1,
  type Option,
} from '@yellow-org/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  Hex,
  RailName,
  RailParticipant,
  RailReceipt,
  RailState,
  SettlementRail,
} from '../../../shared/src/types.js';
import { fmt, normalizeAllocations, parseAmount, sum, toStrings, validateParticipants } from './amounts.js';

// Node 22 ships a global WebSocket; keep the polyfill for older runtimes, as the SDK examples do.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket: unknown }).WebSocket = WebSocket;
}

export type YellowRailName = Extract<RailName, 'yellow-sandbox' | 'yellow-mainnet'>;
export type Env = Record<string, string | undefined>;

/** Env var holding each participant's key. */
export const KEY_ENV: Record<string, string> = {
  desk: 'DESK_KEY',
  risk: 'RISK_KEY',
  momentum: 'AGENT_MOMENTUM_KEY',
  rwa: 'AGENT_RWA_KEY',
  event: 'AGENT_EVENT_KEY',
};

/** Mainnet guard: open() refuses to commit real funds unless this env var has this exact value. */
export const MAINNET_CONFIRM_ENV = 'YELLOW_MAINNET_CONFIRM';
export const MAINNET_CONFIRM_VALUE = 'real-funds';

export interface YellowNetworkConfig {
  rail: YellowRailName;
  wsUrl: string;
  /** Home chain for the desk's account (where on-chain funding and withdrawal happen). */
  chainId: bigint;
  rpcUrl?: string;
  /** Maps the desk's logical asset to the node's asset symbol. */
  assetSymbol: Record<'usdt' | 'usdc', string>;
  explorerTxBase?: string;
  applicationId: string;
}

export function networkConfig(name: YellowRailName, env: Env): YellowNetworkConfig {
  if (name === 'yellow-mainnet') {
    return {
      rail: name,
      wsUrl: env.YELLOW_WS_MAINNET || 'wss://nitronode.yellow.org/v1/ws',
      chainId: 56n, // BNB Chain. Production node lists usdt and usdc on chain 56.
      rpcUrl: env.BSC_MAINNET_RPC,
      assetSymbol: { usdt: 'usdt', usdc: 'usdc' },
      explorerTxBase: 'https://bscscan.com/tx/',
      applicationId: 'proving-ground',
    };
  }
  // The sandbox has no BNB testnet and no usdt/usdc. Its test stablecoin is yusd (faucet-funded, off-chain).
  const sandboxAsset = env.YELLOW_SANDBOX_ASSET || 'yusd';
  return {
    rail: name,
    wsUrl: env.YELLOW_WS_SANDBOX || 'wss://nitronode-sandbox.yellow.org/v1/ws',
    chainId: 11155111n, // Ethereum Sepolia, the suggested home chain for yusd on the sandbox
    assetSymbol: { usdt: sandboxAsset, usdc: sandboxAsset },
    explorerTxBase: 'https://sepolia.etherscan.io/tx/',
    applicationId: 'proving-ground',
  };
}

export function explorerTxUrl(cfg: YellowNetworkConfig, txHash: string): string | undefined {
  return cfg.explorerTxBase ? `${cfg.explorerTxBase}${txHash}` : undefined;
}

/**
 * Signature weights and quorum.
 *   desk = n+1, risk = n+1, each of the n agents = 1, quorum = 2(n+1).
 * For n = 3: desk 4, risk 4, agents 1 each, quorum 8 (total weight 11).
 *   desk + risk = 8            -> meets quorum: the desk and the risk manager together can reallocate.
 *   desk + all agents = 7      -> below quorum: nothing moves without the risk manager.
 *   risk + all agents = 7      -> below quorum: nothing moves without the desk.
 *   all agents = 3             -> below quorum: no agent, or group of agents, moves funds.
 * Agents cannot block their own cut. That is the intended regime: desk and risk manager are the trusted operator.
 */
export function weightsFor(participants: RailParticipant[]): { weights: Map<string, number>; quorum: number } {
  const n = participants.filter((p) => p.role === 'agent').length;
  const weights = new Map<string, number>();
  for (const p of participants) weights.set(p.id, p.role === 'agent' ? 1 : n + 1);
  return { weights, quorum: 2 * (n + 1) };
}

const CALL_TIMEOUT_MS = 30_000;

async function withTimeout<T>(p: Promise<T>, what: string, ms = CALL_TIMEOUT_MS): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function normKey(v: string | undefined, envName: string): Hex {
  if (!v) throw new Error(`missing ${envName} in .env`);
  const k = (v.startsWith('0x') ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${envName} is not a 32-byte hex private key`);
  return k;
}

interface Party {
  participant: RailParticipant;
  signer: AppSessionWalletSignerV1;
  weight: number;
}

/**
 * Settlement rail on Yellow Network app sessions (@yellow-org/sdk v1).
 *
 * CUSTODIAL DEMO: this single process holds all five keys (desk, risk manager, three agents) and
 * co-signs on their behalf. That is acceptable only as an explicitly custodial demo server.
 * In production each agent and the risk manager sign the packed state hash with their own key,
 * in their own process, and return only the signature to the submitter.
 */
export class YellowRail implements SettlementRail {
  readonly name: YellowRailName;
  readonly cfg: YellowNetworkConfig;
  private readonly env: Env;
  private readonly keys = new Map<string, Hex>();
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private st: RailState | null = null;
  private parties: Party[] = [];
  private quorum = 0;
  private nodeAsset = '';
  private decimals = 6;
  private total = new Decimal(0);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(name: YellowRailName, env: Env) {
    this.name = name;
    this.env = env;
    this.cfg = networkConfig(name, env);
    // Fail fast on missing keys, without ever echoing their values.
    // On mainnet a `<NAME>_MAINNET` key (for example DESK_KEY_MAINNET) takes precedence, so the hackathon
    // test keys never have to hold real funds.
    for (const [id, envName] of Object.entries(KEY_ENV)) {
      const mainnetName = `${envName}_MAINNET`;
      const useMainnet = name === 'yellow-mainnet' && !!env[mainnetName];
      this.keys.set(id, normKey(useMainnet ? env[mainnetName] : env[envName], useMainnet ? mainnetName : envName));
    }
    if (name === 'yellow-mainnet' && !this.cfg.rpcUrl) throw new Error('missing BSC_MAINNET_RPC in .env');
  }

  /** Address for a participant id, derived from the configured key. */
  addressOf(id: string): Hex {
    const k = this.keys.get(id);
    if (!k) throw new Error(`no key configured for participant "${id}"`);
    return privateKeyToAccount(k).address;
  }

  /** Participant list built from the configured keys, in the order desk, risk, agents. */
  defaultParticipants(): RailParticipant[] {
    return Object.keys(KEY_ENV).map((id) => ({
      id,
      role: id === 'desk' ? 'desk' : id === 'risk' ? 'risk' : 'agent',
      address: this.addressOf(id),
    }));
  }

  state(): RailState | null {
    return this.st ? { ...this.st, allocations: { ...this.st.allocations } } : null;
  }

  quorumInfo(): { quorum: number; weights: Record<string, number> } {
    return { quorum: this.quorum, weights: Object.fromEntries(this.parties.map((p) => [p.participant.id, p.weight])) };
  }

  /** Connects (once) as the desk, which is the submitter for every update. */
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      const opts: Option[] = [];
      if (this.cfg.rpcUrl) opts.push(withBlockchainRPC(this.cfg.chainId, this.cfg.rpcUrl));
      const s = createSigners(this.keys.get('desk')!);
      this.connecting = withTimeout(Client.create(this.cfg.wsUrl, s.stateSigner, s.txSigner, ...opts), 'connect')
        .then((c) => {
          this.client = c;
          return c;
        })
        .catch((e) => {
          this.connecting = null;
          throw e;
        });
    }
    return this.connecting;
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c) await c.close().catch(() => undefined);
  }

  /** Node-side balances for any address, by participant id. */
  async balances(ids: string[] = Object.keys(KEY_ENV)): Promise<Record<string, Record<string, string>>> {
    const c = await this.connect();
    const out: Record<string, Record<string, string>> = {};
    for (const id of ids) {
      const entries = await withTimeout(c.getBalances(this.addressOf(id)), 'getBalances');
      out[id] = Object.fromEntries(entries.map((e) => [e.asset, fmt(e.balance)]));
    }
    return out;
  }

  open(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt> {
    return this.serial('open', () => this.doOpen(p));
  }

  reallocate(next: Record<string, string>, memo: string): Promise<RailReceipt> {
    return this.serial('reallocate', () => this.doReallocate(next, memo));
  }

  close(final: Record<string, string>): Promise<RailReceipt> {
    return this.serial('close', () => this.doClose(final));
  }

  // ---------- internals ----------

  private serial<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[rail:${this.name}] ${op} failed: ${msg}`);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doOpen(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt> {
    if (this.st && this.st.status === 'open') throw new Error(`session ${this.st.sessionId} is already open; close it first`);
    if (this.name === 'yellow-mainnet' && this.env[MAINNET_CONFIRM_ENV] !== MAINNET_CONFIRM_VALUE) {
      throw new Error(`mainnet open commits real funds; set ${MAINNET_CONFIRM_ENV}=${MAINNET_CONFIRM_VALUE} to allow it`);
    }
    validateParticipants(p.participants);
    const symbol = this.cfg.assetSymbol[p.asset];
    if (!symbol) throw new Error(`unsupported asset "${String(p.asset)}"`);
    const amount = parseAmount(p.amount, 'amount');
    if (amount.lte(0)) throw new Error('amount must be greater than zero');

    // Match every participant to a key we hold, and check the address agrees with that key.
    const parties: Party[] = [];
    const { weights, quorum } = weightsFor(p.participants);
    for (const part of p.participants) {
      const keyId = part.role === 'desk' ? 'desk' : part.role === 'risk' ? 'risk' : part.id;
      const key = this.keys.get(keyId);
      if (!key) throw new Error(`no key configured for participant "${part.id}"`);
      const addr = privateKeyToAccount(key).address;
      if (addr.toLowerCase() !== part.address.toLowerCase()) {
        throw new Error(`participant "${part.id}" address ${part.address} does not match ${KEY_ENV[keyId]} (${addr})`);
      }
      parties.push({ participant: part, signer: new AppSessionWalletSignerV1(new EthereumMsgSigner(key)), weight: weights.get(part.id)! });
    }
    const desk = parties.find((x) => x.participant.role === 'desk')!;

    const c = await this.connect();
    const assets = await withTimeout(c.getAssets(), 'getAssets');
    const asset = assets.find((a) => a.symbol === symbol);
    if (!asset) throw new Error(`node at ${this.cfg.wsUrl} does not list asset "${symbol}"`);
    if (amount.decimalPlaces() > asset.decimals) throw new Error(`amount has more than ${asset.decimals} decimals`);

    // Only the desk deposits, so only the desk needs a funded account at Yellow.
    const bal = await withTimeout(c.getBalances(desk.participant.address), 'getBalances');
    const have = bal.find((b) => b.asset === symbol)?.balance ?? new Decimal(0);
    if (have.lt(amount)) {
      const how =
        this.name === 'yellow-sandbox'
          ? `request test funds: POST https://nitronode-sandbox.yellow.org/v1/faucet-app/requestTokens {"userAddress":"${desk.participant.address}"}`
          : 'fund it once on-chain (see packages/rail/scripts/fund-mainnet.md)';
      throw new Error(`desk ${desk.participant.address} holds ${fmt(have)} ${symbol} at Yellow, needs ${fmt(amount)}; ${how}`);
    }
    await this.ensureChannel(c, symbol);

    const definition: AppDefinitionV1 = {
      applicationId: this.cfg.applicationId,
      participants: parties.map((x) => ({ walletAddress: x.participant.address, signatureWeight: x.weight })),
      quorum,
      nonce: BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
    };
    const sessionData = JSON.stringify({ app: 'proving-ground', kind: 'open' });
    const createHash = packCreateAppSessionRequestV1(definition, sessionData);
    const operators = parties.filter((x) => x.participant.role !== 'agent'); // desk + risk = quorum
    const created = await withTimeout(
      c.createAppSession(definition, sessionData, await signAll(operators, createHash)),
      'createAppSession',
    );
    const sessionId = created.appSessionId;

    const deposit: AppStateUpdateV1 = {
      appSessionId: sessionId,
      intent: AppStateUpdateIntent.Deposit,
      version: BigInt(created.version) + 1n,
      allocations: [{ participant: desk.participant.address, asset: symbol, amount }],
      sessionData: JSON.stringify({ kind: 'deposit', from: 'desk' }),
    };
    const depHash = packAppStateUpdateV1(deposit);
    try {
      await withTimeout(
        c.submitAppSessionDeposit(deposit, await signAll(operators, depHash), symbol, amount),
        'submitAppSessionDeposit',
      );
    } catch (e) {
      throw new Error(`session ${sessionId} was created but the desk deposit failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    this.parties = parties;
    this.quorum = quorum;
    this.nodeAsset = symbol;
    this.decimals = asset.decimals;
    this.total = amount;
    const live = await this.readSession(c, sessionId);
    this.st = { sessionId, version: Number(live.version), asset: p.asset, allocations: this.toIdMap(live.allocations), status: 'open' };
    this.assertMatches(this.st.allocations, { [desk.participant.id]: fmt(amount) });
    return this.receipt('open', `desk deposited ${fmt(amount)} ${symbol}; quorum ${quorum}`);
  }

  private async doReallocate(next: Record<string, string>, memo: string): Promise<RailReceipt> {
    const st = this.requireOpen();
    const ids = this.parties.map((x) => x.participant.id);
    const target = normalizeAllocations(next, ids, this.total, this.decimals);
    const c = await this.connect();
    await this.operate(c, st.sessionId, target, memo);
    return this.receipt('reallocate', memo);
  }

  private async doClose(final: Record<string, string>): Promise<RailReceipt> {
    const st = this.requireOpen();
    const ids = this.parties.map((x) => x.participant.id);
    const target = normalizeAllocations(final, ids, this.total, this.decimals);
    const c = await this.connect();
    let memo = 'final split settled';
    if (!sameMap(toStrings(target), st.allocations)) {
      // Close must restate the current allocation exactly, so move to the final split first.
      await this.operate(c, st.sessionId, target, 'final split');
      memo = 'final split applied, then settled';
    }
    const live = await this.readSession(c, st.sessionId);
    const close: AppStateUpdateV1 = {
      appSessionId: st.sessionId,
      intent: AppStateUpdateIntent.Close,
      version: live.version + 1n,
      allocations: live.allocations,
      sessionData: JSON.stringify({ kind: 'close' }),
    };
    // Every participant co-signs the final split (desk + risk alone would already meet quorum).
    await withTimeout(c.submitAppState(close, await signAll(this.parties, packAppStateUpdateV1(close))), 'submitAppState(close)');
    const after = await this.readSession(c, st.sessionId);
    if (!after.isClosed) throw new Error(`node accepted close but session ${st.sessionId} is not closed (version ${after.version})`);
    st.version = Number(after.version);
    st.allocations = this.toIdMap(after.allocations.length ? after.allocations : live.allocations);
    st.status = 'closed';
    return this.receipt('close', memo);
  }

  private async operate(c: Client, sessionId: string, target: Record<string, Decimal>, memo: string): Promise<void> {
    const st = this.st!;
    const live = await this.readSession(c, sessionId);
    if (live.isClosed) throw new Error(`session ${sessionId} is closed on the node`);
    const current = this.toIdMap(live.allocations);
    // Restate every allocation that is non-zero now or after the update.
    const allocations: AppAllocationV1[] = [];
    for (const x of this.parties) {
      const id = x.participant.id;
      const now = new Decimal(current[id] ?? '0');
      const nxt = target[id]!;
      if (now.isZero() && nxt.isZero()) continue;
      allocations.push({ participant: x.participant.address, asset: this.nodeAsset, amount: nxt });
    }
    const update: AppStateUpdateV1 = {
      appSessionId: sessionId,
      intent: AppStateUpdateIntent.Operate,
      version: live.version + 1n,
      allocations,
      sessionData: JSON.stringify({ kind: 'reallocate', memo: memo.slice(0, 200) }),
    };
    const operators = this.parties.filter((x) => x.participant.role !== 'agent'); // desk + risk meet quorum
    await withTimeout(c.submitAppState(update, await signAll(operators, packAppStateUpdateV1(update))), 'submitAppState(operate)');
    const after = await this.readSession(c, sessionId);
    st.version = Number(after.version);
    st.allocations = this.toIdMap(after.allocations);
    this.assertMatches(st.allocations, toStrings(target));
  }

  private async ensureChannel(c: Client, symbol: string): Promise<void> {
    const wallet = c.getUserAddress();
    const state = await withTimeout(c.getLatestState(wallet, symbol, false), 'getLatestState');
    const open = state !== null && state.homeChannelId !== undefined && !isFinal(state) && !!state.userSig;
    if (open) return;
    if (this.name === 'yellow-mainnet') await withTimeout(c.setHomeBlockchain(symbol, this.cfg.chainId), 'setHomeBlockchain');
    await withTimeout(c.acknowledge(symbol), 'acknowledge');
  }

  private async readSession(c: Client, sessionId: string): Promise<AppSessionInfoV1> {
    const { sessions } = await withTimeout(c.getAppSessions({ appSessionId: sessionId }), 'getAppSessions');
    const s = sessions[0];
    if (!s) throw new Error(`session ${sessionId} not found on the node`);
    return s;
  }

  private toIdMap(allocs: AppAllocationV1[]): Record<string, string> {
    const byAddr = new Map(this.parties.map((x) => [x.participant.address.toLowerCase(), x.participant.id]));
    const out: Record<string, string> = {};
    for (const x of this.parties) out[x.participant.id] = '0';
    for (const a of allocs) {
      if (this.nodeAsset && a.asset !== this.nodeAsset) continue;
      const id = byAddr.get(a.participant.toLowerCase());
      if (!id) throw new Error(`node returned an allocation for unknown address ${a.participant}`);
      out[id] = fmt(new Decimal(out[id]!).plus(a.amount));
    }
    return out;
  }

  private assertMatches(actual: Record<string, string>, expected: Record<string, string>): void {
    for (const id of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
      const a = new Decimal(actual[id] ?? '0');
      const e = new Decimal(expected[id] ?? '0');
      if (!a.equals(e)) throw new Error(`node state disagrees for "${id}": node ${fmt(a)}, expected ${fmt(e)}`);
    }
    const s = sum(Object.values(actual).map((v) => new Decimal(v)));
    if (!s.equals(this.total)) throw new Error(`node total ${fmt(s)} differs from session total ${fmt(this.total)}`);
  }

  private requireOpen(): RailState {
    if (!this.st) throw new Error('no session is open; call open() first');
    if (this.st.status !== 'open') throw new Error(`session ${this.st.sessionId} is closed`);
    return this.st;
  }

  private receipt(kind: RailReceipt['kind'], memo?: string): RailReceipt {
    const st = this.st!;
    // Every app-session step is an off-chain state update co-signed to quorum and countersigned by the node.
    // On-chain transactions only happen when the desk funds or withdraws its account (see scripts/fund-mainnet.md).
    return {
      kind,
      rail: this.name,
      sessionId: st.sessionId,
      version: st.version,
      offchain: true,
      memo,
      allocations: { ...st.allocations },
      ts: Date.now(),
    };
  }
}

async function signAll(parties: Party[], hash: Hex): Promise<string[]> {
  return Promise.all(parties.map((x) => x.signer.signMessage(hash)));
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!new Decimal(a[k] ?? '0').equals(new Decimal(b[k] ?? '0'))) return false;
  }
  return true;
}
