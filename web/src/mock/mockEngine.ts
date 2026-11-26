// In-browser stand-in for the engine, enabled only with ?mock=1.
// Everything it produces is invented and the page labels it "MOCK DATA".
import type {
  AgentAccount, ControlAction, AgentId, DeskConfig, DeskEvent, DeskState, EventRisk, Hex, MarketSnapshot,
  Order, PriceMark, RailReceipt, RiskCheck, RiskDecision,
} from '../types';
import type { DeskSource } from '../source';

type Kind = 'major' | 'rwa' | 'thin';
interface Inst { symbol: string; kind: Kind; price: number; vol: number; liq: number; atlas: boolean }

const INSTS: Inst[] = [
  { symbol: 'BNB', kind: 'major', price: 642.4, vol: 0.0028, liq: 48_000_000, atlas: true },
  { symbol: 'CAKE', kind: 'major', price: 2.41, vol: 0.0042, liq: 7_800_000, atlas: true },
  { symbol: 'BTCB', kind: 'major', price: 91450, vol: 0.0024, liq: 30_000_000, atlas: true },
  { symbol: 'ETH', kind: 'major', price: 3412.8, vol: 0.0030, liq: 36_000_000, atlas: true },
  { symbol: 'XAUT', kind: 'rwa', price: 4052.3, vol: 0.0009, liq: 3_100_000, atlas: false },
  { symbol: 'XAUM', kind: 'rwa', price: 4048.1, vol: 0.0009, liq: 1_200_000, atlas: false },
  { symbol: 'TSLAB', kind: 'rwa', price: 412.6, vol: 0.0035, liq: 900_000, atlas: true },
  { symbol: 'MTHT', kind: 'thin', price: 0.0042, vol: 0.0060, liq: 41_000, atlas: false },
];

const AGENTS: { id: AgentId; name: string; strategy: string; address: Hex }[] = [
  { id: 'momentum', name: 'Momentum', strategy: 'Trades BNB majors on 1h and 24h trend', address: '0x1a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3' },
  { id: 'rwa', name: 'Real-world assets', strategy: 'Rotates into tokenized gold and treasuries on fear', address: '0x2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3d4' },
  { id: 'event', name: 'Event trader', strategy: 'Trades gaps between Cournot and prediction markets', address: '0x3c4d5e6f708192a3b4c5d6e7f80910a1b2c3d4e5' },
];

const CONFIG: DeskConfig = {
  paperAccountUsd: 25000, realPot: '10', realAllocationPerAgent: '3', asset: 'usdt', profitSplitAgent: 0.8,
  maxDrawdownPct: 6, dailyLossLimitPct: 3, maxOrderPctOfLiquidity: 2, priceToleranceBps: 50, maxConcentrationPct: 40,
  baseRiskBudgetPct: 100, minEventMultiplier: 0.25, evalTicks: 6, tickMs: 1400, evalMinTrades: 3, evalMinPnlPct: 0, poolFeePct: 0.25,
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r: () => number, n: number): string => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const n2 = (n: number): string => n.toFixed(2);
const usd0 = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');

interface Brain { acct: AgentAccount; rogueSteps: number; startedTick: number | null; cool: number }

class Sim {
  private r = rng(58900000);
  private timer: ReturnType<typeof setInterval> | undefined;
  private s!: DeskState;
  private brains!: Record<AgentId, Brain>;
  private hist: Record<string, number[]> = {};
  private shockLeft: Record<string, number> = {};
  private fg = 38;
  private orderSeq = 0;
  private adj: Record<string, number> = {};
  private closing = false;
  private llmCalls = 0;
  private pending = 0;
  private links: { label: string; explorerUrl: string; txHash: Hex }[] = [];
  constructor(private speed: number, private emitState: (s: DeskState) => void, private emitEvent: (e: DeskEvent) => void) {
    this.init();
  }

