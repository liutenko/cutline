import type { AgentId, EventRisk, Order, Sym } from '../../../../shared/src/types.ts';
import { positionValue, px, usd } from '../risk.ts';
import { RogueState, buyRoom, byKind, fmtPct, maxAdverseProb, mkOrder, sellAll, trimCandidate, weightPct, TARGET_PCT, TRANCHE_PCT, MIN_ORDER_USD } from './common.ts';
import type { Brain, BrainContext, Candidate, CandidateSource } from './types.ts';

/** Tunable, deterministic maintenance rules shared by every rule brain. */
export interface RuleBrainOptions {
  /** Take profit on a third of a position when its price is this % above the last trade (or entry) price. Majors and thin. */
  bandPct: number;
  /** The same band for RWA, which moves less (tokenized gold, stocks). */
  rwaBandPct: number;
  /** Trim back to the target weight when a position drifts this many percentage points above it. */
  rebalancePp: number;
  /** Ticks to wait after a sell before buying the same symbol again. */
  reentryTicks: number;
  /** Ticks a symbol is left alone after a buy. */
  cooldownTicks: number;
}

export const DEFAULT_BRAIN_OPTIONS: RuleBrainOptions = { bandPct: 1.2, rwaBandPct: 0.75, rebalancePp: 2, reentryTicks: 6, cooldownTicks: 3 };

/** BAND_PCT, REBALANCE_PP, REENTRY_TICKS from env. */
export function brainOptionsFromEnv(env: Record<string, string | undefined>): RuleBrainOptions {
  const n = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    bandPct: n(env.BAND_PCT, DEFAULT_BRAIN_OPTIONS.bandPct),
    rwaBandPct: n(env.BAND_PCT_RWA, DEFAULT_BRAIN_OPTIONS.rwaBandPct),
    rebalancePp: n(env.REBALANCE_PP, DEFAULT_BRAIN_OPTIONS.rebalancePp),
    reentryTicks: n(env.REENTRY_TICKS, DEFAULT_BRAIN_OPTIONS.reentryTicks),
    cooldownTicks: DEFAULT_BRAIN_OPTIONS.cooldownTicks,
  };
}

export abstract class RuleBrain implements Brain, CandidateSource {
  readonly kind = 'rule' as const;
  protected lastTrade = new Map<Sym, { tick: number; side: 'buy' | 'sell'; price: number }>();
  protected rogueState = new RogueState();
  protected opts: RuleBrainOptions;
  /** Generic take-profit / add-on-dip band rules. Off for brains that run their own band logic. */
  protected useBand = true;
  constructor(readonly agentId: AgentId, opts: Partial<RuleBrainOptions> = {}) {
    this.opts = { ...DEFAULT_BRAIN_OPTIONS, ...opts };
  }

  /** Strategy ideas, best first. Does not include rogue, trim or maintenance; candidates() adds those. */
  protected abstract ideas(ctx: BrainContext): Candidate[];
  /** Symbols this strategy manages (maintenance rules apply only to these). */
  protected abstract managed(ctx: BrainContext): Sym[];
  /** Whether the strategy's own case for holding this symbol still holds; gates adding on a dip. Returns the reason, or null. */
  protected abstract caseFor(ctx: BrainContext, symbol: Sym): string | null;

  candidates(ctx: BrainContext): Candidate[] {
    if (ctx.rogue) {
      const r = this.rogueState.candidate(ctx, this.agentId);
      return r ? [r] : [];
    }
    const out: Candidate[] = [];
    const trim = trimCandidate(ctx, this.agentId);
    if (trim) out.push(trim);
    out.push(...this.maintenance(ctx));
    out.push(...this.ideas(ctx));
    return out;
  }

