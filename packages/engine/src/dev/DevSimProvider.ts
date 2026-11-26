// DEV ONLY. A seeded random-walk market used when DATA=dev or in tests.
// Nothing here is live data. Snapshots are labeled mode 'dev' and every event claim says "[dev sim]".
import type { DataProvider, EventRisk, Instrument, Liquidity, MarketSnapshot, PriceMark, Sym } from '../../../../shared/src/types.ts';
import { gauss, mulberry32 } from './prng.ts';

export const DEV_INSTRUMENTS: Instrument[] = [
  { symbol: 'BNB', name: 'BNB (dev sim)', cmcId: 1839, kind: 'major' },
  { symbol: 'ETH', name: 'Ethereum (dev sim)', cmcId: 1027, kind: 'major' },
  { symbol: 'BTCB', name: 'Bitcoin BEP2 (dev sim)', cmcId: 4023, kind: 'major' },
  { symbol: 'CAKE', name: 'PancakeSwap (dev sim)', cmcId: 7186, kind: 'major' },
  { symbol: 'PAXG', name: 'PAX Gold (dev sim)', cmcId: 4705, kind: 'rwa' },
  { symbol: 'USTB', name: 'Tokenized treasuries (dev sim)', cmcId: 0, kind: 'rwa' },
  { symbol: 'THIN', name: 'Thin token (dev sim)', cmcId: 0, kind: 'thin' },
];

/** Fixed seed prices. Used only by the dev simulation. */
const SEED_PRICES: Record<Sym, number> = {
  BNB: 900, ETH: 3500, BTCB: 95000, CAKE: 2.5, PAXG: 2650, USTB: 1.05, THIN: 0.042,
};
const SEED_LIQ: Record<Instrument['kind'], number> = { major: 40_000_000, rwa: 6_000_000, thin: 150_000 };
const VOL: Record<Instrument['kind'], number> = { major: 0.004, rwa: 0.0012, thin: 0.015 };

export interface DevSimOptions {
  seed?: number;
  instruments?: Instrument[];
  /** Ticks that stand in for one hour and one day of history when computing pct changes. */
  hourTicks?: number;
  dayTicks?: number;
  /** Probability per tick that an event probability jumps. */
  eventJumpProb?: number;
  now?: () => number;
}

interface SimEvent {
  claim: string;
  polarity: 'adverse' | 'favorable';
  p: number;
  divergence: number;
}

export class DevSimProvider implements DataProvider {
  readonly isDevSim = true;
  private rand: () => number;
  private insts: Instrument[];
  private history = new Map<Sym, number[]>();
  private trend = new Map<Sym, number>();
  private liq = new Map<Sym, number>();
  private fg = 50;
  private events: SimEvent[];
  private hourTicks: number;
  private dayTicks: number;
  private eventJumpProb: number;
  private now: () => number;
  private tick = 0;