  init(): void {
    this.r = rng(58900000);
    this.hist = {};
    this.shockLeft = {};
    this.adj = {};
    this.fg = 38;
    this.orderSeq = 0;
    this.closing = false;
    this.llmCalls = 0;
    this.pending = 0;
    this.links = [];
    const now = Date.now();
    const marks: Record<string, PriceMark> = {};
    const liquidity: MarketSnapshot['liquidity'] = {};
    for (const i of INSTS) {
      this.hist[i.symbol] = [i.price];
      marks[i.symbol] = { symbol: i.symbol, cmcPrice: i.price, cmcTs: now, agreement: i.atlas ? 'both' : 'single' };
      liquidity[i.symbol] = { symbol: i.symbol, dexLiquidityUsd: i.liq, dexVolume24hUsd: i.liq * 0.6, source: 'CoinMarketCap DEX API (mock)', ts: now };
    }
    const agents = AGENTS.map<AgentAccount>((a) => ({
      agentId: a.id, name: a.name, strategy: a.strategy, address: a.address, status: 'evaluating',
      startEquityUsd: 25000, cashUsd: 25000, positions: [], equityUsd: 25000, peakEquityUsd: 25000, dayStartEquityUsd: 25000,
      pnlUsd: 0, pnlPct: 0, drawdownPct: 0, dailyLossPct: 0, riskBudgetUsd: 25000, realAllocation: '0', equityHistory: [25000],
    }));
    this.brains = {
      momentum: { acct: agents[0]!, rogueSteps: 0, startedTick: null, cool: 0 },
      rwa: { acct: agents[1]!, rogueSteps: 0, startedTick: null, cool: 0 },
      event: { acct: agents[2]!, rogueSteps: 0, startedTick: null, cool: 0 },
    };
    this.s = {
      mode: 'live', rail: 'bnb-testnet-vault', running: false,
      round: { id: 1, tick: 0, phase: 'idle', startedAt: null },
      config: CONFIG, eventMultiplier: 1, agents,
      snapshot: { ts: now, marks, liquidity, mode: 'live', fearGreed: this.fg, eventRisk: this.initialEvents(now) },
      railState: null, receipts: [], scorecards: [], events: [],
    };
    this.s.eventMultiplier = this.multiplier();
    this.reprice();
  }

  private initialEvents(now: number): EventRisk[] {
    const rank = (claim: string, p: number, v: number, polarity: 'adverse' | 'favorable', id: string): EventRisk => ({
      claim, venue: 'Example prediction market', marketId: id, cournotProbability: p, venuePrice: v, divergence: Math.round((p - v) * 100) / 100,
      polarity, live: false, origin: 'ranking', fetchedAt: now - 3 * 3600_000, sources: [],
    });
    const assess = (claim: string, p: number, polarity: 'adverse' | 'favorable', id: string, req: string, sources: EventRisk['sources']): EventRisk => ({
      claim, venue: 'Polymarket', marketId: id, marketUrl: `https://example.com/markets/${id}`, cournotProbability: p, venuePrice: p, divergence: 0,
      polarity, live: false, origin: 'assessment', fetchedAt: now - 3 * 3600_000, requestId: req, sources,
    });
    return [
      rank('Will a major exchange list a BNB Chain RWA token before 31 Dec 2026?', 0.58, 0.49, 'favorable', 'mock-r1'),
      rank('Will the US Treasury announce new stablecoin rules before 31 Jan 2027?', 0.34, 0.26, 'adverse', 'mock-r2'),
      rank('Will BNB trade above $700 at any point before 31 Dec 2026?', 0.37, 0.31, 'favorable', 'mock-r3'),
      assess('Will Bitcoin be below $55,000 on 31 Dec 2026?', 0.35, 'adverse', 'mock-btc55', 'mock-req-0001', [
        { title: 'polymarket', url: 'https://example.com/markets/btc-55k', snippet: 'polymarket latest yes price for Bitcoin below $55,000 on Dec 31 is 0.35' },
        { title: 'kalshi', url: 'https://example.com/markets/btc-55k-kalshi', snippet: 'Contracts on year-end Bitcoin range trade at 34 cents' },
        { title: 'deribit', url: 'https://example.com/options/btc', snippet: 'Options skew leans toward downside protection into year end' },
      ]),
      assess('Will Bitcoin be below $50,000 on 31 Dec 2026?', 0.21, 'adverse', 'mock-btc50', 'mock-req-0002', [
        { title: 'polymarket', url: 'https://example.com/markets/btc-50k', snippet: 'polymarket latest yes price for Bitcoin below $50,000 on Dec 31 is 0.21' },
      ]),
      assess('Will Ethereum be above $3,000 on 31 Dec 2026?', 0.78, 'favorable', 'mock-eth3k', 'mock-req-0003', [
        { title: 'polymarket', url: 'https://example.com/markets/eth-3k', snippet: 'polymarket latest yes price for Ethereum above $3,000 on Dec 31 is 0.78' },
      ]),
    ];
  }