  /** Rebalance down to the target weight, and take profit on a third after a band move up. */
  protected maintenance(ctx: BrainContext): Candidate[] {
    const out: Candidate[] = [];
    const managed = new Set(this.managed(ctx));
    const eq = ctx.account.equityUsd;
    for (const p of ctx.account.positions) {
      const m = ctx.snapshot.marks[p.symbol];
      if (!m || !managed.has(p.symbol) || this.cooling(ctx, p.symbol, 'sell')) continue;
      const v = positionValue(ctx.account, ctx.snapshot, p.symbol);
      const w = eq > 0 ? (v / eq) * 100 : 0;
      if (w > TARGET_PCT + this.opts.rebalancePp) {
        const amt = v - (eq * TARGET_PCT) / 100;
        if (amt >= MIN_ORDER_USD) {
          out.push({ key: `rebalance-${p.symbol}`, orders: [mkOrder(ctx, this.agentId, p.symbol, 'sell', amt,
            `${p.symbol} drifted to ${w.toFixed(1)}% of equity, more than ${this.opts.rebalancePp} points over my ${TARGET_PCT}% target, so I sell ${usd(amt)} to rebalance.`)] });
          continue;
        }
      }
      if (!this.useBand) continue;
      const ref = this.lastTrade.get(p.symbol)?.price ?? p.avgPrice;
      const move = (m.cmcPrice / ref - 1) * 100;
      const band = ctx.instruments.find((i) => i.symbol === p.symbol)?.kind === 'rwa' ? this.opts.rwaBandPct : this.opts.bandPct;
      if (move >= band) {
        const amt = v / 3;
        if (amt >= MIN_ORDER_USD) {
          out.push({ key: `take-profit-${p.symbol}`, orders: [mkOrder(ctx, this.agentId, p.symbol, 'sell', amt,
            `${p.symbol} is ${fmtPct(move)} above my last reference price of ${px(ref)}, past my ${band}% band, so I take profit on a third, ${usd(amt)}.`)] });
        }
      }
      if (move <= -band && !this.cooling(ctx, p.symbol, 'buy')) {
        const why = this.caseFor(ctx, p.symbol);
        const amt = why ? buyRoom(ctx, p.symbol, TARGET_PCT + this.opts.rebalancePp - 0.5) : 0;
        if (why && amt) {
          out.push({ key: `add-dip-${p.symbol}`, orders: [mkOrder(ctx, this.agentId, p.symbol, 'buy', amt,
            `${p.symbol} is ${fmtPct(move)} below my last reference price of ${px(ref)}, past my ${band}% band, and ${why}, so I add ${usd(amt)}.`)] });
        }
      }
    }
    return out;
  }

  commit(ctx: BrainContext, chosen: Candidate | null): void {
    if (!chosen) return;
    if (chosen.key === 'rogue') {
      this.rogueState.attempts++;
      return;
    }
    for (const o of chosen.orders) {
      this.lastTrade.set(o.symbol, { tick: ctx.tick, side: o.side, price: ctx.snapshot.marks[o.symbol]?.cmcPrice ?? 0 });
    }
  }

  async propose(ctx: BrainContext): Promise<Order[]> {
    const c = this.candidates(ctx)[0] ?? null;
    this.commit(ctx, c);
    return c ? c.orders : [];
  }

  /** True while a symbol should be left alone. A buy after a sell waits reentryTicks; anything else waits cooldownTicks. */
  protected cooling(ctx: BrainContext, symbol: Sym, next?: 'buy' | 'sell'): boolean {
    const t = this.lastTrade.get(symbol);
    if (!t) return false;
    const wait = next === 'buy' && t.side === 'sell' ? this.opts.reentryTicks : this.opts.cooldownTicks;
    return ctx.tick - t.tick < wait;
  }
}

