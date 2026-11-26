import type { AgentAccount, AgentId, DeskConfig, Instrument, MarketSnapshot, Order } from '../../../../shared/src/types.ts';

export interface BrainContext {
  tick: number;
  snapshot: MarketSnapshot;
  account: AgentAccount;
  instruments: Instrument[];
  config: DeskConfig;
  eventMultiplier: number;
  rogue: boolean;
  /** Explains a deliberate non-action. The desk logs it once and again only when the text changes. */
  note?: (message: string) => void;
}

/** A possible action. The rule brain picks the first; the LLM brain may pick any, or none. */
export interface Candidate {
  /** Short machine label, e.g. "buy-BNB", "trim", "rogue". */
  key: string;
  orders: Order[];
}

export interface Brain {
  readonly agentId: AgentId;
  readonly kind: 'rule' | 'llm';
  propose(ctx: BrainContext): Promise<Order[]>;
}

/** Implemented by rule brains so other layers (LlmBrain) can choose among their ideas. */
export interface CandidateSource {
  readonly agentId: AgentId;
  candidates(ctx: BrainContext): Candidate[];
  /** Called with the orders actually submitted, so cooldowns and rogue escalation stay correct. */
  commit(ctx: BrainContext, chosen: Candidate | null): void;
}