  private multiplier(): number {
    const ev = (this.s.snapshot?.eventRisk ?? []).filter((e) => e.origin !== 'ranking');
    let worst = 0;
    let wide = false;
    for (const e of ev) {
      if (e.polarity !== 'adverse') continue;
      worst = Math.max(worst, e.cournotProbability);
      if (Math.abs(e.divergence ?? 0) >= 0.1) wide = true;
    }
    let m = Math.min(1, Math.max(CONFIG.minEventMultiplier, 1 - worst));
    if (wide) m *= 0.8;
    return Math.round(m * 1000) / 1000;
  }

  private emit(e: DeskEvent): void {
    this.s.events.push(e);
    if (this.s.events.length > 200) this.s.events.shift();
    this.emitEvent(e);
  }

  private price(sym: string): number {
    return this.s.snapshot!.marks[sym]!.cmcPrice;
  }

  private reprice(): void {
    const snap = this.s.snapshot!;
    const mult = this.s.eventMultiplier;
    for (const a of this.s.agents) {
      const pos = a.positions.reduce((t, p) => t + p.qty * this.price(p.symbol), 0);
      a.equityUsd = a.cashUsd + pos + (this.adj[a.agentId] ?? 0);
      a.peakEquityUsd = Math.max(a.peakEquityUsd, a.equityUsd);
      a.pnlUsd = a.equityUsd - a.startEquityUsd;
      a.pnlPct = (a.pnlUsd / a.startEquityUsd) * 100;
      a.drawdownPct = Math.max(0, ((a.peakEquityUsd - a.equityUsd) / a.peakEquityUsd) * 100);
      a.dailyLossPct = Math.max(0, ((a.dayStartEquityUsd - a.equityUsd) / a.dayStartEquityUsd) * 100);
      a.riskBudgetUsd = a.status === 'cut' ? 0 : (a.equityUsd * CONFIG.baseRiskBudgetPct) / 100 * mult;
    }
    snap.ts = Date.now();
    snap.fearGreed = Math.round(this.fg);
  }

  private gross(a: AgentAccount): number {
    return a.positions.reduce((t, p) => t + p.qty * this.price(p.symbol), 0);
  }

  private checks(o: Order, a: AgentAccount): RiskCheck[] {
    const snap = this.s.snapshot!;
    const inst = INSTS.find((i) => i.symbol === o.symbol)!;
    const mark = snap.marks[o.symbol]!;
    const liq = snap.liquidity[o.symbol]!;
    const cap = (liq.dexLiquidityUsd * CONFIG.maxOrderPctOfLiquidity) / 100;
    const pctLiq = (o.notionalUsd / liq.dexLiquidityUsd) * 100;
    const out: RiskCheck[] = [];
    out.push({
      name: 'agent-status', source: 'Desk', pass: a.status !== 'cut',
      detail: a.status !== 'cut' ? `${a.name} is ${a.status}.` : `${a.name} has been cut and cannot trade.`,
    });
    const liqOk = o.notionalUsd <= cap;
    out.push({
      name: 'liquidity', source: 'CoinMarketCap', pass: liqOk,
      detail: liqOk
        ? `Order ${usd0(o.notionalUsd)} is ${pctLiq.toFixed(2)}% of ${o.symbol} pool liquidity ${usd0(liq.dexLiquidityUsd)}; cap is ${CONFIG.maxOrderPctOfLiquidity}%.`
        : `Order ${usd0(o.notionalUsd)} is ${pctLiq.toFixed(0)}% of pool liquidity ${usd0(liq.dexLiquidityUsd)}; cap is ${CONFIG.maxOrderPctOfLiquidity}%.`,
    });
    let agreeOk = true;
    let agreeDetail = '';
    if (mark.agreement === 'both') agreeDetail = `CoinMarketCap and Atlas agree within ${mark.deviationBps?.toFixed(0) ?? '0'} bps.`;
    else if (mark.agreement === 'single') {
      agreeOk = inst.kind !== 'thin';
      agreeDetail = agreeOk
        ? `Only CoinMarketCap has a price for ${o.symbol} (single source); allowed for ${inst.kind} instruments.`
        : `Only CoinMarketCap has a price for ${o.symbol} (single source); not allowed for thin instruments.`;
    } else {
      agreeOk = false;
      agreeDetail = `CoinMarketCap and Atlas differ by ${mark.deviationBps?.toFixed(0) ?? '?'} bps; tolerance is ${CONFIG.priceToleranceBps} bps.`;
    }
    out.push({ name: 'price-agreement', source: 'Atlas', pass: agreeOk, detail: agreeDetail });
    const after = this.gross(a) + (o.side === 'buy' ? o.notionalUsd : -o.notionalUsd);
    const budget = a.riskBudgetUsd;
    const budgetOk = o.side === 'sell' || after <= budget;
    out.push({
      name: 'event-budget', source: 'Cournot', pass: budgetOk,
      detail: budgetOk
        ? `Exposure after order ${usd0(after)} is within the ${usd0(budget)} budget (risk budgets at ${Math.round(this.s.eventMultiplier * 100)}%).`
        : `Exposure after order ${usd0(after)} exceeds the ${usd0(budget)} budget (risk budgets at ${Math.round(this.s.eventMultiplier * 100)}%).`,
    });
    const cashOk = o.side === 'sell' || o.notionalUsd <= a.cashUsd;
    out.push({ name: 'exposure', source: 'Desk', pass: cashOk, detail: cashOk ? `Cash ${usd0(a.cashUsd)} covers the order.` : `Order ${usd0(o.notionalUsd)} is more than cash ${usd0(a.cashUsd)}; no leverage.` });
    const held = (a.positions.find((p) => p.symbol === o.symbol)?.qty ?? 0) * mark.cmcPrice;
    const symAfter = o.side === 'buy' ? held + o.notionalUsd : Math.max(0, held - o.notionalUsd);
    const conc = (symAfter / a.equityUsd) * 100;
    const concOk = o.side === 'sell' || conc <= CONFIG.maxConcentrationPct;
    out.push({ name: 'concentration', source: 'Desk', pass: concOk, detail: `${o.symbol} would be ${conc.toFixed(0)}% of equity; cap is ${CONFIG.maxConcentrationPct}%.` });
    return out;
  }