/** Majors. Buys the instrument with the best 1h and 24h change when both are positive; exits on reversal. */
export class MomentumBrain extends RuleBrain {
  constructor(opts: Partial<RuleBrainOptions> = {}) {
    super('momentum', opts);
  }
  protected managed(ctx: BrainContext): Sym[] {
    return byKind(ctx, 'major').map((i) => i.symbol);
  }
  protected caseFor(ctx: BrainContext, symbol: Sym): string | null {
    const m = ctx.snapshot.marks[symbol];
    return m && (m.pctChange1h ?? -1) > 0 && (m.pctChange24h ?? -1) > 0
      ? `its trend is still up (1h ${fmtPct(m.pctChange1h)}, 24h ${fmtPct(m.pctChange24h)})`
      : null;
  }
  protected ideas(ctx: BrainContext): Candidate[] {
    const out: Candidate[] = [];
    const majors = byKind(ctx, 'major');
    // Exits first: a held major whose 1h change turned negative.
    for (const p of ctx.account.positions) {
      const m = ctx.snapshot.marks[p.symbol];
      if (!m || !majors.some((i) => i.symbol === p.symbol) || this.cooling(ctx, p.symbol)) continue;
      const h1 = m.pctChange1h ?? 0;
      const h24 = m.pctChange24h ?? 0;
      if (h1 < -0.1 || h24 < 0) {
        const o = sellAll(ctx, this.agentId, p.symbol,
          `${p.symbol} reversed (1h ${fmtPct(h1)}, 24h ${fmtPct(h24)}), so I exit the ${usd(positionValue(ctx.account, ctx.snapshot, p.symbol))} position.`);
        if (o) out.push({ key: `exit-${p.symbol}`, orders: [o] });
      }
    }
    // Entry: strongest major with both changes positive.
    const ranked = majors
      .map((i) => ({ i, m: ctx.snapshot.marks[i.symbol] }))
      .filter(({ m }) => (m.pctChange1h ?? -1) > 0 && (m.pctChange24h ?? -1) > 0)
      .sort((a, b) => score(b.m) - score(a.m));
    const held = ctx.account.positions.filter((p) => majors.some((i) => i.symbol === p.symbol)).length;
    for (const { i, m } of ranked.slice(0, 2)) {
      if (this.cooling(ctx, i.symbol, 'buy')) continue;
      const isHeld = ctx.account.positions.some((p) => p.symbol === i.symbol);
      if (!isHeld && held >= 2) continue;
      const amt = buyRoom(ctx, i.symbol);
      if (!amt) continue;
      const w = weightPct(ctx, i.symbol) + (amt / ctx.account.equityUsd) * 100;
      out.push({ key: `buy-${i.symbol}`, orders: [mkOrder(ctx, this.agentId, i.symbol, 'buy', amt,
        `${i.symbol} is the strongest major at ${fmtPct(m.pctChange1h)} over 1h and ${fmtPct(m.pctChange24h)} over 24h, so I add ${usd(amt)}, taking it to ${w.toFixed(0)}% of equity.`)] });
    }
    return out;
  }
}
const score = (m: { pctChange1h?: number; pctChange24h?: number }) => (m.pctChange1h ?? 0) + (m.pctChange24h ?? 0) * 0.25;

const DEFENSIVE = /gold|treasur|bond|t-bill|bill/i;

/** Tokenized RWA. Rotates into RWA when fear and greed is low or event risk is high, back to cash otherwise. */
/** Names the adverse claim behind the top adverse probability (favorable claims are not risk events). */
export function adverseText(adv: { p: number; claim?: string }): string {
  return adv.claim ? `the top adverse event, "${adv.claim}", is at ${(adv.p * 100).toFixed(0)}%` : 'no adverse event is loaded';
}

