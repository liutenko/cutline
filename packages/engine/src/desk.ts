// The desk: round loop, risk gate, paper fills, cuts, funding and settlement.
import { EventEmitter } from 'node:events';
import { keccak256, toBytes, type Hex } from 'viem';
import type {
  AgentAccount,
  AgentId,
  ControlAction,
  DataProvider,
  DeskConfig,
  DeskEvent,
  DeskState,
  Instrument,
  MarketSnapshot,
  RailName,
  RailParticipant,
  RailReceipt,
  ScorecardTx,
  SettlementRail,
  Sym,
} from '../../../shared/src/types.ts';
import { closeAllPositions, DEFAULT_POOL_FEE_PCT, fillOrder, markAccount, newAccount, sampleEquity } from './broker.ts';
import { checkBreach, eventMultiplier, evaluateOrder } from './risk.ts';
import { canonicalJson, floatToUnits, fromUnits, scalePrice, toUnits } from './money.ts';
import type { Brain, BrainContext } from './agents/types.ts';
import { createRuleBrain, type RuleBrainOptions } from './agents/RuleBrain.ts';
import type { OnchainLink } from './onchain.ts';

export const EVENT_CAP = 200;
/** Local rail: reallocate when a funded agent's real equity drifts by more than 0.01 of the asset. */
const DRIFT_UNITS = 10_000n;

/** Engine settings on top of the shared DeskConfig. On-chain rail pacing defaults: 10 ticks, 0.02 of the asset. */
export type DeskEngineConfig = DeskConfig & { reallocMinTicks?: number; reallocMinDrift?: number };

/**
 * One queued desk-key transaction. Rail ops carry the full target allocation; 'scorecard' ops run a
 * Scorecard call in the same queue, so only one desk-key transaction is ever in flight.
 */
interface RailOp {
  kind: 'fund' | 'cut' | 'drift' | 'close' | 'scorecard';
  alloc: Record<string, bigint>;
  memo: string;
  rail: SettlementRail | null;
  gen: number;
  run?: () => Promise<unknown>;
  done: (r: { ok: boolean; value?: unknown; error?: unknown }) => void;
}

/** The vault rail exposes its own transaction queue; Scorecard calls run inside it when present. */
type ExclusiveRail = SettlementRail & { runExclusive?: <T>(fn: () => Promise<T>) => Promise<T> };

/** Display label for the pot asset: the vault rail always holds tUSD (a test token). */
export function assetLabel(railName: RailName, asset: string): string {
  return railName === 'bnb-testnet-vault' ? 'tUSD' : asset.toUpperCase();
}

export interface AgentSpec {
  agentId: AgentId;
  name: string;
  strategy: string;
  address: Hex;
}

/** The subset of the contracts' ScorecardClient the desk uses. */
export interface ScorecardPort {
  registerAgents?(agents: { agentId: string; name: string; address: Hex; strategy: string }[]): Promise<unknown>;
  /** Reads one agent's registration (Scorecard.getAgent). Used to skip registerAgents when nothing changed. */
  readAgent?(agentId: string): Promise<{ name: string; address: string; strategy: string; exists: boolean }>;
  closeRound(input: {
    roundId: number;
    results: { agentId: string; pnlBps: number; status: 'evaluating' | 'funded' | 'cut' }[];
    stateHash: Hex;
    feeds: Hex[];
    offchainPrices: bigint[];
  }): Promise<ScorecardTx>;
}

/** Engine-only control actions, accepted by the server in addition to the shared ControlAction. */
export type EngineControl = ControlAction;

export interface DeskDeps {
  provider: DataProvider;
  /** Creates a fresh rail for each round. */
  railFactory: () => SettlementRail;
  railName: RailName;
  agents: AgentSpec[];
  deskAddress: Hex;
  riskAddress: Hex;
  config: DeskEngineConfig;
  mode: 'live' | 'replay' | 'dev';
  scorecard?: ScorecardPort | null;
  /** Rule brain tuning (band, rebalance, re-entry). */
  brainOptions?: Partial<RuleBrainOptions>;
  /** LLM call counters for the dashboard, when the LLM layer is on. */
  llmStats?: () => { calls: number; cap: number; active: boolean };
  /** Links to on-chain transactions for the dashboard. */
  onchainLinks?: () => OnchainLink[];
  /** Optional brain overrides (e.g. LlmBrain). Missing ones default to the rule brain. */
  brains?: Partial<Record<AgentId, Brain>>;
  /** Atlas feeds the Scorecard reads at close, by symbol (SCORECARD_FEEDS). Sent in symbol order. */
  scorecardFeeds?: Record<string, Hex>;
  now?: () => number;
  /** Tests: do not schedule ticks on a timer; the caller drives tick(). */
  manual?: boolean;
}