  private submit(a: AgentAccount, symbol: string, side: 'buy' | 'sell', notional: number, rationale: string): boolean {
    const o: Order = { id: `ord-${++this.orderSeq}`, agentId: a.agentId, symbol, side, notionalUsd: Math.round(notional), rationale, brain: a.agentId === 'event' ? 'llm' : 'rule', ts: Date.now() };
    if (o.brain === 'llm') this.llmCalls += 1;
    this.emit({ type: 'order', ts: o.ts, order: o });
    const checks = this.checks(o, a);
    const decision: RiskDecision = { orderId: o.id, approved: checks.every((c) => c.pass), checks };
    this.emit({ type: 'decision', ts: Date.now(), order: o, decision });
    if (!decision.approved) return false;
    const px = this.price(symbol);
    const qty = o.notionalUsd / px;
    const pos = a.positions.find((p) => p.symbol === symbol);
    if (side === 'buy') {
      a.cashUsd -= o.notionalUsd;
      if (pos) {
        pos.avgPrice = (pos.avgPrice * pos.qty + px * qty) / (pos.qty + qty);
        pos.qty += qty;
      } else a.positions.push({ symbol, qty, avgPrice: px });
    } else if (pos) {
      const q = (pos.qty - qty) * px < 1 ? pos.qty : Math.min(qty, pos.qty);
      pos.qty -= q;
      a.cashUsd += q * px;
      if (pos.qty < 1e-9) a.positions = a.positions.filter((p) => p !== pos);
    }
    this.emit({ type: 'fill', ts: Date.now(), fill: { orderId: o.id, agentId: a.agentId, symbol, side, qty, price: px, notionalUsd: o.notionalUsd, midPrice: px, slippagePct: (2 * o.notionalUsd) / this.s.snapshot!.liquidity[symbol]!.dexLiquidityUsd * 100, feePct: 0.25, ts: Date.now() } });
    return true;
  }

