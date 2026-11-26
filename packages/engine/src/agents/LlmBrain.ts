// Optional layer: Claude picks one of the rule brain's candidates (or nothing) and writes the rationale.
// Cost controls: a per-process call cap shared by all agents, a per-agent tick throttle, and a call only when
// there are at least two distinct candidates. Any error, timeout (3s) or malformed answer falls back to the rules.
import Anthropic from '@anthropic-ai/sdk';
import type { AgentId, Order } from '../../../../shared/src/types.ts';
import { grossExposure, usd } from '../risk.ts';
import type { Brain, BrainContext, Candidate, CandidateSource } from './types.ts';
import { maxAdverseProb } from './common.ts';

export const LLM_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 3000;
const MAX_TOKENS = 150;
/** The dashboard row is small: the prompt asks for at most this many characters, and longer text is clipped. */
export const RATIONALE_MAX = 220;

/** Clips at a word boundary to RATIONALE_MAX characters. */
export function clip(text: string): string {
  if (text.length <= RATIONALE_MAX) return text;
  const cut = text.slice(0, RATIONALE_MAX - 3);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 120 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}...`;
}

/** The corrected event reading given to the model: adverse assessments only, plus the desk multiplier. */
function eventLine(ctx: BrainContext): string {
  const adv = maxAdverseProb(ctx);
  const top = adv.claim
    ? `top adverse Cournot claim "${adv.claim}" at ${(adv.p * 100).toFixed(1)}%`
    : 'no adverse Cournot claim loaded (favorable claims are not risk events)';
  return `${top}; risk budget multiplier ${ctx.eventMultiplier.toFixed(2)}.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    choice: { type: 'integer' },
    rationale: { type: 'string' },
  },
  required: ['choice', 'rationale'],
  additionalProperties: false,
} as const;

/** Minimal surface of the SDK client the brain uses, so tests can inject a fake. */
export interface LlmClient {
  messages: { create: Anthropic['messages']['create'] };
}

/** One gate shared by every LlmBrain in the process: call cap, throttle and token totals. */
export class LlmGate {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  private announced = false;
  private disabledReason: string | null = null;
  private lastCallTick = new Map<AgentId, number>();
  constructor(
    readonly cap: number,
    readonly minIntervalTicks: number,
    /** Called once when the cap is reached. Settable after construction (the desk wires its log in). */
    public onCapReached: (m: string) => void = () => {},
  ) {}
  get active(): boolean {
    return this.disabledReason === null && this.calls < this.cap;
  }
  /** Turns the LLM layer off for the rest of the process (billing or auth errors that retrying cannot fix). */
  disable(reason: string): void {
    if (this.disabledReason !== null) return;
    this.disabledReason = reason;
    this.onCapReached(`LLM layer turned off for the rest of this process: ${reason}. Agents use their rule brains.`);
  }
  /** True if this agent may call now; reserves the call (counts attempts, including failed ones). */
  take(agentId: AgentId, tick: number): boolean {
    if (!this.active) return false;
    const last = this.lastCallTick.get(agentId);
    if (last !== undefined && tick - last < this.minIntervalTicks) return false;
    this.lastCallTick.set(agentId, tick);
    this.calls++;
    if (!this.active && !this.announced) {
      this.announced = true;
      this.onCapReached(`LLM call cap of ${this.cap} reached after ${this.calls} calls; agents use their rule brains for the rest of this process.`);
    }
    return true;
  }
  record(usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    this.inputTokens += usage?.input_tokens ?? 0;
    this.outputTokens += usage?.output_tokens ?? 0;
  }
  stats(): { calls: number; cap: number; active: boolean } {
    return { calls: this.calls, cap: this.cap, active: this.active };
  }
}

export class LlmBrain implements Brain {
  readonly kind = 'llm' as const;
  readonly agentId: AgentId;
  private client: LlmClient;
  private warn: (m: string) => void;
  private lastWarn = 0;
  private timeoutMs: number;
  readonly gate: LlmGate;

  constructor(
    private rules: Brain & CandidateSource,
    opts: { apiKey?: string; client?: LlmClient; warn?: (m: string) => void; timeoutMs?: number; gate?: LlmGate } = {},
  ) {
    this.agentId = rules.agentId;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.warn = opts.warn ?? (() => {});
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.gate = opts.gate ?? new LlmGate(150, 3);
  }

  private viaRules(ctx: BrainContext, cands: Candidate[]): Order[] {
    const c = cands[0] ?? null;
    this.rules.commit(ctx, c);
    return c ? c.orders : [];
  }