export const DEFAULT_AGENTS: Omit<AgentSpec, 'address'>[] = [
  { agentId: 'momentum', name: 'Momentum', strategy: 'Buys the BNB Chain major with the best 1h and 24h change; exits on reversal.' },
  { agentId: 'rwa', name: 'RWA Rotator', strategy: 'Rotates into tokenized gold and treasuries when fear is high or event risk rises; back to cash otherwise.' },
  { agentId: 'event', name: 'Event Trader', strategy: 'Trades the gap between Cournot probabilities and venue prices: adds BNB on underpriced good news, cuts to cash on underpriced bad news.' },
];

type Phase = DeskState['round']['phase'];

export class Desk extends EventEmitter {
  private d: DeskDeps;
  private cfg: DeskEngineConfig;
  private instruments: Instrument[];
  private brains = new Map<AgentId, Brain>();
  private accounts: AgentAccount[] = [];
  private fundedPaperEquity = new Map<AgentId, number>();
  private rail: SettlementRail | null = null;
  /** Last allocation confirmed by the rail. */
  private alloc: Record<string, bigint> = {};
  /** The desk's intended allocation: confirmed plus everything queued. Funding, cuts and drift build on it. */
  private target: Record<string, bigint> = {};
  private railOps: RailOp[] = [];
  private railBusy = false;
  /** Bumped on reset so a late receipt never lands on a newer round. */
  private railGen = 0;
  private railError: string | null = null;
  private railIdleWaiters: (() => void)[] = [];
  private lastDriftTick = 0;
  private receipts: RailReceipt[] = [];
  private scorecards: ScorecardTx[] = [];
  private events: DeskEvent[] = [];
  private shocks = new Map<Sym, number>();
  private snapshot: MarketSnapshot | null = null;
  /** Last snapshot as received, before any synthetic shock. */
  private rawSnapshot: MarketSnapshot | null = null;
  private multiplier = 1;
  private budgetEmitted = false;
  private running = false;
  private round = { id: 0, tick: 0, phase: 'idle' as Phase, startedAt: null as number | null };
  private queue: Promise<unknown> = Promise.resolve();
  private loopGen = 0;
  private timer: NodeJS.Timeout | null = null;
  private registered = false;
  private now: () => number;
  private lastNote = new Map<AgentId, string>();
  private fillCount = new Map<AgentId, number>();
  private rejectCount = new Map<AgentId, number>();
  private paidUnits = 0n;
  private lossUnits = 0n;
  private warnedNoEvents = false;

  private get asset(): string {
    return assetLabel(this.d.railName, this.cfg.asset);
  }

  private get fee(): number {
    return this.cfg.poolFeePct ?? DEFAULT_POOL_FEE_PCT;
  }

  constructor(deps: DeskDeps) {
    super();
    this.setMaxListeners(100);
    this.d = deps;
    this.cfg = deps.config;
    this.instruments = deps.provider.instruments();
    this.now = deps.now ?? Date.now;
    this.resetAccounts();
  }

  // ---------- public API ----------

  state(): DeskState {
    return {
      mode: this.d.mode,
      rail: this.d.railName,
      running: this.running,
      round: { ...this.round },
      config: this.cfg,
      eventMultiplier: this.multiplier,
      agents: this.accounts.map((a) => ({ ...a, positions: a.positions.map((p) => ({ ...p })), equityHistory: [...(a.equityHistory ?? [])] })),
      snapshot: this.snapshot,
      railState: this.rail?.state() ?? null,
      railPending: this.railOps.length + (this.railBusy ? 1 : 0),
      receipts: [...this.receipts],
      scorecards: [...this.scorecards],
      events: [...this.events],
      onchainLinks: this.d.onchainLinks?.() ?? [],
      economics: this.economics(),
      llm: this.d.llmStats?.(),
    };
  }

  /** Desk economics in real asset units. */
  private economics(): NonNullable<DeskState['economics']> {
    let funded = 0n;
    // After settlement nothing is allocated any more; the close allocations are the payouts.
    if (this.round.phase !== 'settled') for (const a of this.accounts) if (a.status === 'funded') funded += this.alloc[a.agentId] ?? 0n;
    const ddPpm = BigInt(Math.round(this.cfg.maxDrawdownPct * 10_000));
    return {
      fundedAllocations: fromUnits(funded),
      capitalAtRisk: fromUnits((funded * ddPpm) / 1_000_000n),
      paidToAgents: fromUnits(this.paidUnits),
      lossesAbsorbed: fromUnits(this.lossUnits),
    };
  }

  /** Runs a control action. Serialized with ticks so state never interleaves. */
  control(a: EngineControl): Promise<void> {
    return this.serial(() => this.doControl(a));
  }