  private movePrices(): void {
    const snap = this.s.snapshot!;
    const tick = this.s.round.tick;
    const now = Date.now();
    for (const i of INSTS) {
      const m = snap.marks[i.symbol]!;
      const drift = i.kind === 'major' ? 0.0011 : 0.0005;
      const left = this.shockLeft[i.symbol] ?? 0;
      const base = m.cmcPrice * (1 + drift + (this.r() - 0.5) * 2 * i.vol);
      m.cmcPrice = base;
      m.cmcTs = now;
      const h = this.hist[i.symbol]!;
      h.push(base);
      const back = (n: number): number => h[Math.max(0, h.length - 1 - n)]!;
      m.pctChange1h = (base / back(5) - 1) * 100;
      m.pctChange24h = (base / h[0]! - 1) * 100 + (i.kind === 'major' ? 0.6 : 0.1);
      if (i.atlas) {
        let dev = (this.r() - 0.5) * 0.002;
        if (i.symbol === 'CAKE' && (tick === 9 || tick === 10)) dev = 0.0092;
        m.atlasPrice = base * (1 + dev);
        m.atlasTs = now - 4000;
        m.deviationBps = (Math.abs(base - m.atlasPrice) / base) * 10000;
        m.agreement = m.deviationBps <= CONFIG.priceToleranceBps ? 'both' : 'disagree';
        if (i.symbol === 'TSLAB' && (tick === 11 || tick === 12)) { m.atlasTs = now - 14 * 60000; m.atlasStale = true; m.agreement = 'single'; } else delete m.atlasStale;
      } else {
        delete m.atlasPrice; delete m.atlasTs; delete m.deviationBps;
        m.agreement = 'single';
      }
      if (left > 0) {
        this.shockLeft[i.symbol] = left - 1;
        m.synthetic = true;
        if (i.atlas) {
          // The stress test alters the CoinMarketCap mark only, so Atlas disagrees.
          m.deviationBps = (Math.abs(m.cmcPrice - m.atlasPrice!) / m.cmcPrice) * 10000;
          m.agreement = m.deviationBps <= CONFIG.priceToleranceBps ? 'both' : 'disagree';
        }
      } else delete m.synthetic;
    }
    this.fg = Math.max(5, Math.min(95, this.fg + (this.r() - 0.55) * 2));
  }

  private updateEvents(): void {
    const tick = this.s.round.tick;
    const ev = this.s.snapshot!.eventRisk.filter((e) => e.origin !== 'ranking');
    if (tick === 14) {
      const a = ev[0]!;
      a.cournotProbability = 0.49;
      a.venuePrice = 0.49;
      a.divergence = 0;
      a.live = true;
      a.fetchedAt = Date.now();
      a.requestId = 'mock-req-0004';
      a.sources = [
        { title: 'polymarket', url: 'https://example.com/markets/btc-55k', snippet: 'polymarket latest yes price for Bitcoin below $55,000 on Dec 31 is 0.49' },
        { title: 'kalshi', url: 'https://example.com/markets/btc-55k-kalshi', snippet: 'Year-end Bitcoin range contracts moved to 48 cents after the sell-off' },
        { title: 'deribit', url: 'https://example.com/options/btc', snippet: 'Put demand rose across December expiries' },
      ];
      this.fg = Math.min(this.fg, 29);
    }
    const m = this.multiplier();
    if (Math.abs(m - this.s.eventMultiplier) > 1e-6) {
      this.s.eventMultiplier = m;
      const top = [...ev].sort((x, y) => adverse(y) - adverse(x))[0]!;
      this.emit({
        type: 'budget', ts: Date.now(), multiplier: m,
        reason: `Cournot puts "${top.claim.replace(/\?$/, '')}" at ${Math.round(top.cournotProbability * 100)}%, so every risk budget is now ${Math.round(m * 100)}% of base.`,
      });
    }
  }

  private cut(a: AgentAccount, reason: string): void {
    a.positions = [];
    a.cashUsd = a.equityUsd - (this.adj[a.agentId] ?? 0);
    a.status = 'cut';
    a.cutReason = reason;
    a.rogue = false;
    this.emit({ type: 'cut', ts: Date.now(), agentId: a.agentId, reason });
    this.reallocate(`${a.name} cut, allocation returned to the desk`);
  }

  private reallocate(memo: string): void {
    const rs = this.s.railState;
    if (!rs) return;
    const next: Record<string, string> = { desk: '0', risk: '0.00' };
    let used = 0;
    for (const a of this.s.agents) {
      const alloc = a.status === 'funded' ? Math.max(0, a.equityUsd * (3 / 25000)) : 0;
      a.realAllocation = alloc.toFixed(3);
      next[a.agentId] = alloc.toFixed(3);
      used += alloc;
    }
    next.desk = n2(10 - used);
    for (const k of Object.keys(next)) next[k] = Number(next[k]).toFixed(3);
    this.receipt({ kind: 'reallocate', offchain: true, allocations: next, memo });
  }

