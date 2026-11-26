// Shared contract between all packages. Owned by the planner.
// Workers: import from here, never redefine. If something is missing, say so in your report.

export type Hex = `0x${string}`;
export type AgentId = 'momentum' | 'rwa' | 'event';
export type Sym = string; // e.g. 'BNB', 'CAKE', 'PAXG'

// ---------- Market data ----------

export interface Instrument {
  symbol: Sym;
  name: string;
  cmcId: number;
  kind: 'major' | 'rwa' | 'thin';
  /** Token contract on BNB Chain (chain 56), if any. */
  bscAddress?: Hex;
  /** Atlas feed address on the configured chain, if we have one. */
  atlasFeed?: Hex;
}

export interface PriceMark {
  symbol: Sym;
  cmcPrice: number;
  cmcTs: number; // ms epoch
  pctChange1h?: number;
  pctChange24h?: number;
  atlasPrice?: number;
  atlasTs?: number; // ms epoch of the on-chain update
  /** |cmc - atlas| / cmc in basis points, when both exist. */
  deviationBps?: number;
  /** 'both' = two sources within tolerance. 'single' = only CoinMarketCap available. 'disagree' = outside tolerance. */
  agreement: 'both' | 'single' | 'disagree';
  /** True when the Atlas price is older than the allowed age; the mark then counts as 'single', never 'disagree'. */
  atlasStale?: boolean;
  /** True when this mark was altered by a labeled stress test. */
  synthetic?: boolean;
}

export interface Liquidity {
  symbol: Sym;
  dexLiquidityUsd: number;
  dexVolume24hUsd: number;
  /** e.g. 'CoinMarketCap DEX API: PancakeSwap v3 BNB/USDT' */
  source: string;
  ts: number;
}

export interface EventRisk {
  /** The exact claim sent to Cournot. */
  claim: string;
  venue?: string;
  marketId?: string;
  marketUrl?: string;
  /** Cournot fair-value probability, 0..1. */
  cournotProbability: number;
  /** The venue's current price for the same claim, 0..1. */
  venuePrice?: number;
  /** cournotProbability - venuePrice. */
  divergence?: number;
  /** Supporting evidence exactly as Cournot returned it. */
  sources: { title: string; url?: string; snippet?: string }[];
  /** Explanation text returned by Cournot, verbatim. */
  cournotExplanation?: string;
  requestId?: string;
  fetchedAt: number;
  /** True if this came from a live call in this process; false if loaded from the proof cache. */
  live: boolean;
  /** 'assessment' = a full Cournot assessment of one claim, with evidence. 'ranking' = a row of Cournot's divergence ranking (no per-claim evidence). */
  origin?: 'assessment' | 'ranking';
  /** Is the claim bad for risk assets if it happens ('adverse') or good ('favorable')? Set by our config, not by Cournot. */
  polarity: 'adverse' | 'favorable';
}

export interface MarketSnapshot {
  ts: number;
  marks: Record<Sym, PriceMark>;
  liquidity: Record<Sym, Liquidity>;
  eventRisk: EventRisk[];
  fearGreed?: number; // 0..100 from CoinMarketCap
  mode: 'live' | 'replay' | 'dev';
}

export interface DataProvider {
  instruments(): Instrument[];
  snapshot(): Promise<MarketSnapshot>;
}

// ---------- Trading and risk ----------

export interface Order {
  id: string;
  agentId: AgentId;
  symbol: Sym;
  side: 'buy' | 'sell';
  /** In paper-account dollars. */
  notionalUsd: number;
  rationale: string;
  /** Which brain produced this order. */
  brain?: 'rule' | 'llm';
  ts: number;
}

export type RiskCheckName =
  | 'agent-status'
  | 'liquidity'
  | 'price-agreement'
  | 'event-budget'
  | 'exposure'
  | 'concentration';

export interface RiskCheck {
  name: RiskCheckName;
  source: 'CoinMarketCap' | 'Atlas' | 'Cournot' | 'Desk';
  pass: boolean;
  /** One plain sentence with the numbers, e.g. "Order $25,000 is 61% of pool liquidity $41,000; cap is 2%". */
  detail: string;
}

export interface RiskDecision {
  orderId: string;
  approved: boolean;
  checks: RiskCheck[];
}

export interface Fill {
  orderId: string;
  agentId: AgentId;
  symbol: Sym;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  notionalUsd: number;
  /** Mark price before costs. */
  midPrice?: number;
  /** Estimated price impact applied to this paper fill, in percent (2 x notional / DEX liquidity). */
  slippagePct?: number;
  /** Pool fee applied to this paper fill, in percent. */
  feePct?: number;
  ts: number;
}

export interface Position {
  symbol: Sym;
  qty: number;
  avgPrice: number;
}

export type AgentStatus = 'evaluating' | 'funded' | 'cut';

export interface AgentAccount {
  agentId: AgentId;
  name: string;
  strategy: string;
  address: Hex;
  status: AgentStatus;
  /** Paper account size at start (dollars). */
  startEquityUsd: number;
  cashUsd: number;
  positions: Position[];
  equityUsd: number;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  drawdownPct: number; // from peak, positive number
  dailyLossPct: number; // positive number
  /** Max gross exposure allowed right now, after the event-risk multiplier. */
  riskBudgetUsd: number;
  /** Real capital currently allocated on the settlement rail (decimal string, e.g. "3.00"). "0" while evaluating or after a cut. */
  realAllocation: string;
  cutReason?: string;
  /** Why an agent past the evaluation window is not funded yet. */
  evalNote?: string;
  rogue?: boolean;
  /** Paper equity sampled once per tick, oldest first, capped at 240 points. For the dashboard sparkline. */
  equityHistory?: number[];
}