export class RwaBrain extends RuleBrain {
  private riskOff: boolean | null = null;
  constructor(opts: Partial<RuleBrainOptions> = {}) {
    super('rwa', opts);
  }
  protected managed(ctx: BrainContext): Sym[] {
    return byKind(ctx, 'rwa').map((i) => i.symbol);
  }
  protected caseFor(ctx: BrainContext, symbol: Sym): string | null {
    if (!this.riskOff) return null;
    const inst = ctx.instruments.find((i) => i.symbol === symbol);
    const defensiveExists = byKind(ctx, 'rwa').some((i) => DEFENSIVE.test(i.name));
    if (defensiveExists && inst && !DEFENSIVE.test(inst.name)) return null;
    return `risk is still off (fear and greed ${ctx.snapshot.fearGreed ?? 'n/a'}, ${adverseText(maxAdverseProb(ctx))})`;
  }
  protected ideas(ctx: BrainContext): Candidate[] {
    const fg = ctx.snapshot.fearGreed;
    const adv = maxAdverseProb(ctx);
    // Hysteresis so the agent does not flip on small moves.
    const off = (fg !== undefined && fg <= 45) || adv.p >= 0.35;
    const on = (fg === undefined || fg >= 55) && adv.p < 0.3;
    if (off) this.riskOff = true;
    else if (on) this.riskOff = false;
    else if (this.riskOff === null) this.riskOff = false;
    const why = `Fear and greed is ${fg ?? 'n/a'} and ${adverseText(adv)}`;
    // In risk-off, prefer defensive RWA (gold, treasuries) over tokenized stocks; fall back to any RWA.
    const allRwa = byKind(ctx, 'rwa');
    const defensive = allRwa.filter((i) => DEFENSIVE.test(i.name));
    const rwas = (this.riskOff && defensive.length ? defensive : allRwa).sort((a, b) => (ctx.snapshot.marks[b.symbol].pctChange24h ?? 0) - (ctx.snapshot.marks[a.symbol].pctChange24h ?? 0));
    const out: Candidate[] = [];
    if (this.riskOff) {
      for (const i of rwas.slice(0, 2)) {
        if (this.cooling(ctx, i.symbol, 'buy')) continue;
        const amt = buyRoom(ctx, i.symbol, TARGET_PCT);
        if (!amt) continue;
        out.push({ key: `buy-${i.symbol}`, orders: [mkOrder(ctx, this.agentId, i.symbol, 'buy', amt,
          `${why}, so I rotate ${usd(amt)} into ${i.symbol} (${i.name}), taking it to ${(weightPct(ctx, i.symbol) + (amt / ctx.account.equityUsd) * 100).toFixed(0)}% of equity.`)] });
      }
    } else {
      for (const p of ctx.account.positions) {
        if (!allRwa.some((i) => i.symbol === p.symbol) || this.cooling(ctx, p.symbol)) continue;
        const v = positionValue(ctx.account, ctx.snapshot, p.symbol);
        const amt = Math.min(v, (ctx.account.equityUsd * 12) / 100);
        if (amt < 250) continue;
        out.push({ key: `sell-${p.symbol}`, orders: [mkOrder(ctx, this.agentId, p.symbol, 'sell', amt >= v * 0.95 ? v : amt,
          `${why}, so risk is back on and I move ${usd(amt)} of ${p.symbol} back to cash.`)] });
      }
    }
    return out;
  }
}

/** Minimum |divergence| for a market to count toward a gap. */
export const EVENT_MIN_GAP = 0.02;
/** Gap (Cournot minus venue, averaged) that defines the trend and risk-off regimes. */
export const EVENT_REGIME_GAP = 0.03;

export type EventRegime = 'risk-off' | 'trend' | 'range' | 'neutral';

export interface EventRegimeReading {
  regime: EventRegime;
  /** Mean divergence over favorable rows with |divergence| >= 0.02 (0 if none). */
  upGap: number;
  /** The same over adverse rows. */
  downGap: number;
  /** Counted row with the largest |divergence|. */
  top?: EventRisk;
  count: number;
}

/** Reads the regime from every EventRisk with a divergence (assessments and ranking rows). */
export function eventRegime(events: EventRisk[]): EventRegimeReading {
  const rows = events.filter((e) => typeof e.divergence === 'number' && Math.abs(e.divergence) >= EVENT_MIN_GAP);
  const mean = (xs: EventRisk[]) => (xs.length ? xs.reduce((a, e) => a + e.divergence!, 0) / xs.length : 0);
  const upGap = mean(rows.filter((e) => e.polarity === 'favorable'));
  const downGap = mean(rows.filter((e) => e.polarity === 'adverse'));
  const top = [...rows].sort((a, b) => Math.abs(b.divergence!) - Math.abs(a.divergence!))[0];
  let regime: EventRegime = 'neutral';
  if (downGap >= EVENT_REGIME_GAP) regime = 'risk-off';
  else if (upGap >= EVENT_REGIME_GAP) regime = 'trend';
  else if (upGap <= -EVENT_MIN_GAP && downGap <= -EVENT_MIN_GAP) regime = 'range';
  return { regime, upGap, downGap, top, count: rows.length };
}

const pct1 = (p: number | undefined) => (p === undefined ? 'n/a' : `${(p * 100).toFixed(1)}%`);
const pts = (g: number) => `${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)} points`;