  /** One tick of the round. Public for tests; the loop calls it on a timer. */
  tick(): Promise<void> {
    return this.serial(() => this.doTick());
  }

  /** Emits a log event from outside the desk (e.g. the LLM gate). */
  logEvent(level: 'info' | 'warn' | 'error', message: string): void {
    this.log(level, message);
  }

  /** Resolves once no rail transaction is queued or awaiting confirmation. */
  whenRailIdle(): Promise<void> {
    if (!this.railBusy && !this.railOps.length) return Promise.resolve();
    return new Promise((res) => this.railIdleWaiters.push(res));
  }

  /** Stops timers. */
  dispose(): void {
    this.running = false;
    this.loopGen++;
    if (this.timer) clearTimeout(this.timer);
  }

  // ---------- internals ----------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private emitEvent(e: DeskEvent): void {
    this.events.push(e);
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    this.emit('event', e);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emitEvent({ type: 'log', ts: this.now(), level, message });
  }

  private resetAccounts(): void {
    this.accounts = this.d.agents.map((s) => newAccount(s, this.cfg));
    this.brains.clear();
    for (const s of this.d.agents) this.brains.set(s.agentId, this.d.brains?.[s.agentId] ?? createRuleBrain(s.agentId, this.d.brainOptions));
    this.fundedPaperEquity.clear();
    this.fillCount.clear();
    this.rejectCount.clear();
  }

  private participants(): RailParticipant[] {
    return [
      { id: 'desk', role: 'desk', address: this.d.deskAddress },
      { id: 'risk', role: 'risk', address: this.d.riskAddress },
      ...this.d.agents.map((a) => ({ id: a.agentId, role: 'agent' as const, address: a.address })),
    ];
  }

  private get potUnits(): bigint {
    return toUnits(this.cfg.realPot);
  }

  private allocStrings(m: Record<string, bigint> = this.alloc): Record<string, string> {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) o[k] = fromUnits(v);
    return o;
  }

  private assertConserved(m: Record<string, bigint>): void {
    let s = 0n;
    for (const v of Object.values(m)) {
      if (v < 0n) throw new Error(`Allocation below zero: ${JSON.stringify(this.allocStrings(m))}`);
      s += v;
    }
    if (s !== this.potUnits) throw new Error(`Allocations sum to ${fromUnits(s)}, pot is ${this.cfg.realPot}`);
  }

  /** Real equity of a funded agent, in asset units: principal plus scaled paper P&L since funding. */
  private realEquityUnits(a: AgentAccount): bigint {
    const fundedAt = this.fundedPaperEquity.get(a.agentId);
    if (fundedAt === undefined) return 0n;
    const scale = Number(this.cfg.realAllocationPerAgent) / this.cfg.paperAccountUsd;
    const u = toUnits(this.cfg.realAllocationPerAgent) + floatToUnits((a.equityUsd - fundedAt) * scale);
    return u > 0n ? u : 0n;
  }

  /** Builds a conserving allocation: agents as given, risk 0, desk takes the remainder (never below zero). */
  private buildAlloc(agentUnits: Partial<Record<AgentId, bigint>>): Record<string, bigint> {
    const m: Record<string, bigint> = { desk: 0n, risk: 0n };
    for (const a of this.d.agents) m[a.agentId] = agentUnits[a.agentId] ?? 0n;
    let others = 0n;
    for (const a of this.d.agents) others += m[a.agentId];
    // If agents' gains ever exceed the desk's remainder, trim the largest allocation so the total is conserved.
    while (others > this.potUnits) {
      const top = this.d.agents.reduce((x, y) => (m[y.agentId] > m[x.agentId] ? y : x));
      const cut = others - this.potUnits;
      const take = cut < m[top.agentId] ? cut : m[top.agentId];
      m[top.agentId] -= take;
      others -= take;
    }
    m.desk = this.potUnits - others;
    this.assertConserved(m);
    return m;
  }

  /** Agent allocations the desk intends, including queued transactions. */
  private currentAgentUnits(): Partial<Record<AgentId, bigint>> {
    const o: Partial<Record<AgentId, bigint>> = {};
    for (const a of this.d.agents) o[a.agentId] = this.target[a.agentId] ?? 0n;
    return o;
  }

  private applyReceipt(r: RailReceipt): void {
    const m: Record<string, bigint> = {};
    for (const [k, v] of Object.entries(r.allocations)) m[k] = toUnits(v);
    this.assertConserved(m);
    this.alloc = m;
    if (r.kind === 'open' || r.kind === 'close') this.target = { ...m };
    this.receipts.push(r);
    for (const a of this.accounts) a.realAllocation = fromUnits(m[a.agentId] ?? 0n);
    this.emitEvent({ type: 'rail', ts: this.now(), receipt: r });
  }

  // ---------- rail queue ----------
  // One serialized queue of rail transactions, so an on-chain confirmation never stalls the tick loop.
  // Funding, cuts and the close are always sent, in order. A drift update not yet sent is superseded by
  // any newer op, because every op carries the full target allocation.

  /** Queues a rail transaction. Resolves true once its receipt is applied, false if it failed or was dropped. */
  private enqueueRail(kind: Exclude<RailOp['kind'], 'scorecard'>, alloc: Record<string, bigint>, memo: string): Promise<boolean> {
    if (!this.rail || this.railError) return Promise.resolve(false);
    for (const op of this.railOps.filter((x) => x.kind === 'drift')) op.done({ ok: true });
    this.railOps = this.railOps.filter((x) => x.kind !== 'drift');
    if (kind !== 'close') this.target = { ...alloc };
    return new Promise<boolean>((resolve) => {
      this.railOps.push({ kind, alloc, memo, rail: this.rail, gen: this.railGen, done: (r) => resolve(r.ok) });
      this.pumpRail();
    });
  }

  /**
   * Queues a Scorecard transaction behind every rail op already queued. Its failure is logged by the
   * caller and never halts the desk. It does not supersede queued drift updates (it carries no allocation).
   */
  private enqueueTx<T>(memo: string, run: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: unknown }> {
    return new Promise((resolve) => {
      this.railOps.push({
        kind: 'scorecard', alloc: {}, memo, rail: this.rail, gen: this.railGen, run,
        done: (r) => resolve(r as { ok: boolean; value?: T; error?: unknown }),
      });
      this.pumpRail();
    });
  }

  private pumpRail(): void {
    if (this.railBusy) return;
    const op = this.railOps.shift();
    if (!op) {
      const w = this.railIdleWaiters;
      this.railIdleWaiters = [];
      for (const f of w) f();
      return;
    }
    this.railBusy = true;
    if (op.kind === 'scorecard') {
      const rail = op.rail as ExclusiveRail | null;
      Promise.resolve()
        .then(() => (rail?.runExclusive ? rail.runExclusive(op.run!) : op.run!()))
        .then(
          (value) => op.done({ ok: op.gen === this.railGen, value }),
          (error) => op.done({ ok: false, error }),
        )
        .finally(() => {
          this.railBusy = false;
          this.pumpRail();
        });
      return;
    }
    const strs = this.allocStrings(op.alloc);
    const rail = op.rail!; // rail ops are only queued while a rail exists
    Promise.resolve()
      .then(() => (op.kind === 'close' ? rail.close(strs) : rail.reallocate(strs, op.memo)))
      .then(
        (r) => {
          if (op.gen !== this.railGen) return op.done({ ok: false });
          this.applyReceipt(r);
          op.done({ ok: true });
        },
        (e) => {
          if (op.gen === this.railGen) this.railFailed(op, e);
          op.done({ ok: false, error: e });
        },
      )
      .catch((e) => {
        this.log('error', `Rail receipt could not be applied: ${errMsg(e)}`);
        op.done({ ok: false, error: e });
      })
      .finally(() => {
        this.railBusy = false;
        this.pumpRail();
      });
  }

  /** A failed rail transaction is loud: the desk pauses, queued ops are dropped, and only a reset clears it. */
  private railFailed(op: RailOp, e: unknown): void {
    this.railError = `${op.kind === 'close' ? 'Rail close' : 'Rail reallocation'} failed (${op.memo}): ${errMsg(e)}`;
    this.dropRailOps();
    this.running = false;
    this.loopGen++;
    if (this.timer) clearTimeout(this.timer);
    this.log('error', `${this.railError} The desk is paused; reset the desk to clear it.`);
  }

  private dropRailOps(): void {
    const ops = this.railOps;
    this.railOps = [];
    for (const op of ops) op.done({ ok: false });
  }

  private async doControl(a: EngineControl): Promise<void> {
    switch (a.action) {
      case 'start':
        if (this.railError) throw new Error(`The rail is halted: ${this.railError} Reset the desk first.`);
        if (this.round.phase === 'settled') this.doReset();
        if (this.round.phase === 'idle') await this.openRound();
        if (this.round.phase === 'idle') return; // open failed
        this.running = true;
        if (!this.d.manual) this.startLoop();
        return;
      case 'pause':
        this.running = false;
        this.loopGen++;
        if (this.timer) clearTimeout(this.timer);
        this.log('info', 'Desk paused.');
        return;
      case 'reset':
        await this.doResetWithRail();
        return;
      case 'rogue': {
        const acc = this.accounts.find((x) => x.agentId === a.agentId);
        if (!acc) throw new Error(`Unknown agent ${a.agentId}`);
        acc.rogue = !acc.rogue;
        this.log('warn', acc.rogue ? `${acc.name} switched to rogue mode (demo control).` : `${acc.name} left rogue mode.`);
        return;
      }
      case 'shock': {
        if (!Number.isFinite(a.pct) || a.pct <= -100) throw new Error('shock pct must be a number above -100');
        if (!this.instruments.some((i) => i.symbol === a.symbol)) throw new Error(`Unknown symbol ${a.symbol}`);
        const f = (this.shocks.get(a.symbol) ?? 1) * (1 + a.pct / 100);
        this.shocks.set(a.symbol, f);
        this.emitEvent({ type: 'shock', ts: this.now(), symbol: a.symbol, pct: a.pct });
        this.log('warn', `Stress test: ${a.symbol} marks moved ${a.pct > 0 ? '+' : ''}${a.pct}% (simulated, labeled synthetic).`);
        if (this.snapshot) {
          // Re-mark immediately so the cut happens on the shocked price, not one tick later.
          this.snapshot = this.applyShocks(this.snapshot, new Map([[a.symbol, 1 + a.pct / 100]]));
          await this.markAndEnforce();
        }
        return;
      }
      case 'close-round':
        await this.closeRound();
        return;
      default:
        throw new Error(`Unknown action ${(a as { action: string }).action}`);
    }
  }

  private doReset(): void {
    this.dispose();
    this.round = { id: 0, tick: 0, phase: 'idle', startedAt: null };
    this.resetAccounts();
    this.lastNote.clear();
    this.paidUnits = 0n;
    this.lossUnits = 0n;
    this.railGen++;
    this.dropRailOps();
    this.railError = null;
    this.lastDriftTick = 0;
    this.rail = null;
    this.alloc = {};
    this.target = {};
    this.receipts = [];
    this.shocks.clear();
    this.multiplier = 1;
    this.budgetEmitted = false;
    this.snapshot = null;
    this.log('info', 'Desk reset. New round ready.');
  }

  private async doResetWithRail(): Promise<void> {
    // Return everything to the desk before dropping an open session. Queued ops are moot: the close
    // returns everything; wait only for a transaction already in flight.
    this.dropRailOps();
    await this.whenRailIdle();
    if (this.rail?.state()?.status === 'open') {
      try {
        const final = this.buildAlloc({});
        const r = await this.rail.close(this.allocStrings(final));
        this.applyReceipt(r);
      } catch (e) {
        this.log('error', `Could not close the rail session on reset: ${errMsg(e)}`);
      }
    }
    this.doReset();
  }

  private async openRound(): Promise<void> {
    const startedAt = this.now();
    this.round = { id: Math.floor(startedAt / 1000), tick: 0, phase: 'idle', startedAt };
    try {
      this.rail = this.d.railFactory();
      const r = await this.rail.open({ participants: this.participants(), asset: this.cfg.asset, amount: this.cfg.realPot });
      this.applyReceipt(r);
      this.lastDriftTick = 0;
    } catch (e) {
      this.rail = null;
      this.log('error', `Could not open the settlement session: ${errMsg(e)}`);
      return;
    }
    this.round.phase = 'evaluation';
    this.log('info', `Round ${this.round.id} opened: ${this.cfg.realPot} ${this.asset} pot, ${this.d.agents.length} agents in evaluation for ${this.cfg.evalTicks} ticks.`);
    if (this.d.scorecard?.registerAgents && !this.registered) {
      // Queued behind the open receipt, so it never races a rail transaction for the desk key's nonce.
      this.registered = true;
      void this.registerAgents();
    }
  }

  /** Registers agents on the Scorecard once per contract: skipped when the contract already has them as configured. */
  private async registerAgents(): Promise<void> {
    const sc = this.d.scorecard!;
    const specs = this.d.agents.map((a) => ({ agentId: a.agentId, name: a.name, address: a.address, strategy: a.strategy }));
    const r = await this.enqueueTx('Scorecard agent registration', async () => {
      let todo = specs;
      if (sc.readAgent) {
        const onchain = await Promise.all(specs.map((a) => sc.readAgent!(a.agentId)));
        todo = specs.filter((a, i) => {
          const x = onchain[i];
          return !x.exists || x.name !== a.name || x.strategy !== a.strategy || x.address.toLowerCase() !== a.address.toLowerCase();
        });
      }
      if (todo.length) await sc.registerAgents!(todo);
      return todo.length;
    });
    if (r.ok) {
      this.log('info', r.value ? `Agents registered on the Scorecard contract (${r.value} of ${specs.length}).` : 'Agents already registered on the Scorecard contract; no transaction sent.');
    } else {
      this.registered = false; // try again at the next round start
      if (r.error) this.log('warn', `Scorecard agent registration failed: ${errMsg(r.error)}`);
    }
  }

  private startLoop(): void {
    const gen = ++this.loopGen;
    if (this.timer) clearTimeout(this.timer);
    const run = async () => {
      if (gen !== this.loopGen || !this.running) return;
      try {
        await this.tick();
      } catch (e) {
        this.log('error', `Tick failed: ${errMsg(e)}`);
      }
      if (gen !== this.loopGen || !this.running) return;
      this.timer = setTimeout(run, this.cfg.tickMs);
    };
    this.timer = setTimeout(run, 0);
  }

  private applyShocks(s: MarketSnapshot, shocks: Map<Sym, number>): MarketSnapshot {
    if (!shocks.size) return s;
    const marks = { ...s.marks };
    for (const [sym, f] of shocks) {
      const m = marks[sym];
      if (!m) continue;
      marks[sym] = {
        ...m,
        cmcPrice: m.cmcPrice * f,
        atlasPrice: m.atlasPrice !== undefined ? m.atlasPrice * f : undefined,
        synthetic: true,
      };
    }
    return { ...s, marks };
  }

  private ctxFor(a: AgentAccount, s: MarketSnapshot): BrainContext {
    return {
      tick: this.round.tick,
      snapshot: s,
      account: a,
      instruments: this.instruments,
      config: this.cfg,
      eventMultiplier: this.multiplier,
      rogue: !!a.rogue,
      note: (m: string) => {
        if (this.lastNote.get(a.agentId) === m) return;
        this.lastNote.set(a.agentId, m);
        this.log('info', m);
      },
    };
  }

  private async doTick(): Promise<void> {
    if (this.round.phase !== 'evaluation' && this.round.phase !== 'funded') return;
    const raw = await this.d.provider.snapshot();
    this.rawSnapshot = raw;
    const s = this.applyShocks(raw, this.shocks);
    this.snapshot = s;
    this.round.tick++;
    const ts = this.now();
    this.emitEvent({ type: 'tick', ts, tick: this.round.tick });

    if (this.d.mode === 'live' && !s.eventRisk.length && !this.warnedNoEvents) {
      this.warnedNoEvents = true;
      this.log('warn', 'No Cournot event risk loaded: check COURNOT_CACHE_TTL_MS. Risk budgets run at 100% until a claim is loaded.');
    }
    // Event-risk multiplier, shared by every agent.
    const em = eventMultiplier(s.eventRisk, this.cfg);
    if (!this.budgetEmitted || em.multiplier !== this.multiplier) {
      this.multiplier = em.multiplier;
      this.budgetEmitted = true;
      this.emitEvent({ type: 'budget', ts, multiplier: em.multiplier, reason: em.reason });
    }

    for (const a of this.accounts) markAccount(a, s, this.cfg, this.multiplier);

    // Agents propose in parallel (LLM latency), then orders are gated and filled one by one.
    const active = this.accounts.filter((a) => a.status !== 'cut');
    const proposals = await Promise.all(
      active.map(async (a) => {
        try {
          return { a, orders: await this.brains.get(a.agentId)!.propose(this.ctxFor(a, s)) };
        } catch (e) {
          this.log('warn', `${a.name} brain failed: ${errMsg(e)}`);
          return { a, orders: [] };
        }
      }),
    );
    for (const { a, orders } of proposals) {
      for (const o of orders) {
        this.emitEvent({ type: 'order', ts: this.now(), order: o });
        const decision = evaluateOrder(o, {
          account: a,
          snapshot: s,
          instruments: this.instruments,
          config: this.cfg,
          eventMultiplier: this.multiplier,
        });
        this.emitEvent({ type: 'decision', ts: this.now(), order: o, decision });
        if (!decision.approved) {
          this.rejectCount.set(a.agentId, (this.rejectCount.get(a.agentId) ?? 0) + 1);
          const why = decision.checks.find((c) => !c.pass)?.detail;
          continue;
        }
        const f = fillOrder(a, o, s, this.fee);
        if (f) {
          this.fillCount.set(a.agentId, (this.fillCount.get(a.agentId) ?? 0) + 1);
          this.emitEvent({ type: 'fill', ts: this.now(), fill: f });
          markAccount(a, s, this.cfg, this.multiplier);
        }
      }
    }

    await this.markAndEnforce();

    // Funding: after evalTicks, an agent with enough fills, no breach and P&L (after costs) at or above the bar.
    if (this.round.tick >= this.cfg.evalTicks) {
      if (this.round.phase === 'evaluation') this.round.phase = 'funded';
      const ready = this.accounts.filter((a) => a.status === 'evaluating' && this.evalCheck(a) === null);
      if (ready.length) this.fund(ready);
      for (const a of this.accounts) a.evalNote = a.status === 'evaluating' ? this.evalCheck(a) ?? undefined : undefined;
    }

    this.reallocateOnDrift();
    for (const a of this.accounts) sampleEquity(a);
  }

  /** Why an evaluating agent is not funded yet, or null if it passes. */
  private evalCheck(a: AgentAccount): string | null {
    const minTrades = (this.cfg.evalMinTrades ?? 2);
    const minPnl = this.cfg.evalMinPnlPct ?? -0.5;
    const n = this.fillCount.get(a.agentId) ?? 0;
    const why: string[] = [];
    if (n < minTrades) why.push(`Needs ${minTrades} trades; has ${n}`);
    if (a.pnlPct < minPnl) why.push(`P&L ${a.pnlPct.toFixed(2)}% is below the ${minPnl}% bar`);
    return why.length ? why.join('. ') + '.' : null;
  }

  /** Marks every account, cuts breaches. Used by ticks and by shocks. */
  private async markAndEnforce(): Promise<void> {
    const s = this.snapshot;
    if (!s) return;
    for (const a of this.accounts) markAccount(a, s, this.cfg, this.multiplier);
    for (const a of this.accounts) {
      if (a.status === 'cut') continue;
      const b = checkBreach(a, this.cfg);
      if (b) this.cut(a, b.reason);
    }
  }

  /** Cuts an agent now; a funded agent's cut is queued as its own rail reallocation. */
  private cut(a: AgentAccount, reason: string): void {
    const s = this.snapshot!;
    const wasFunded = a.status === 'funded';
    const fills = closeAllPositions(a, s, `cut-t${this.round.tick}`, this.fee);
    for (const f of fills) this.emitEvent({ type: 'fill', ts: this.now(), fill: f });
    markAccount(a, s, this.cfg, this.multiplier);
    a.status = 'cut';
    a.cutReason = reason;
    this.emitEvent({ type: 'cut', ts: this.now(), agentId: a.agentId, reason });
    if (wasFunded) {
      const real = this.realEquityUnits(a);
      const per = toUnits(this.cfg.realAllocationPerAgent);
      if (real < per) this.lossUnits += per - real;
      const units = this.currentAgentUnits();
      units[a.agentId] = 0n;
      this.fundedPaperEquity.delete(a.agentId);
      void this.enqueueRail('cut', this.buildAlloc(units), `Cut ${a.agentId}: ${fromUnits(real)} ${this.asset} returned to the desk. ${reason}`);
    }
  }

  /** Funds agents now; the rail reallocation is queued and confirms in the background. */
  private fund(ready: AgentAccount[]): void {
    if (!this.rail || this.railError) return;
    const per = toUnits(this.cfg.realAllocationPerAgent);
    const units = this.currentAgentUnits();
    const funded: AgentAccount[] = [];
    let desk = this.target.desk ?? 0n;
    for (const a of ready) {
      if (desk < per) {
        this.log('warn', `${a.name} passed evaluation but the desk has only ${fromUnits(desk)} left in the pot.`);
        continue;
      }
      desk -= per;
      units[a.agentId] = per;
      funded.push(a);
    }
    if (!funded.length) return;
    const next = this.buildAlloc(units);
    const names = funded.map((a) => a.agentId).join(', ');
    void this.enqueueRail('fund', next, `Funded ${names} with ${this.cfg.realAllocationPerAgent} ${this.asset}${funded.length > 1 ? ' each' : ''} after ${this.round.tick} ticks.`);
    for (const a of funded) {
      a.status = 'funded';
      this.fundedPaperEquity.set(a.agentId, a.equityUsd);
      this.emitEvent({ type: 'funded', ts: this.now(), agentId: a.agentId, realAllocation: fromUnits(per) });
    }
  }

  /**
   * Mark to market. Local rail: any drift above 0.01, every tick. On-chain rail: at most every
   * reallocMinTicks ticks and only above reallocMinDrift; a queued update not yet sent is replaced.
   */
  private reallocateOnDrift(): void {
    const funded = this.accounts.filter((a) => a.status === 'funded');
    if (!funded.length || !this.rail || this.railError) return;
    const onchain = this.d.railName !== 'local';
    if (onchain && this.round.tick - this.lastDriftTick < (this.cfg.reallocMinTicks ?? 10)) return;
    const minUnits = onchain ? floatToUnits(this.cfg.reallocMinDrift ?? 0.02) : DRIFT_UNITS;
    let drift = false;
    const units = this.currentAgentUnits();
    const moved: string[] = [];
    for (const a of funded) {
      const real = this.realEquityUnits(a);
      const cur = this.target[a.agentId] ?? 0n;
      const diff = real > cur ? real - cur : cur - real;
      if (diff > minUnits) {
        drift = true;
        units[a.agentId] = real;
        moved.push(`${a.agentId} ${fromUnits(cur)} -> ${fromUnits(real)}`);
      }
    }
    if (!drift) return;
    this.lastDriftTick = this.round.tick;
    void this.enqueueRail('drift', this.buildAlloc(units), `Mark to market: ${moved.join('; ')}.`);
  }

  private async closeRound(): Promise<void> {
    if (this.round.phase !== 'evaluation' && this.round.phase !== 'funded') {
      throw new Error(`Cannot close a round in phase ${this.round.phase}`);
    }
    if (this.railError) throw new Error(`The rail is halted: ${this.railError} Reset the desk to close the session.`);
    this.running = false;
    this.loopGen++;
    if (this.timer) clearTimeout(this.timer);
    if (!this.snapshot) this.rawSnapshot = await this.d.provider.snapshot();
    const s = this.snapshot ?? this.applyShocks(this.rawSnapshot!, this.shocks);
    this.snapshot = s;
    for (const a of this.accounts) {
      if (a.status === 'cut') continue;
      const fills = closeAllPositions(a, s, 'close', this.fee);
      for (const f of fills) this.emitEvent({ type: 'fill', ts: this.now(), fill: f });
      markAccount(a, s, this.cfg, this.multiplier);
    }

    // Payout: each funded agent gets profitSplitAgent of its real profit if positive; the desk gets everything else.
    const per = toUnits(this.cfg.realAllocationPerAgent);
    const splitPpm = BigInt(Math.round(this.cfg.profitSplitAgent * 1_000_000));
    const payout: Partial<Record<AgentId, bigint>> = {};
    const lines: string[] = [];
    let finalLoss = 0n;
    for (const a of this.accounts) {
      if (a.status !== 'funded') continue;
      const real = this.realEquityUnits(a);
      const profit = real - per;
      const pay = profit > 0n ? (profit * splitPpm) / 1_000_000n : 0n;
      payout[a.agentId] = pay;
      if (profit < 0n) finalLoss += -profit;
      lines.push(`${a.agentId} real equity ${fromUnits(real)}, profit ${profit >= 0n ? '' : '-'}${fromUnits(profit >= 0n ? profit : -profit)}, paid ${fromUnits(pay)}`);
    }
    const final = this.buildAlloc(payout);
    const finalStr = this.allocStrings(final);
    if (this.rail) {
      // FIFO: every queued funding and cut confirms first, then the close, then the scorecard.
      const ok = await this.enqueueRail('close', final, `Close round ${this.round.id}`);
      if (!ok) return; // railFailed already logged loudly and paused the desk
      for (const v of Object.values(payout)) this.paidUnits += v ?? 0n;
      this.lossUnits += finalLoss;
    }
    this.round.phase = 'settled';
    this.log('info', `Round ${this.round.id} settled. ${lines.length ? lines.join('; ') + '.' : 'No funded agents.'} Desk receives ${finalStr.desk}.`);

    if (this.d.scorecard) {
      const stateHash = keccak256(toBytes(canonicalJson(finalStr)));
      // Off-chain prices come from the raw snapshot, so a synthetic shock never reaches the on-chain stamp.
      const raw = this.rawSnapshot ?? s;
      const feeds: Hex[] = [];
      const offchainPrices: bigint[] = [];
      for (const sym of Object.keys(this.d.scorecardFeeds ?? {}).sort()) {
        const m = raw.marks[sym];
        const price = m?.atlasPrice ?? m?.cmcPrice;
        if (!price) continue;
        feeds.push(this.d.scorecardFeeds![sym]);
        offchainPrices.push(scalePrice(price));
      }
      const sc = this.d.scorecard;
      const input = {
        roundId: this.round.id,
        results: this.accounts.map((a) => ({ agentId: a.agentId, pnlBps: Math.round(a.pnlPct * 100), status: a.status })),
        stateHash,
        feeds,
        offchainPrices,
      };
      // Same queue as the rail: the close has confirmed, and nothing else sends with the desk key meanwhile.
      const r = await this.enqueueTx('Scorecard closeRound', () => sc.closeRound(input));
      if (r.ok && r.value) {
        this.scorecards.push(r.value);
        this.emitEvent({ type: 'scorecard', ts: this.now(), tx: r.value });
      } else if (r.error) {
        this.log('error', `Scorecard closeRound failed: ${errMsg(r.error)}`);
      }
    }
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