  private receipt(p: { kind: RailReceipt['kind']; offchain: boolean; allocations: Record<string, string>; memo?: string; onchain?: boolean }): void {
    const rs = this.s.railState!;
    rs.version += 1;
    rs.allocations = p.allocations;
    if (p.kind === 'close') rs.status = 'closed';
    const tx = `0x${hex(this.r, 64)}` as Hex;
    const rc: RailReceipt = {
      kind: p.kind, rail: this.s.rail, sessionId: rs.sessionId, version: rs.version, offchain: false,
      txHash: tx, explorerUrl: `https://testnet.bscscan.com/tx/${tx}`,
      memo: p.memo, allocations: { ...p.allocations }, ts: Date.now(),
    };
    this.s.receipts.push(rc);
    this.s.receipts = this.s.receipts.slice(-200);
    this.pending += 1;
    setTimeout(() => { this.pending = Math.max(0, this.pending - 1); }, 1600 / this.speed);
    this.emit({ type: 'rail', ts: rc.ts, receipt: rc });
  }

  private trackAllocations(): void {
    let drift = false;
    for (const a of this.s.agents) {
      if (a.status !== 'funded') continue;
      if (Math.abs(a.equityUsd * (3 / 25000) - Number(a.realAllocation)) > 0.01) drift = true;
    }
    if (drift) this.reallocate('Allocation follows paper equity');
  }

  private brain(a: AgentAccount): void {
    const b = this.brains[a.agentId];
    const snap = this.s.snapshot!;
    const r = this.r();
    if (a.rogue) {
      b.rogueSteps += 1;
      const sizes = [25000, 40000, 65000];
      if (b.rogueSteps <= 3) {
        this.submit(a, 'MTHT', 'buy', sizes[b.rogueSteps - 1]!, b.rogueSteps === 1
          ? 'Putting the whole account into MTHT before the breakout.'
          : 'The last order was rejected, so I am sizing up and retrying.');
      } else {
        this.adj[a.agentId] = (this.adj[a.agentId] ?? 0) - a.startEquityUsd * 0.034;
        this.reprice();
      }
      return;
    }
    if (b.cool > 0) { b.cool -= 1; return; }
    const done = (ok: boolean): void => { if (!ok) b.cool = 3; };
    if (a.agentId === 'momentum') {
      let best: { s: string; h1: number; h24: number } | null = null;
      for (const s of ['BNB', 'BTCB', 'ETH', 'CAKE']) {
        const m = snap.marks[s]!;
        const h1 = m.pctChange1h ?? 0, h24 = m.pctChange24h ?? 0;
        if (h1 > 0 && h24 > 0 && (!best || h1 + h24 > best.h1 + best.h24)) best = { s, h1, h24 };
      }
      if (best && r < 0.8) {
        done(this.submit(a, best.s, 'buy', 3000 + this.r() * 2800, `${best.s} is up ${best.h1.toFixed(2)}% over 1h and ${best.h24.toFixed(2)}% over 24h; adding trend exposure.`));
      } else {
        const p = a.positions.find((q) => (snap.marks[q.symbol]!.pctChange1h ?? 0) < 0);
        if (p) done(this.submit(a, p.symbol, 'sell', (p.qty * this.price(p.symbol)) / 2, `${p.symbol} has turned down (${snap.marks[p.symbol]!.pctChange1h!.toFixed(2)}% over 1h); trimming half.`));
      }
    } else if (a.agentId === 'rwa') {
      const stress = this.fg < 45 || this.s.eventMultiplier < 0.7;
      if (stress && r < 0.85) {
        const rr = this.r();
        const sym = rr < 0.5 ? 'XAUT' : rr < 0.75 ? 'XAUM' : 'TSLAB';
        done(this.submit(a, sym, 'buy', 3200 + this.r() * 3200, `Fear and greed is ${Math.round(this.fg)} and event risk is ${this.s.eventMultiplier < 0.7 ? 'elevated' : 'moderate'}; rotating toward ${sym === 'TSLAB' ? 'tokenized Tesla stock' : 'tokenized gold'}.`));
      }
    } else if (a.agentId === 'event' && this.s.round.tick % 2 === 0) {
      const ev = snap.eventRisk.filter((e) => e.origin !== 'ranking');
      const lead = [...ev].sort((x, y) => adverse(y) - adverse(x))[0]!;
      const fav = snap.eventRisk.find((e) => e.origin === 'ranking' && e.polarity === 'favorable' && (e.divergence ?? 0) >= 0.05);
      if (adverse(lead) >= 0.45 && a.positions.length) {
        const p = a.positions[0]!;
        done(this.submit(a, p.symbol, 'sell', p.qty * this.price(p.symbol), `Cournot puts "${lead.claim.replace(/\?$/, '')}" at ${Math.round(adverse(lead) * 100)}%; cutting to cash.`));
      } else if (fav && adverse(lead) < 0.45) {
        done(this.submit(a, 'BNB', 'buy', 3200 + this.r() * 1500, `Cournot is ${Math.round((fav.divergence ?? 0) * 100)} points above the venue on a favorable claim; adding BNB.`));
      }
    }
  }