  constructor(opts: DevSimOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 42);
    this.insts = opts.instruments ?? DEV_INSTRUMENTS;
    this.hourTicks = opts.hourTicks ?? 6;
    this.dayTicks = opts.dayTicks ?? 48;
    this.eventJumpProb = opts.eventJumpProb ?? 0.08;
    this.now = opts.now ?? Date.now;
    for (const i of this.insts) {
      const p0 = SEED_PRICES[i.symbol] ?? 1;
      // Pre-fill a day of history with a mild random walk so pct changes exist from tick one.
      const h: number[] = [];
      let p = p0 * (1 + gauss(this.rand) * 0.02);
      for (let k = 0; k < this.dayTicks; k++) {
        p *= 1 + gauss(this.rand) * VOL[i.kind] * 0.5;
        h.push(p);
      }
      h.push(p0);
      this.history.set(i.symbol, h);
      this.trend.set(i.symbol, (this.rand() - 0.4) * VOL[i.kind] * 0.5);
      this.liq.set(i.symbol, SEED_LIQ[i.kind] * (0.8 + this.rand() * 0.4));
    }
    this.events = [
      { claim: '[dev sim] The US Federal Reserve raises rates at its next meeting', polarity: 'adverse', p: 0.2, divergence: 0.02 },
      { claim: '[dev sim] A US spot BNB ETF is approved before the end of the year', polarity: 'favorable', p: 0.6, divergence: 0.06 },
    ];
  }

  instruments(): Instrument[] {
    return this.insts;
  }

  /** Test hook: set an event's probability and divergence directly. */
  setEvent(index: number, p: number, divergence?: number): void {
    const e = this.events[index];
    if (!e) return;
    e.p = Math.min(0.99, Math.max(0.01, p));
    if (divergence !== undefined) e.divergence = divergence;
  }

  /** Test hook: force the trend of one symbol (per-tick drift as a fraction). */
  setTrend(symbol: Sym, drift: number): void {
    this.trend.set(symbol, drift);
  }

  setFearGreed(v: number): void {
    this.fg = v;
  }

  async snapshot(): Promise<MarketSnapshot> {
    this.tick++;
    const ts = this.now();
    const marks: Record<Sym, PriceMark> = {};
    const liquidity: Record<Sym, Liquidity> = {};
    for (const i of this.insts) {
      const h = this.history.get(i.symbol)!;
      // Occasionally flip the trend so momentum has something to chase and to exit.
      if (this.rand() < 0.06) this.trend.set(i.symbol, (this.rand() - 0.45) * VOL[i.kind] * 0.8);
      const drift = this.trend.get(i.symbol)!;
      const last = h[h.length - 1];
      const p = last * (1 + drift + gauss(this.rand) * VOL[i.kind]);
      h.push(p);
      if (h.length > this.dayTicks + 1) h.shift();
      const hourAgo = h[Math.max(0, h.length - 1 - this.hourTicks)];
      const dayAgo = h[0];
      const devBps = Math.abs(gauss(this.rand)) * (i.kind === 'thin' ? 15 : 8);
      const disagree = i.kind === 'major' && this.rand() < 0.02;
      const hasAtlas = i.kind !== 'rwa' || i.symbol === 'PAXG';
      const atlasPrice = hasAtlas ? p * (1 + ((disagree ? 80 : devBps) / 10000) * (this.rand() < 0.5 ? -1 : 1)) : undefined;
      const deviationBps = atlasPrice !== undefined ? (Math.abs(p - atlasPrice) / p) * 10000 : undefined;
      marks[i.symbol] = {
        symbol: i.symbol,
        cmcPrice: p,
        cmcTs: ts,
        pctChange1h: ((p - hourAgo) / hourAgo) * 100,
        pctChange24h: ((p - dayAgo) / dayAgo) * 100,
        atlasPrice,
        atlasTs: atlasPrice !== undefined ? ts - 4000 : undefined,
        deviationBps,
        agreement: atlasPrice === undefined ? 'single' : deviationBps! > 50 ? 'disagree' : 'both',
      };
      const l = this.liq.get(i.symbol)! * (1 + gauss(this.rand) * 0.01);
      this.liq.set(i.symbol, l);
      liquidity[i.symbol] = {
        symbol: i.symbol,
        dexLiquidityUsd: l,
        dexVolume24hUsd: l * 0.6,
        source: 'Dev simulation (not CoinMarketCap)',
        ts,
      };
    }
    this.fg = Math.min(95, Math.max(5, this.fg + gauss(this.rand) * 3));
    for (const e of this.events) {
      if (this.rand() < this.eventJumpProb) {
        const step = (this.rand() < 0.5 ? -1 : 1) * (0.1 + Math.round(this.rand()) * 0.05);
        e.p = Math.min(0.9, Math.max(0.05, Math.round((e.p + step) * 20) / 20));
        e.divergence = Math.round((this.rand() - 0.5) * 0.3 * 100) / 100;
      }
    }
    const eventRisk: EventRisk[] = this.events.map((e, idx) => ({
      claim: e.claim,
      venue: 'dev sim',
      marketId: `dev-${idx}`,
      cournotProbability: e.p,
      venuePrice: Math.min(1, Math.max(0, e.p - e.divergence)),
      divergence: e.divergence,
      sources: [{ title: 'Dev simulation. Not a Cournot response.' }],
      cournotExplanation: 'Dev simulation value for local testing only.',
      fetchedAt: ts,
      live: false,
      polarity: e.polarity,
    }));
    return { ts, marks, liquidity, eventRisk, fearGreed: Math.round(this.fg), mode: 'dev' };
  }
}