/**
 * Trades Cournot's view of both tails against the venues, on BNB.
 * risk-off: trim to cash. trend: add tranches. range: mean reversion around a reference price. neutral: hold.
 */
export class EventBrain extends RuleBrain {
  readonly symbol: Sym;
  private regime: EventRegime | null = null;
  private starterPending = false;
  private firstPrice: number | null = null;
  constructor(opts: Partial<RuleBrainOptions> = {}, symbol: Sym = 'BNB') {
    super('event', opts);
    this.symbol = symbol;
    this.useBand = false;
  }
  protected managed(): Sym[] {
    return [this.symbol];
  }
  protected caseFor(): string | null {
    return null;
  }
  private describe(r: EventRegimeReading): string {
    const head = `Regime ${r.regime}: Cournot rates upside claims ${pts(r.upGap)} and downside claims ${pts(r.downGap)} against the venues`;
    if (!r.top) return `${head}, with no market differing by ${EVENT_MIN_GAP} or more`;
    return `${head}; the largest gap is "${r.top.claim}", where Cournot says ${pct1(r.top.cournotProbability)} against a venue price of ${pct1(r.top.venuePrice)}`;
  }
  protected ideas(ctx: BrainContext): Candidate[] {
    const sym = this.symbol;
    const m = ctx.snapshot.marks[sym];
    if (!m) return [];
    this.firstPrice ??= m.cmcPrice;
    const r = eventRegime(ctx.snapshot.eventRisk);
    const text = this.describe(r);
    if (r.regime !== this.regime) {
      this.starterPending = r.regime === 'range';
      this.regime = r.regime;
      ctx.note?.(`Event Trader regime is now ${r.regime}. ${text}.`);
    }
    const held = positionValue(ctx.account, ctx.snapshot, sym);
    const pos = ctx.account.positions.find((p) => p.symbol === sym);
    const tranche = (ctx.account.equityUsd * TRANCHE_PCT) / 100;
    const sellTranche = (why: string): Candidate[] => {
      if (held < MIN_ORDER_USD || this.cooling(ctx, sym, 'sell')) return [];
      const amt = Math.min(held, tranche);
      return [{ key: `sell-${sym}`, orders: [mkOrder(ctx, this.agentId, sym, 'sell', amt >= held * 0.95 ? held : amt, `${text}, so ${why} ${usd(amt)} of ${sym}.`)] }];
    };
    const buyTranche = (why: string): Candidate[] => {
      if (this.cooling(ctx, sym, 'buy')) return [];
      const amt = buyRoom(ctx, sym);
      return amt ? [{ key: `buy-${sym}`, orders: [mkOrder(ctx, this.agentId, sym, 'buy', amt, `${text}, so ${why} ${usd(amt)} of ${sym}.`)] }] : [];
    };
    switch (r.regime) {
      case 'risk-off':
        return sellTranche('I trim');
      case 'trend':
        return buyTranche('I add');
      case 'neutral':
        return [];
      case 'range': {
        const band = this.opts.bandPct;
        if (this.starterPending && held < MIN_ORDER_USD) {
          const c = buyTranche('I open a starter position with');
          if (c.length) this.starterPending = false;
          return c;
        }
        this.starterPending = false;
        if (pos && m.cmcPrice >= pos.avgPrice * (1 + band / 100)) {
          return sellTranche(`${sym} is ${fmtPct((m.cmcPrice / pos.avgPrice - 1) * 100)} above my ${px(pos.avgPrice)} average entry, past my ${band}% band, and I sell`);
        }
        const ref = this.lastTrade.get(sym)?.price ?? this.firstPrice;
        if (m.cmcPrice <= ref * (1 - band / 100)) {
          return buyTranche(`${sym} is ${fmtPct((m.cmcPrice / ref - 1) * 100)} below my ${px(ref)} reference price, past my ${band}% band, and I buy`);
        }
        return [];
      }
    }
  }
}

export function createRuleBrain(id: AgentId, opts: Partial<RuleBrainOptions> = {}): RuleBrain {
  switch (id) {
    case 'momentum': return new MomentumBrain(opts);
    case 'rwa': return new RwaBrain(opts);
    case 'event': return new EventBrain(opts);
  }
}