  step(): void {
    if (!this.s.running) return;
    const s = this.s;
    s.round.tick += 1;
    const tick = s.round.tick;
    this.movePrices();
    this.updateEvents();
    // scripted arc, so the whole story plays without a click
    if (tick === 20 && !this.s.agents.some((a) => a.rogue || a.status === 'cut')) this.control({ action: 'rogue', agentId: 'momentum' });
    this.emit({ type: 'tick', ts: Date.now(), tick });
    this.reprice();
    for (const a of s.agents) if (a.status !== 'cut') this.brain(a);
    this.reprice();
    for (const a of s.agents) {
      if (a.status === 'cut') continue;
      if (a.drawdownPct >= CONFIG.maxDrawdownPct) this.cut(a, `Max drawdown ${a.drawdownPct.toFixed(1)}% passed the ${CONFIG.maxDrawdownPct}% limit.`);
      else if (a.dailyLossPct >= CONFIG.dailyLossLimitPct) this.cut(a, `Daily loss ${a.dailyLossPct.toFixed(1)}% passed the ${CONFIG.dailyLossLimitPct}% limit.${a.rogue ? ' Rogue orders were blocked first.' : ''}`);
    }
    this.reprice();
    for (const a of s.agents) { if (a.status === 'evaluating' && tick >= CONFIG.evalTicks && a.pnlUsd < 0) a.evalNote = 'Evaluation ticks are done, but P&L is below zero. Waiting for it to recover.'; else delete a.evalNote; }
    if (s.round.phase === 'evaluation' && tick >= CONFIG.evalTicks) {
      let any = false;
      for (const a of s.agents) {
        if (a.status === 'evaluating' && a.pnlUsd >= 0) {
          a.status = 'funded';
          a.realAllocation = '3.00';
          any = true;
          this.emit({ type: 'funded', ts: Date.now(), agentId: a.agentId, realAllocation: '3.00' });
        }
      }
      if (any) {
        s.round.phase = 'funded';
        this.reallocate('Funded agents received their allocation');
      }
    } else if (s.round.phase === 'funded') {
      for (const a of s.agents) {
        if (a.status === 'evaluating' && a.pnlUsd >= 0 && tick >= CONFIG.evalTicks) {
          a.status = 'funded';
          this.emit({ type: 'funded', ts: Date.now(), agentId: a.agentId, realAllocation: '3.00' });
          this.reallocate(`${a.name} funded`);
        }
      }
      this.trackAllocations();
    }
    this.reprice();
    for (const a of s.agents) (a.equityHistory ??= []).push(a.equityUsd);
    if (tick === 30 && s.round.phase === 'funded') this.closeRound();
    this.emitState(this.snapshot());
  }

  private closeRound(): void {
    if (this.closing || !this.s.railState || this.s.round.phase === 'settled') return;
    this.closing = true;
    const s = this.s;
    this.reprice();
    const final: Record<string, string> = { risk: '0.00' };
    let paid = 0;
    for (const a of s.agents) {
      const realProfit = a.status === 'funded' ? a.equityUsd * (3 / 25000) - 3 : 0;
      const p = a.status === 'funded' && realProfit > 0 ? realProfit * CONFIG.profitSplitAgent : 0;
      final[a.agentId] = n2(p);
      paid += p;
    }
    final.desk = n2(10 - paid);
    for (const k of Object.keys(final)) final[k] = Number(final[k]).toFixed(3);
    for (const a of s.agents) a.realAllocation = final[a.agentId]!;
    s.running = false;
    s.round.phase = 'settled';
    this.receipt({ kind: 'close', offchain: false, allocations: final, memo: 'Round closed, one settlement', onchain: true });
    this.emitState(this.snapshot());
    setTimeout(() => {
      const hash = `0x${hex(this.r, 64)}` as Hex;
      const tx = { roundId: s.round.id, txHash: hash, explorerUrl: `https://testnet.bscscan.com/tx/${hash}`, chainId: 97 };
      s.scorecards.push(tx);
      this.emit({ type: 'scorecard', ts: Date.now(), tx });
      this.emitState(this.snapshot());
    }, 1800 / this.speed);
  }