export interface DeskConfig {
  paperAccountUsd: number; // 25000
  realPot: string; // "10"
  realAllocationPerAgent: string; // "3"
  asset: 'usdt' | 'usdc';
  profitSplitAgent: number; // 0.8
  maxDrawdownPct: number; // 6
  dailyLossLimitPct: number; // 3
  maxOrderPctOfLiquidity: number; // 2
  priceToleranceBps: number; // 50
  maxConcentrationPct: number; // 40
  baseRiskBudgetPct: number; // 100 (gross exposure as % of equity)
  minEventMultiplier: number; // 0.25
  /** Fills an agent needs before it can be funded. */
  evalMinTrades?: number;
  /** Lowest paper P&L (percent of account, after costs) that still passes evaluation. */
  evalMinPnlPct?: number;
  /** Pool fee charged on every paper fill, in percent. */
  poolFeePct?: number;
  evalTicks: number; // ticks an agent must survive, with pnl >= 0, to be funded
  tickMs: number;
}

// ---------- Settlement rail ----------

/** 'local' = in-memory ledger for development. 'bnb-testnet-vault' = the DeskVault contract on BNB Smart Chain testnet. */
export type RailName = 'local' | 'bnb-testnet-vault';

export interface RailParticipant {
  /** 'desk' | 'risk' | an AgentId */
  id: string;
  role: 'desk' | 'risk' | 'agent';
  address: Hex;
}

export interface RailState {
  sessionId: string;
  version: number;
  asset: 'usdt' | 'usdc' | 'tusd';
  /** participant id -> decimal string. Sum is constant after open. */
  allocations: Record<string, string>;
  status: 'open' | 'closed';
}

export interface RailReceipt {
  kind: 'open' | 'reallocate' | 'close';
  rail: RailName;
  sessionId: string;
  version: number;
  /** True when the step did not produce an on-chain transaction (local ledger only). */
  offchain: boolean;
  txHash?: Hex;
  explorerUrl?: string;
  memo?: string;
  allocations: Record<string, string>;
  ts: number;
}

export interface SettlementRail {
  readonly name: RailName;
  /** Opens a session for the participants and deposits `amount` from the desk. All funds start with the desk. */
  open(p: { participants: RailParticipant[]; asset: 'usdt' | 'usdc'; amount: string }): Promise<RailReceipt>;
  /** Replaces the allocation map. Must conserve the total. Needs the risk manager's signature. */
  reallocate(next: Record<string, string>, memo: string): Promise<RailReceipt>;
  /** Closes the session with the final split and releases funds. */
  close(final: Record<string, string>): Promise<RailReceipt>;
  state(): RailState | null;
}

// ---------- Desk state and events (engine -> dashboard) ----------

export interface ScorecardTx {
  roundId: number;
  txHash: Hex;
  explorerUrl: string;
  chainId: number;
}

export type DeskEvent =
  | { type: 'tick'; ts: number; tick: number }
  | { type: 'order'; ts: number; order: Order }
  | { type: 'decision'; ts: number; order: Order; decision: RiskDecision }
  | { type: 'fill'; ts: number; fill: Fill }
  | { type: 'budget'; ts: number; multiplier: number; reason: string }
  | { type: 'funded'; ts: number; agentId: AgentId; realAllocation: string }
  | { type: 'cut'; ts: number; agentId: AgentId; reason: string }
  | { type: 'rail'; ts: number; receipt: RailReceipt }
  | { type: 'scorecard'; ts: number; tx: ScorecardTx }
  | { type: 'shock'; ts: number; symbol: Sym; pct: number }
  | { type: 'log'; ts: number; level: 'info' | 'warn' | 'error'; message: string };

export interface DeskState {
  mode: 'live' | 'replay' | 'dev';
  rail: RailName;
  running: boolean;
  round: { id: number; tick: number; phase: 'idle' | 'evaluation' | 'funded' | 'settled'; startedAt: number | null };
  config: DeskConfig;
  /** Event-risk multiplier currently applied to every risk budget, minEventMultiplier..1. */
  eventMultiplier: number;
  agents: AgentAccount[];
  snapshot: MarketSnapshot | null;
  railState: RailState | null;
  receipts: RailReceipt[];
  scorecards: ScorecardTx[];
  /** Desk economics in real asset units (decimal strings). */
  economics?: {
    /** Sum of real allocations currently with funded agents. */
    fundedAllocations: string;
    /** The most the desk can lose this round: maxDrawdownPct of funded allocations. */
    capitalAtRisk: string;
    /** Profit share paid to agents at round close. */
    paidToAgents: string;
    /** Real losses the desk absorbed from cut or losing agents. */
    lossesAbsorbed: string;
  };
  /** Rail operations queued or awaiting on-chain confirmation. */
  railPending?: number;
  /** LLM layer counters. */
  llm?: { calls: number; cap: number; active: boolean };
  /** On-chain links that are not rail steps: contract deployments (Scorecard, DeskVault, test token). */
  onchainLinks?: { label: string; explorerUrl: string; txHash: string }[];
  /** Newest last, capped at 200. */
  events: DeskEvent[];
}

export type ControlAction =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'reset' }
  | { action: 'rogue'; agentId: AgentId }
  | { action: 'shock'; symbol: Sym; pct: number }
  | { action: 'close-round' };