  async propose(ctx: BrainContext): Promise<Order[]> {
    const cands = this.rules.candidates(ctx);
    // Only a real choice is worth a call: two or more distinct candidates besides "do nothing".
    const distinct = new Set(cands.map((c) => c.key)).size;
    if (distinct < 2 || ctx.rogue || !this.gate.take(this.agentId, ctx.tick)) return this.viaRules(ctx, cands);
    try {
      const pick = await this.ask(ctx, cands);
      const chosen = pick.choice === 0 ? null : cands[pick.choice - 1];
      this.rules.commit(ctx, chosen);
      if (!chosen) return [];
      const text = pick.rationale.trim().replace(/\s+/g, ' ').replace(/[–—]/g, '-');
      const ok = text.length > 10 && /\d/.test(text);
      return chosen.orders.map((o) => ({ ...o, rationale: ok ? clip(text) : o.rationale, brain: 'llm' as const }));
    } catch (e) {
      if (isPermanent(e)) this.gate.disable(e instanceof Error ? e.message.slice(0, 160) : String(e));
      const now = Date.now();
      if (now - this.lastWarn > 60_000) {
        this.lastWarn = now;
        this.warn(`LlmBrain(${this.agentId}) fell back to rules: ${e instanceof Error ? e.message : String(e)}`);
      }
      return this.viaRules(ctx, cands);
    }
  }

  private async ask(ctx: BrainContext, cands: Candidate[]): Promise<{ choice: number; rationale: string }> {
    const a = ctx.account;
    const lines = cands.map((c, i) => `${i + 1}. ${c.orders.map((o) => `${o.side} ${usd(o.notionalUsd)} ${o.symbol}: ${o.rationale}`).join(' / ')}`);
    const prompt = [
      `You are the ${this.agentId} agent on a paper prop desk. Pick one option.`,
      `Equity ${usd(a.equityUsd)}, cash ${usd(a.cashUsd)}, exposure ${usd(grossExposure(a, ctx.snapshot))}, budget ${usd(a.riskBudgetUsd)}, drawdown ${a.drawdownPct.toFixed(2)}% of ${ctx.config.maxDrawdownPct}%. Positions: ${a.positions.map((p) => `${p.symbol} ${usd(p.qty * (ctx.snapshot.marks[p.symbol]?.cmcPrice ?? p.avgPrice))}`).join(', ') || 'none'}.`,
      `Event risk: ${eventLine(ctx)}`,
      `0. Do nothing.`,
      ...lines,
      `Reply as JSON {"choice": number, "rationale": one plain sentence of at most ${RATIONALE_MAX} characters citing the numbers, no dashes}.`,
    ].join('\n');
    let handle: NodeJS.Timeout | undefined;
    const timer = new Promise<never>((_, rej) => {
      handle = setTimeout(() => rej(new Error(`timeout after ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    const call = this.client.messages.create(
      {
        model: LLM_MODEL,
        max_tokens: MAX_TOKENS,
        // Short structured answer: no thinking (allowed on Haiku 5.5 at effort high or below), low effort.
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      } as Parameters<Anthropic['messages']['create']>[0],
      { timeout: this.timeoutMs, maxRetries: 0 },
    ) as Promise<Anthropic.Message>;
    call.catch(() => undefined); // a late rejection after the timeout must not become unhandled
    const res = await Promise.race([call, timer]).finally(() => clearTimeout(handle));
    this.gate.record(res.usage);
    if (process.env.LLM_LOG_USAGE !== '0') {
      console.log(`[engine] llm ${this.agentId}: ${res.usage?.input_tokens ?? '?'} input / ${res.usage?.output_tokens ?? '?'} output tokens, stop ${res.stop_reason}`);
    }
    if (res.stop_reason === 'refusal') throw new Error('model refused');
    if (res.stop_reason === 'max_tokens') throw new Error('answer cut off at max_tokens');
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const parsed = JSON.parse(text) as { choice?: unknown; rationale?: unknown };
    const choice = Number(parsed.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > cands.length) throw new Error(`invalid choice ${String(parsed.choice)}`);
    if (typeof parsed.rationale !== 'string') throw new Error('missing rationale');
    return { choice, rationale: parsed.rationale };
  }
}

/** Billing and auth failures do not fix themselves within a run: 401, 403, or a 400 about credit balance. */
function isPermanent(e: unknown): boolean {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return true;
  return e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message);
}