  control(a: ControlAction): void {
    const s = this.s;
    switch (a.action) {
      case 'start':
        if (s.round.phase === 'idle') {
          s.round.phase = 'evaluation';
          s.round.startedAt = Date.now();
          s.railState = { sessionId: `mock-${hex(this.r, 8)}`, version: 0, asset: 'usdt', status: 'open', allocations: {} };
          this.links = ['DeskVault contract', 'Test token (tUSD)', 'Scorecard contract'].map((label) => { const h = `0x${hex(this.r, 64)}` as Hex; return { label, txHash: h, explorerUrl: `https://testnet.bscscan.com/tx/${h}` }; });
          this.receipt({ kind: 'open', offchain: false, onchain: true, memo: 'Pot deposited to the desk',
            allocations: { desk: '10.00', risk: '0.00', momentum: '0.00', rwa: '0.00', event: '0.00' } });
        }
        if (s.round.phase !== 'settled') s.running = true;
        break;
      case 'pause':
        s.running = false;
        break;
      case 'reset':
        this.init();
        break;
      case 'rogue': {
        const t = s.agents.find((x) => x.agentId === a.agentId);
        if (t && t.status !== 'cut') {
          t.rogue = true;
          this.brains[a.agentId].rogueSteps = 0;
          this.emit({ type: 'log', ts: Date.now(), level: 'warn', message: `${t.name} is now submitting oversized orders.` });
        }
        break;
      }
      case 'shock': {
        const m = s.snapshot!.marks[a.symbol];
        if (m) {
          m.cmcPrice *= 1 + a.pct / 100;
          this.hist[a.symbol]!.push(m.cmcPrice);
          this.shockLeft[a.symbol] = 4;
          m.synthetic = true;
          this.emit({ type: 'shock', ts: Date.now(), symbol: a.symbol, pct: a.pct });
          this.reprice();
        }
        break;
      }
      case 'close-round':
        if (s.round.phase !== 'idle') this.closeRound();
        break;
    }
    this.emitState(this.snapshot());
  }

  snapshot(): DeskState {
    const scale = 3 / 25000;
    const funded = this.s.agents.filter((a) => a.status === 'funded');
    const fundedAlloc = funded.reduce((t, a) => t + Number(a.realAllocation), 0);
    const paid = this.s.round.phase === 'settled' ? this.s.agents.reduce((t, a) => t + Number(a.realAllocation), 0) : 0;
    const lost = this.s.agents.filter((a) => a.status === 'cut').reduce((t, a) => t + Math.min(3, Math.max(0, (a.startEquityUsd - a.equityUsd) * scale)), 0);
    this.s.railPending = this.pending;
    this.s.onchainLinks = this.links;
    this.s.llm = { calls: this.llmCalls, cap: 150, active: true };
    this.s.economics = {
      fundedAllocations: fundedAlloc.toFixed(3),
      capitalAtRisk: (funded.length * 3 * (CONFIG.maxDrawdownPct / 100)).toFixed(3),
      paidToAgents: paid.toFixed(3),
      lossesAbsorbed: lost.toFixed(3),
    };
    return structuredClone(this.s);
  }

  start(): void {
    this.timer = setInterval(() => this.step(), CONFIG.tickMs / this.speed);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function adverse(e: EventRisk): number {
  return e.polarity === 'adverse' ? e.cournotProbability : 0;
}

export function createMockSource(speed = 1): DeskSource {
  return {
    label: 'in-browser mock',
    subscribe({ onState, onEvent }) {
      const sim = new Sim(speed, onState, onEvent);
      onState(sim.snapshot());
      sim.control({ action: 'start' });
      sim.start();
      activeSim = sim;
      return () => {
        sim.stop();
        if (activeSim === sim) activeSim = null;
      };
    },
    async control(a) {
      activeSim?.control(a);
    },
  };
}

let activeSim: Sim | null = null;
